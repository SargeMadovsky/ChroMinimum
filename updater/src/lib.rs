//! Signed, bounded, side-by-side core installation. No CEF dependency.
use ring::{digest, signature};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
pub const CHANNEL: &str = "https://github.com/SargeMadovsky/ChroMinimum/releases/download/core-windows-x64/core-update.json";
pub const MAX_MANIFEST: u64 = 16 * 1024;
const MAX_PACKAGE: u64 = 512 * 1024 * 1024;
const MAX_EXPANDED: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub format: u32,
    pub sequence: u64,
    pub min_safe_sequence: u64,
    pub platform: String,
    pub launcher_api: u32,
    pub shell_version: String,
    pub engine_version: String,
    pub issued: u64,
    pub expires: u64,
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub payload: String,
    pub signature: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub active: u64,
    pub pending: Option<u64>,
    pub attempted: bool,
    pub highest: u64,
    pub min_safe: u64,
}

pub fn now() -> Result<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
}
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn unhex<const N: usize>(text: &str) -> Result<[u8; N]> {
    if text.len() != N * 2 || !text.is_ascii() {
        return Err("Invalid hex length".into());
    }
    let mut bytes = [0; N];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16)?;
    }
    Ok(bytes)
}

pub fn verify(bytes: &[u8], key: &[u8; 32], timestamp: u64, highest: u64) -> Result<Manifest> {
    if bytes.len() as u64 > MAX_MANIFEST {
        return Err("Manifest too large".into());
    }
    let envelope: Envelope = serde_json::from_slice(bytes)?;
    let sig = unhex::<64>(&envelope.signature)?;
    signature::UnparsedPublicKey::new(&signature::ED25519, key)
        .verify(envelope.payload.as_bytes(), &sig)
        .map_err(|_| "Update signature invalid")?;
    let m: Manifest = serde_json::from_str(&envelope.payload)?;
    if m.format != 1 || m.launcher_api != 1 || m.platform != "windows-x64" {
        return Err("Incompatible update".into());
    }
    if m.sequence == 0 || m.sequence < highest || m.min_safe_sequence > m.sequence {
        return Err("Update rollback rejected".into());
    }
    if m.issued > timestamp.saturating_add(300)
        || m.expires <= timestamp
        || m.expires <= m.issued
        || m.expires - m.issued > 45 * 86400
    {
        return Err("Update metadata expired or system clock incorrect".into());
    }
    if m.size == 0 || m.size > MAX_PACKAGE {
        return Err("Package size out of range".into());
    }
    unhex::<32>(&m.sha256)?;
    if !m
        .url
        .starts_with("https://github.com/SargeMadovsky/ChroMinimum/releases/download/")
        || m.url.contains(['?', '#', '\\', '\r', '\n'])
    {
        return Err("Update source not permitted".into());
    }
    Ok(m)
}

pub fn read_state(root: &Path) -> Result<State> {
    match fs::read(root.join("core-state.json")) {
        Ok(bytes) if bytes.len() <= 4096 => {
            let state: State = serde_json::from_slice(&bytes)?;
            if state.active > state.highest
                || state.min_safe > state.highest
                || state.pending.is_some_and(|p| p == 0 || p > state.highest)
            {
                return Err("Inconsistent core state".into());
            }
            Ok(state)
        }
        Ok(_) => Err("State too large".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
        Err(e) => Err(e.into()),
    }
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let temporary = path.with_extension("new");
    let mut out = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)?;
    out.write_all(bytes)?;
    out.sync_all()?;
    drop(out);
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let from: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                0x1 | 0x8,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(not(windows))]
    fs::rename(temporary, path)?;
    Ok(())
}
pub fn save_state(root: &Path, state: &State) -> Result<()> {
    atomic_write(&root.join("core-state.json"), &serde_json::to_vec(state)?)
}
pub fn lock(root: &Path) -> Result<File> {
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("core-update.lock"))?;
    lock.try_lock()
        .map_err(|_| "Another core operation is running")?;
    Ok(lock)
}
pub fn version_dir(root: &Path, sequence: u64) -> PathBuf {
    root.join("core").join(if sequence == 0 {
        "seed".to_owned()
    } else {
        format!("v{sequence}")
    })
}

fn safe_path(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty() || path.as_os_str().len() > 240 || path.components().count() > 16
    {
        return Err("Empty archive path".into());
    }
    for part in path.components() {
        let Component::Normal(name) = part else {
            return Err("Archive path traversal".into());
        };
        let name = name.to_str().ok_or("Invalid filename")?;
        let base = name.split('.').next().unwrap_or("").to_ascii_uppercase();
        if name.contains([':', '\\'])
            || name.ends_with(['.', ' '])
            || name.chars().any(|c| c.is_control())
            || ["CON", "PRN", "AUX", "NUL"].contains(&base.as_str())
            || (base.len() == 4
                && (base.starts_with("COM") || base.starts_with("LPT"))
                && base.as_bytes()[3].is_ascii_digit())
        {
            return Err("Unsafe Windows filename".into());
        }
    }
    Ok(())
}

pub fn unpack(archive: &Path, staging: &Path) -> Result<()> {
    // staging must be newly created, never a running version or existing tree.
    fs::create_dir(staging)?;
    let decoded = flate2::read::GzDecoder::new(File::open(archive)?);
    let mut tar = tar::Archive::new(decoded);
    let mut total = 0_u64;
    let mut count = 0_u32;
    for entry in tar.entries()? {
        let mut entry = entry?;
        count += 1;
        if count > 4096 {
            return Err("Too many archive entries".into());
        }
        let path = entry.path()?.into_owned();
        safe_path(&path)?;
        let kind = entry.header().entry_type();
        if !kind.is_file() {
            return Err("Only regular files are allowed in core packages".into());
        }
        total = total.checked_add(entry.size()).ok_or("Archive overflow")?;
        if total > MAX_EXPANDED {
            return Err("Expanded archive too large".into());
        }
        let target = staging.join(path);
        fs::create_dir_all(target.parent().ok_or("No parent")?)?;
        let mut out = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(target)?;
        std::io::copy(&mut entry, &mut out)?;
        out.sync_all()?;
    }
    for required in [
        "chrominimum.exe",
        "chrominimum.dll",
        "chrome_elf.dll",
        "libcef.dll",
        "CREDITS.html",
        "LICENSES-RUST.html",
    ] {
        if !staging.join(required).is_file() {
            return Err(format!("Core is incomplete: {required}").into());
        }
    }
    Ok(())
}

pub fn hash_file(path: &Path) -> Result<(u64, String)> {
    hash_reader(File::open(path)?)
}

fn hash_reader(mut input: impl Read) -> Result<(u64, String)> {
    let mut hash = digest::Context::new(&digest::SHA256);
    let mut buffer = [0_u8; 64 * 1024];
    let mut length = 0;
    loop {
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
        length += n as u64;
    }
    Ok((length, hex(hash.finish().as_ref())))
}

fn verify_existing(package: &Path, directory: &Path, envelope: &[u8]) -> Result<()> {
    if fs::read(directory.join("core-update.json"))? != envelope {
        return Err("Existing core receipt differs".into());
    }
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(File::open(package)?));
    let mut allowed = std::collections::BTreeSet::new();
    let mut total = 0_u64;
    for entry in tar.entries()? {
        let mut entry = entry?;
        let relative = entry.path()?.into_owned();
        safe_path(&relative)?;
        total = total.checked_add(entry.size()).ok_or("Archive overflow")?;
        if !entry.header().entry_type().is_file()
            || total > MAX_EXPANDED
            || allowed.len() >= 4096
            || !allowed.insert(relative.clone())
        {
            return Err("Invalid recovery archive".into());
        }
        if hash_reader(&mut entry)? != hash_file(&directory.join(relative))? {
            return Err("Existing core files differ".into());
        }
    }
    allowed.insert(PathBuf::from("core-update.json"));
    allowed.insert(PathBuf::from("core-running.lock"));
    let mut dirs = vec![directory.to_owned()];
    let mut visited = 0;
    while let Some(dir) = dirs.pop() {
        for file in fs::read_dir(dir)? {
            let file = file?;
            visited += 1;
            if visited > 8192 {
                return Err("Too many recovery entries".into());
            }
            let kind = file.file_type()?;
            if kind.is_dir() {
                dirs.push(file.path());
            } else if !kind.is_file() || !allowed.contains(file.path().strip_prefix(directory)?) {
                return Err("Unknown files in existing core; refusing replacement".into());
            }
        }
    }
    Ok(())
}

pub fn install(
    root: &Path,
    envelope: &[u8],
    package: &Path,
    key: &[u8; 32],
    timestamp: u64,
) -> Result<Manifest> {
    let _lock = lock(root)?;
    let mut state = read_state(root)?;
    let m = verify(envelope, key, timestamp, state.highest)?;
    if m.sequence <= state.highest {
        return Err("This sequence was already seen".into());
    }
    if state.pending.is_some() {
        return Err("Restart to confirm the already staged core first".into());
    }
    if hash_file(package)? != (m.size, m.sha256.clone()) {
        return Err("Package integrity check failed".into());
    }
    let core = root.join("core");
    fs::create_dir_all(&core)?;
    let destination = version_dir(root, m.sequence);
    if destination.exists() {
        // Recover a crash after directory publication but before state commit.
        verify_existing(package, &destination, envelope)?;
    } else {
        let mut nonce = [0; 16];
        ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut nonce)
            .map_err(|_| "Random source unavailable")?;
        let staging = core.join(format!("staging-{}-{}", m.sequence, hex(&nonce)));
        if let Err(error) = unpack(package, &staging) {
            // Only our newly created, resolved direct child can be removed.
            if staging
                .canonicalize()
                .ok()
                .is_some_and(|p| p.parent() == core.canonicalize().ok().as_deref())
            {
                let _ = fs::remove_dir_all(&staging);
            }
            return Err(error);
        }
        // Receipt binds the installed directory to authenticated release metadata.
        fs::write(staging.join("core-update.json"), envelope)?;
        OpenOptions::new()
            .write(true)
            .open(staging.join("core-update.json"))?
            .sync_all()?;
        fs::rename(&staging, &destination)?;
    }
    state.highest = m.sequence;
    state.min_safe = state.min_safe.max(m.min_safe_sequence);
    state.pending = Some(m.sequence);
    state.attempted = false;
    save_state(root, &state)?;
    Ok(m)
}

pub fn select(root: &Path, key: &[u8; 32]) -> Result<u64> {
    let _lock = lock(root)?;
    select_locked(root, key)
}

/// Caller holds the installation lock through selection and lease acquisition.
pub fn select_locked(root: &Path, key: &[u8; 32]) -> Result<u64> {
    let mut state = read_state(root)?;
    if let Some(candidate) = state.pending {
        let receipt = fs::read(version_dir(root, candidate).join("core-update.json"))?;
        // Installed receipt authenticates identity. Expiry governs new downloads,
        // not the ability to start an already authenticated local installation.
        let env: Envelope = serde_json::from_slice(&receipt)?;
        let parsed: Manifest = serde_json::from_str(&env.payload)?;
        let verified = verify(&receipt, key, parsed.issued, state.highest)?;
        if verified.sequence != candidate {
            return Err("Installed identity mismatch".into());
        }
        if state.attempted {
            if fs::read_to_string(root.join("core-health")).ok().as_deref()
                == Some(&candidate.to_string())
            {
                state.active = candidate;
                state.pending = None;
            } else {
                state.pending = None;
                if state.active < state.min_safe {
                    return Err("New core failed; fallback is below the security floor".into());
                }
            }
        } else {
            let _ = fs::remove_file(root.join("core-health"));
            state.attempted = true;
        }
        save_state(root, &state)?;
    }
    let selected = state.pending.unwrap_or(state.active);
    if selected < state.min_safe {
        return Err("Installed core is below the security floor".into());
    }
    if selected > 0 {
        let bytes = fs::read(version_dir(root, selected).join("core-update.json"))?;
        let envelope: Envelope = serde_json::from_slice(&bytes)?;
        let m: Manifest = serde_json::from_str(&envelope.payload)?;
        if verify(&bytes, key, m.issued, 0)?.sequence != selected {
            return Err("Active core identity mismatch".into());
        }
    }
    Ok(selected)
}

pub fn lease(directory: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("core-running.lock"))?;
    file.try_lock_shared()?;
    Ok(file)
}

/// Only authenticated old runtime directories; never profiles or a leased core.
pub fn prune(root: &Path, key: &[u8; 32]) -> Result<()> {
    let _guard = lock(root)?;
    let state = read_state(root)?;
    let core = root.join("core").canonicalize()?;
    for entry in fs::read_dir(&core)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(sequence) = name.strip_prefix('v').and_then(|v| v.parse::<u64>().ok()) else {
            continue;
        };
        if sequence == state.active || Some(sequence) == state.pending {
            continue;
        }
        if !entry.file_type()?.is_dir()
            || entry.path().canonicalize()?.parent() != Some(core.as_path())
        {
            continue;
        }
        let Ok(receipt) = fs::read(entry.path().join("core-update.json")) else {
            continue;
        };
        let Ok(envelope) = serde_json::from_slice::<Envelope>(&receipt) else {
            continue;
        };
        let Ok(m) = serde_json::from_str::<Manifest>(&envelope.payload) else {
            continue;
        };
        if verify(&receipt, key, m.issued, 0)
            .ok()
            .is_none_or(|m| m.sequence != sequence)
        {
            continue;
        }
        let running = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(entry.path().join("core-running.lock"))?;
        if running.try_lock().is_err() {
            continue;
        }
        // Startup takes the installation lock before acquiring a runtime lease.
        // With this root lock held, no new launcher can race deletion.
        drop(running);
        let _ = fs::remove_dir_all(entry.path());
    }
    Ok(())
}
