use cm_update::*;
use ring::signature::{Ed25519KeyPair, KeyPair};
use std::{
    fs,
    path::{Path, PathBuf},
};

fn key() -> Ed25519KeyPair {
    let secret = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap();
    Ed25519KeyPair::from_pkcs8(secret.as_ref()).unwrap()
}
fn manifest() -> Manifest {
    Manifest {
        format: 1,
        sequence: 1,
        min_safe_sequence: 0,
        platform: "windows-x64".into(),
        launcher_api: 1,
        shell_version: "0.0.1".into(),
        engine_version: "154.0.34".into(),
        issued: 1000,
        expires: 2000,
        url: "https://github.com/SargeMadovsky/ChroMinimum/releases/download/test/core.tar.gz"
            .into(),
        size: 1,
        sha256: "00".repeat(32),
    }
}
fn signed(m: &Manifest, key: &Ed25519KeyPair) -> Vec<u8> {
    let payload = serde_json::to_string(m).unwrap();
    serde_json::to_vec(&Envelope {
        signature: hex(key.sign(payload.as_bytes()).as_ref()),
        payload,
    })
    .unwrap()
}
fn public(key: &Ed25519KeyPair) -> [u8; 32] {
    key.public_key().as_ref().try_into().unwrap()
}
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let mut random = [0; 16];
        ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut random).unwrap();
        let dir = std::env::temp_dir().join(format!("cm-update-test-{}", hex(&random)));
        fs::create_dir(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        if self.0.canonicalize().ok().is_some_and(|p| {
            p.parent() == std::env::temp_dir().canonicalize().ok().as_deref()
                && p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with("cm-update-test-"))
        }) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

#[test]
fn leased_old_core_is_not_pruned_and_profiles_are_untouched() {
    let temp = Temp::new();
    let key = key();
    let package = temp.0.join("package.tar.gz");
    archive(&package, false);
    fs::create_dir(temp.0.join("profile")).unwrap();
    fs::write(temp.0.join("profile/fixture"), b"test-data").unwrap();
    for sequence in [1, 2] {
        let mut m = manifest();
        (m.size, m.sha256) = hash_file(&package).unwrap();
        m.sequence = sequence;
        install(&temp.0, &signed(&m, &key), &package, &public(&key), 1500).unwrap();
        select(&temp.0, &public(&key)).unwrap();
        fs::write(temp.0.join("core-health"), sequence.to_string()).unwrap();
        select(&temp.0, &public(&key)).unwrap();
    }
    let running = lease(&version_dir(&temp.0, 1)).unwrap();
    prune(&temp.0, &public(&key)).unwrap();
    assert!(version_dir(&temp.0, 1).exists());
    drop(running);
    prune(&temp.0, &public(&key)).unwrap();
    assert!(!version_dir(&temp.0, 1).exists());
    assert!(version_dir(&temp.0, 2).exists());
    assert_eq!(
        fs::read(temp.0.join("profile/fixture")).unwrap(),
        b"test-data"
    );
}

#[test]
fn concurrent_installation_and_corrupt_state_fail_closed() {
    let temp = Temp::new();
    let key = key();
    let package = temp.0.join("package.tar.gz");
    archive(&package, false);
    let mut m = manifest();
    (m.size, m.sha256) = hash_file(&package).unwrap();
    let guard = lock(&temp.0).unwrap();
    assert!(install(&temp.0, &signed(&m, &key), &package, &public(&key), 1500).is_err());
    drop(guard);
    fs::write(temp.0.join("core-state.json"), b"{broken").unwrap();
    assert!(select(&temp.0, &public(&key)).is_err());
}

#[test]
fn traversal_archive_and_tampered_active_receipt_are_rejected() {
    let temp = Temp::new();
    let key = key();
    let package = temp.0.join("package.tar.gz");
    let gzip = flate2::write::GzEncoder::new(
        fs::File::create(&package).unwrap(),
        flate2::Compression::fast(),
    );
    let mut tar = tar::Builder::new(gzip);
    let mut header = tar::Header::new_gnu();
    header.set_size(1);
    header.set_mode(0o644);
    header.as_mut_bytes()[..10].copy_from_slice(b"../escaped");
    header.set_cksum();
    tar.append(&header, [0_u8].as_slice()).unwrap();
    tar.into_inner().unwrap().finish().unwrap();
    let mut m = manifest();
    (m.size, m.sha256) = hash_file(&package).unwrap();
    assert!(install(&temp.0, &signed(&m, &key), &package, &public(&key), 1500).is_err());
    assert!(!temp.0.join("core/escaped").exists());
    archive(&package, false);
    (m.size, m.sha256) = hash_file(&package).unwrap();
    install(&temp.0, &signed(&m, &key), &package, &public(&key), 1500).unwrap();
    select(&temp.0, &public(&key)).unwrap();
    fs::write(temp.0.join("core-health"), "1").unwrap();
    select(&temp.0, &public(&key)).unwrap();
    let receipt = version_dir(&temp.0, 1).join("core-update.json");
    let mut env: Envelope = serde_json::from_slice(&fs::read(&receipt).unwrap()).unwrap();
    env.payload = env.payload.replace("154.0.34", "155.0.0");
    fs::write(receipt, serde_json::to_vec(&env).unwrap()).unwrap();
    assert!(select(&temp.0, &public(&key)).is_err());
}

#[test]
fn crash_between_directory_publish_and_state_commit_can_recover_without_overwrite() {
    let temp = Temp::new();
    let key = key();
    let package = temp.0.join("package.tar.gz");
    archive(&package, false);
    let mut m = manifest();
    (m.size, m.sha256) = hash_file(&package).unwrap();
    let metadata = signed(&m, &key);
    install(&temp.0, &metadata, &package, &public(&key), 1500).unwrap();
    fs::write(
        temp.0.join("core-state.json"),
        serde_json::to_vec(&State::default()).unwrap(),
    )
    .unwrap();
    install(&temp.0, &metadata, &package, &public(&key), 1500).unwrap();
    assert_eq!(read_state(&temp.0).unwrap().pending, Some(1));
    fs::write(
        temp.0.join("core-state.json"),
        serde_json::to_vec(&State::default()).unwrap(),
    )
    .unwrap();
    fs::write(
        version_dir(&temp.0, 1).join("unknown-file"),
        b"do not remove",
    )
    .unwrap();
    assert!(install(&temp.0, &metadata, &package, &public(&key), 1500).is_err());
    assert!(version_dir(&temp.0, 1).join("unknown-file").exists());
}

fn archive(path: &Path, unsafe_link: bool) {
    let gzip =
        flate2::write::GzEncoder::new(fs::File::create(path).unwrap(), flate2::Compression::fast());
    let mut tar = tar::Builder::new(gzip);
    for name in [
        "chrominimum.exe",
        "chrominimum.dll",
        "chrome_elf.dll",
        "libcef.dll",
        "CREDITS.html",
        "LICENSES-RUST.html",
    ] {
        let mut header = tar::Header::new_gnu();
        header.set_size(1);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append_data(&mut header, name, [0_u8].as_slice())
            .unwrap();
    }
    if unsafe_link {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o777);
        header.set_link_name("../../outside").unwrap();
        header.set_cksum();
        tar.append_data(&mut header, "link", &[][..]).unwrap();
    }
    tar.into_inner().unwrap().finish().unwrap();
}

#[test]
fn tampering_wrong_key_expiry_rollback_and_wrong_platform_are_rejected() {
    let key = key();
    let m = manifest();
    let bytes = signed(&m, &key);
    assert!(verify(&bytes, &public(&key), 1500, 0).is_ok());
    assert!(verify(&bytes, &public(&self::key()), 1500, 0).is_err());
    assert!(verify(&bytes, &public(&key), 2000, 0).is_err());
    assert!(verify(&bytes, &public(&key), 1500, 2).is_err());
    let mut envelope: Envelope = serde_json::from_slice(&bytes).unwrap();
    envelope.payload = envelope.payload.replace("154.0.34", "155.0.1");
    assert!(
        verify(
            &serde_json::to_vec(&envelope).unwrap(),
            &public(&key),
            1500,
            0
        )
        .is_err()
    );
    for (platform, api) in [("linux-x64", 1), ("windows-x64", 2)] {
        let mut m = m.clone();
        m.platform = platform.into();
        m.launcher_api = api;
        assert!(verify(&signed(&m, &key), &public(&key), 1500, 0).is_err());
    }
}
#[test]
fn unsigned_hash_replacement_unsafe_source_and_oversize_are_rejected() {
    let key = key();
    for url in [
        "http://github.com/SargeMadovsky/ChroMinimum/releases/download/a",
        "https://evil.test/core",
        "https://github.com/SargeMadovsky/ChroMinimum/releases/download/a?evil=1",
    ] {
        let mut m = manifest();
        m.url = url.into();
        assert!(verify(&signed(&m, &key), &public(&key), 1500, 0).is_err());
    }
    assert!(verify(&vec![0; MAX_MANIFEST as usize + 1], &public(&key), 1500, 0).is_err());
    let mut m = manifest();
    m.size = u64::MAX;
    assert!(verify(&signed(&m, &key), &public(&key), 1500, 0).is_err());
}
#[test]
fn installation_is_staged_and_health_confirmation_activates_it() {
    let temp = Temp::new();
    let key = key();
    let package = temp.0.join("package.tar.gz");
    archive(&package, false);
    let mut m = manifest();
    (m.size, m.sha256) = hash_file(&package).unwrap();
    install(&temp.0, &signed(&m, &key), &package, &public(&key), 1500).unwrap();
    assert_eq!(read_state(&temp.0).unwrap().active, 0);
    assert_eq!(select(&temp.0, &public(&key)).unwrap(), 1);
    fs::write(temp.0.join("core-health"), "1").unwrap();
    assert_eq!(select(&temp.0, &public(&key)).unwrap(), 1);
    assert_eq!(read_state(&temp.0).unwrap().active, 1);
    assert!(install(&temp.0, &signed(&m, &key), &package, &public(&key), 1500).is_err());
}
#[test]
fn failed_candidate_rolls_back_only_when_security_floor_allows_it() {
    for floor in [0, 1] {
        let temp = Temp::new();
        let key = key();
        let package = temp.0.join("package.tar.gz");
        archive(&package, false);
        let mut m = manifest();
        (m.size, m.sha256) = hash_file(&package).unwrap();
        m.min_safe_sequence = floor;
        install(&temp.0, &signed(&m, &key), &package, &public(&key), 1500).unwrap();
        assert_eq!(select(&temp.0, &public(&key)).unwrap(), 1);
        let second = select(&temp.0, &public(&key));
        if floor == 0 {
            assert_eq!(second.unwrap(), 0);
        } else {
            assert!(second.is_err());
        }
    }
}
#[test]
fn damaged_package_and_archive_symlinks_never_change_active_state() {
    let temp = Temp::new();
    let key = key();
    let package = temp.0.join("package.tar.gz");
    archive(&package, true);
    let mut m = manifest();
    (m.size, m.sha256) = hash_file(&package).unwrap();
    assert!(install(&temp.0, &signed(&m, &key), &package, &public(&key), 1500).is_err());
    assert_eq!(read_state(&temp.0).unwrap().highest, 0);
    m.sha256 = "ff".repeat(32);
    assert!(install(&temp.0, &signed(&m, &key), &package, &public(&key), 1500).is_err());
    assert!(!temp.0.join("outside").exists());
}
