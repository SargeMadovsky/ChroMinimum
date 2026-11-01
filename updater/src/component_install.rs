//! Local modular transactions. Separate from legacy core-state and launcher selection.
use crate::{
    Result, atomic_write, catalog,
    components::{InstallConfig, Locale},
    hash_file, hex, lock, unhex,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct State {
    active: Option<String>,
    pending: Option<Trial>,
    highest: u64,
    min_safe: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Trial {
    id: String,
    attempted: bool,
    token: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    catalog: String,
    config: InstallConfig,
}
#[derive(Debug, Serialize)]
pub struct Selection {
    pub id: String,
    pub sequence: u64,
    pub ui_locale: Locale,
    pub trial_token: Option<String>,
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err("Component metadata too large".into());
    }
    Ok(bytes)
}
fn read_state(root: &Path) -> Result<State> {
    crate::packages::plain_path(&std::path::absolute(root)?)?;
    let path = root.join("component-state.json");
    if fs::symlink_metadata(&path).is_ok() {
        crate::packages::plain_path(&std::path::absolute(&path)?)?;
    }
    let state: State = match read_bounded(&path, 4096) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
        {
            State::default()
        }
        Err(error) => return Err(error),
    };
    if state.min_safe > state.highest {
        return Err("Invalid component security floor".into());
    }
    for id in state
        .active
        .iter()
        .chain(state.pending.iter().map(|t| &t.id))
    {
        unhex::<32>(id)?;
    }
    if let Some(trial) = &state.pending {
        unhex::<16>(&trial.token)?;
    }
    Ok(state)
}
fn guard(root: &Path) -> Result<fs::File> {
    crate::packages::plain_path(&std::path::absolute(root)?)?;
    let path = root.join("core-update.lock");
    if fs::symlink_metadata(&path).is_ok() {
        crate::packages::plain_path(&std::path::absolute(&path)?)?;
    }
    lock(root)
}
fn save(root: &Path, state: &State) -> Result<()> {
    atomic_write(
        &root.join("component-state.json"),
        &serde_json::to_vec(state)?,
    )
}
fn nonce() -> Result<String> {
    let mut bytes = [0; 16];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes)
        .map_err(|_| "Random source unavailable")?;
    Ok(hex(&bytes))
}
fn directory(root: &Path, id: &str) -> Result<PathBuf> {
    unhex::<32>(id)?;
    Ok(root.join("component-core").join(id))
}
fn identity(bytes: &[u8]) -> String {
    hex(ring::digest::digest(&ring::digest::SHA256, bytes).as_ref())
}

fn installed(root: &Path, id: &str, key: &[u8; 32], state: &State) -> Result<Selection> {
    let path = directory(root, id)?.join("component-receipt.json");
    crate::packages::plain_path(&std::path::absolute(&path)?)?;
    let bytes = read_bounded(&path, 96 * 1024)?;
    if identity(&bytes) != id {
        return Err("Component receipt identity mismatch".into());
    }
    let receipt: Receipt = serde_json::from_slice(&bytes)?;
    let envelope: crate::Envelope = serde_json::from_str(&receipt.catalog)?;
    let payload: catalog::Catalog = serde_json::from_str(&envelope.payload)?;
    // Expiry gates new preparation, not startup of an already authenticated copy.
    let verified = catalog::verify(receipt.catalog.as_bytes(), key, payload.issued, 0, 0)?;
    let plan = verified.plan(&receipt.config)?;
    if plan.sequence < state.min_safe || plan.sequence > state.highest {
        return Err("Installed component release is outside security bounds".into());
    }
    Ok(Selection {
        id: id.to_owned(),
        sequence: plan.sequence,
        ui_locale: plan.ui_locale,
        trial_token: None,
    })
}

fn files(root: &Path) -> Result<BTreeMap<PathBuf, (u64, String)>> {
    crate::packages::plain_path(&std::path::absolute(root)?)?;
    let mut result = BTreeMap::new();
    fn visit(
        base: &Path,
        path: &Path,
        result: &mut BTreeMap<PathBuf, (u64, String)>,
        count: &mut u32,
        size: &mut u64,
    ) -> Result<()> {
        if path.strip_prefix(base)?.components().count() > 16 {
            return Err("Component copy too deep".into());
        }
        for entry in fs::read_dir(path)? {
            *count += 1;
            if *count > 4096 {
                return Err("Too many installed entries".into());
            }
            let entry = entry?;
            let metadata = fs::symlink_metadata(entry.path())?;
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return Err("Reparse component copy".into());
                }
            }
            if metadata.file_type().is_symlink() {
                return Err("Symlink component copy".into());
            }
            if metadata.is_dir() {
                result.insert(
                    entry.path().strip_prefix(base)?.to_owned(),
                    (0, "directory".into()),
                );
                visit(base, &entry.path(), result, count, size)?;
            } else if metadata.is_file() {
                if entry.path().strip_prefix(base)? == Path::new("core-running.lock")
                    && metadata.len() == 0
                {
                    continue;
                }
                *size = size
                    .checked_add(metadata.len())
                    .ok_or("Component copy size overflow")?;
                if *size > 2 * 1024 * 1024 * 1024 + 96 * 1024 {
                    return Err("Component copy too large".into());
                }
                result.insert(
                    entry.path().strip_prefix(base)?.to_owned(),
                    hash_file(&entry.path())?,
                );
            } else {
                return Err("Non-file in component copy".into());
            }
            if result.len() > 4096 {
                return Err("Too many installed files".into());
            }
        }
        Ok(())
    }
    visit(root, root, &mut result, &mut 0, &mut 0)?;
    Ok(result)
}

/// The caller supplies an existing private installation root.
pub fn download_and_prepare(
    root: &Path,
    signed_catalog: &[u8],
    config: &InstallConfig,
    cache: &Path,
    key: &[u8; 32],
) -> Result<String> {
    let (highest, min_safe) = {
        let _guard = guard(root)?;
        let state = read_state(root)?;
        if state.pending.is_some() {
            return Err("Confirm or recover the pending component trial first".into());
        }
        (state.highest, state.min_safe)
    };
    let verified = catalog::verify(signed_catalog, key, crate::now()?, highest, min_safe)?;
    verified.download(config, cache)?;
    // Revalidate expiry and state after network I/O, under the preparation lock.
    prepare(root, signed_catalog, config, cache, key, crate::now()?)
}

/// The caller supplies an existing private installation root.
pub fn prepare(
    root: &Path,
    signed_catalog: &[u8],
    config: &InstallConfig,
    archives: &Path,
    key: &[u8; 32],
    timestamp: u64,
) -> Result<String> {
    let _guard = guard(root)?;
    crate::packages::plain_path(&std::path::absolute(root)?)?;
    let mut state = read_state(root)?;
    if state.pending.is_some() {
        return Err("Confirm or recover the pending component trial first".into());
    }
    let verified = catalog::verify(
        signed_catalog,
        key,
        timestamp,
        state.highest,
        state.min_safe,
    )?;
    let plan = verified.plan(config)?;
    let receipt = Receipt {
        catalog: std::str::from_utf8(signed_catalog)?.to_owned(),
        config: InstallConfig::parse(&serde_json::to_vec(config)?)?,
    };
    let receipt_bytes = serde_json::to_vec(&receipt)?;
    let id = identity(&receipt_bytes);
    if state.active.as_deref() == Some(&id) {
        return Err("This component selection is already active".into());
    }
    let parent = root.join("component-core");
    fs::create_dir_all(&parent)?;
    crate::packages::plain_path(&std::path::absolute(&parent)?)?;
    let staging = parent.join(format!("staging-{}", nonce()?));
    verified.stage_local(config, archives, &staging)?;
    atomic_write(&staging.join("component-receipt.json"), &receipt_bytes)?;
    let destination = directory(root, &id)?;
    if destination.exists() {
        // Recover publication before state commit only after full byte comparison.
        if files(&destination)? != files(&staging)? {
            return Err("Existing component copy differs".into());
        }
        if staging.canonicalize()?.parent() != Some(parent.canonicalize()?.as_path()) {
            return Err("Unexpected component staging location".into());
        }
        fs::remove_dir_all(&staging)?;
    } else {
        fs::rename(&staging, &destination)?;
    }
    state.highest = state.highest.max(plan.sequence);
    state.min_safe = state.min_safe.max(plan.min_safe_sequence);
    state.pending = Some(Trial {
        id: id.clone(),
        attempted: false,
        token: nonce()?,
    });
    save(root, &state)?;
    Ok(id)
}

pub fn select(root: &Path, key: &[u8; 32]) -> Result<Selection> {
    let _guard = guard(root)?;
    select_locked(root, key)
}

pub fn select_for_launch(root: &Path, key: &[u8; 32]) -> Result<(Selection, fs::File, PathBuf)> {
    let _guard = guard(root)?;
    let selection = select_locked(root, key)?;
    let runtime = directory(root, &selection.id)?;
    let lease = crate::lease(&runtime)?;
    Ok((selection, lease, runtime))
}

fn select_locked(root: &Path, key: &[u8; 32]) -> Result<Selection> {
    let mut state = read_state(root)?;
    if let Some(trial) = &state.pending {
        let mut selection = installed(root, &trial.id, key, &state)?;
        if !trial.attempted {
            selection.trial_token = Some(trial.token.clone());
            state.pending.as_mut().unwrap().attempted = true;
            save(root, &state)?;
            return Ok(selection);
        }
        let lease_path = directory(root, &trial.id)?.join("core-running.lock");
        if fs::symlink_metadata(&lease_path).is_ok() {
            crate::packages::plain_path(&std::path::absolute(&lease_path)?)?;
            let lease = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&lease_path)?;
            if lease.try_lock().is_err() {
                return Err("Pending component browser is still running".into());
            }
        }
        // A prior selection was not confirmed. Retain the security floor on rollback.
        state.pending = None;
        save(root, &state)?;
    }
    installed(
        root,
        state
            .active
            .as_deref()
            .ok_or("No confirmed component installation")?,
        key,
        &state,
    )
}

pub fn confirm(root: &Path, id: &str, token: &str, key: &[u8; 32]) -> Result<()> {
    let _guard = guard(root)?;
    let mut state = read_state(root)?;
    let trial = state.pending.as_ref().ok_or("No pending component trial")?;
    if !trial.attempted || trial.id != id || trial.token != token {
        return Err("Component trial confirmation mismatch".into());
    }
    installed(root, id, key, &state)?;
    state.active = Some(id.to_owned());
    state.pending = None;
    save(root, &state)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn corrupt_state_and_concurrent_operation_never_reset_selection() {
        let root = std::env::temp_dir().join(format!("cm-component-state-{}", nonce().unwrap()));
        fs::create_dir(&root).unwrap();
        let path = root.join("component-state.json");
        fs::write(&path, b"corrupt state").unwrap();
        assert!(select(&root, &[0; 32]).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"corrupt state");
        let held = guard(&root).unwrap();
        assert!(select(&root, &[0; 32]).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"corrupt state");
        drop(held);
        fs::remove_file(path).unwrap();
        fs::remove_file(root.join("core-update.lock")).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
