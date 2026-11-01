//! Trusted full-installer baseline, separate from signed engine-update receipts.
use crate::{Result, State, hash_file, hex, lock, read_state, save_state, unhex, version_dir};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Read,
    path::Path,
};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub format: u32,
    pub security_sequence: u64,
    pub engine_version: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub media_codecs: bool,
    pub files: BTreeMap<String, String>,
}

fn read(path: &Path) -> Result<(Policy, String)> {
    let mut bytes = Vec::new();
    File::open(path)?.take(4097).read_to_end(&mut bytes)?;
    if bytes.len() > 4096 {
        return Err("Installer seed policy too large".into());
    }
    let policy: Policy = serde_json::from_slice(&bytes)?;
    if policy.format != 1
        || policy.security_sequence == 0
        || policy.engine_version.is_empty()
        || policy.engine_version.len() > 128
        || policy.files.len() != 4
    {
        return Err("Invalid installer seed policy".into());
    }
    for name in [
        "chrominimum.exe",
        "chrominimum.dll",
        "libcef.dll",
        "chrome_elf.dll",
    ] {
        unhex::<32>(policy.files.get(name).ok_or("Missing seed policy file")?)?;
    }
    Ok((
        policy,
        hex(ring::digest::digest(&ring::digest::SHA256, &bytes).as_ref()),
    ))
}

pub fn effective_sequence(root: &Path, state: &State, selected: u64) -> Result<u64> {
    if selected != 0 || state.seed_policy_sha256.is_none() {
        return Ok(selected);
    }
    let seed = version_dir(root, 0);
    let (policy, identity) = read(&seed.join("installer-seed.json"))?;
    if Some(&identity) != state.seed_policy_sha256.as_ref()
        || hash_file(&seed.join("chrominimum.dll"))?.1 != policy.files["chrominimum.dll"]
    {
        return Err(
            "Installer baseline identity changed; rerun a compatible full installer".into(),
        );
    }
    Ok(policy.security_sequence)
}

pub fn requires_media(root: &Path, state: &State) -> Result<bool> {
    let Some(expected) = state.seed_policy_sha256.as_ref() else {
        if state.media_codecs_required {
            return Err("Media installation lacks its baseline identity".into());
        }
        return Ok(false);
    };
    let (policy, identity) = read(&version_dir(root, 0).join("installer-seed.json"))?;
    if &identity != expected || (state.media_codecs_required && !policy.media_codecs) {
        return Err("Installer baseline identity changed".into());
    }
    Ok(policy.media_codecs)
}

fn idle_runtimes(root: &Path) -> Result<Vec<File>> {
    let mut guards = Vec::new();
    let core = root.join("core");
    if !core.exists() {
        return Ok(guards);
    }
    for entry in fs::read_dir(core)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name != "seed"
            && !name
                .strip_prefix('v')
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        {
            continue;
        }
        if !entry.file_type()?.is_dir() {
            return Err("Unexpected runtime entry".into());
        }
        let guard = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(entry.path().join("core-running.lock"))?;
        guard
            .try_lock()
            .map_err(|_| "Close ChroMinimum before installing")?;
        guards.push(guard);
    }
    Ok(guards)
}

/// Called with the new installer's policy before replacing files. No state writes.
pub fn preflight(root: &Path, policy_path: &Path) -> Result<()> {
    let (policy, _) = read(policy_path)?;
    if !root.exists() {
        return Ok(());
    }
    let _lock = lock(root)?;
    let state = read_state(root)?;
    if state.media_codecs_required && !policy.media_codecs {
        return Err("Installer would remove required H.264/AAC support".into());
    }
    if policy.security_sequence < state.min_safe {
        return Err("Installer baseline is below the security floor".into());
    }
    let _leases = idle_runtimes(root)?;
    Ok(())
}

/// Full hashing happens only at installation, not at each browser startup.
pub fn migrate(root: &Path) -> Result<()> {
    let _lock = lock(root)?;
    let mut state = read_state(root)?;
    let seed = version_dir(root, 0);
    let (policy, identity) = read(&seed.join("installer-seed.json"))?;
    // Keep the requirement in state as well: an interrupted full install may
    // already have replaced the seed policy before its state commit.
    if state.media_codecs_required && !policy.media_codecs {
        return Err("Installer would remove required H.264/AAC support".into());
    }
    if policy.security_sequence < state.min_safe {
        return Err("Installer baseline is below the security floor".into());
    }
    let _leases = idle_runtimes(root)?;
    for (name, expected) in &policy.files {
        if hash_file(&seed.join(name))?.1 != *expected {
            return Err(format!("Installer seed integrity failed: {name}").into());
        }
    }
    state.active = 0;
    state.pending = None;
    state.attempted = false;
    state.highest = state.highest.max(policy.security_sequence);
    state.min_safe = state.min_safe.max(policy.security_sequence);
    state.seed_policy_sha256 = Some(identity);
    state.media_codecs_required |= policy.media_codecs;
    save_state(root, &state)
}
