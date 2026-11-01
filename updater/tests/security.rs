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
        media_codecs: false,
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
        fs::create_dir_all(dir.join("core/seed")).unwrap();
        fs::write(dir.join("core/seed/chrominimum.dll"), [0_u8]).unwrap();
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
    archive_with_adapter(path, unsafe_link, 0);
}

fn archive_with_adapter(path: &Path, unsafe_link: bool, adapter: u8) {
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
        let content = [if name == "chrominimum.dll" {
            adapter
        } else {
            0
        }];
        tar.append_data(&mut header, name, content.as_slice())
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
fn signed_old_adapter_is_rejected_before_publication_without_state_changes() {
    let temp = Temp::new();
    let key = key();
    let package = temp.0.join("package.tar.gz");
    archive_with_adapter(&package, false, 1);
    let mut m = manifest();
    (m.size, m.sha256) = hash_file(&package).unwrap();
    let error = install(&temp.0, &signed(&m, &key), &package, &public(&key), 1500)
        .unwrap_err()
        .to_string();
    assert!(error.contains("adapter differs"), "{error}");
    assert!(!temp.0.join("core-state.json").exists());
    assert!(!version_dir(&temp.0, 1).exists());
    assert_eq!(fs::read_dir(temp.0.join("core")).unwrap().count(), 1);
    assert_eq!(select(&temp.0, &public(&key)).unwrap(), 0);
}

#[test]
fn installer_adapter_change_rejects_legacy_pending_and_active_without_mutation() {
    for active in [false, true] {
        let temp = Temp::new();
        let key = key();
        let package = temp.0.join("package.tar.gz");
        archive(&package, false);
        let mut m = manifest();
        (m.size, m.sha256) = hash_file(&package).unwrap();
        install(&temp.0, &signed(&m, &key), &package, &public(&key), 1500).unwrap();
        if active {
            select(&temp.0, &public(&key)).unwrap();
            fs::write(temp.0.join("core-health"), "1").unwrap();
            select(&temp.0, &public(&key)).unwrap();
        }
        // A full installer changes the seed. A previously valid signed receipt
        // must not allow an older adapter to run after that installation.
        fs::write(version_dir(&temp.0, 0).join("chrominimum.dll"), [1_u8]).unwrap();
        let before = fs::read(temp.0.join("core-state.json")).unwrap();
        let error = select(&temp.0, &public(&key)).unwrap_err().to_string();
        assert!(error.contains("adapter differs"), "{error}");
        assert_eq!(fs::read(temp.0.join("core-state.json")).unwrap(), before);
    }
}

#[test]
fn crash_recovery_and_missing_seed_cannot_bypass_adapter_binding() {
    let temp = Temp::new();
    let key = key();
    let package = temp.0.join("package.tar.gz");
    archive(&package, false);
    let mut m = manifest();
    (m.size, m.sha256) = hash_file(&package).unwrap();
    let metadata = signed(&m, &key);
    install(&temp.0, &metadata, &package, &public(&key), 1500).unwrap();
    save_state(&temp.0, &State::default()).unwrap();
    let before = fs::read(temp.0.join("core-state.json")).unwrap();
    let seed = version_dir(&temp.0, 0).join("chrominimum.dll");
    fs::write(&seed, [1_u8]).unwrap();
    assert!(install(&temp.0, &metadata, &package, &public(&key), 1500).is_err());
    fs::remove_file(seed).unwrap();
    assert!(install(&temp.0, &metadata, &package, &public(&key), 1500).is_err());
    assert_eq!(fs::read(temp.0.join("core-state.json")).unwrap(), before);
}

fn seed_policy(temp: &Temp, sequence: u64) -> PathBuf {
    let seed = version_dir(&temp.0, 0);
    for name in ["chrominimum.exe", "libcef.dll", "chrome_elf.dll"] {
        fs::write(seed.join(name), [0_u8]).unwrap();
    }
    let files = [
        "chrominimum.exe",
        "chrominimum.dll",
        "libcef.dll",
        "chrome_elf.dll",
    ]
    .into_iter()
    .map(|name| (name.to_owned(), hash_file(&seed.join(name)).unwrap().1))
    .collect();
    let path = seed.join("installer-seed.json");
    fs::write(
        &path,
        serde_json::to_vec(&installer_seed::Policy {
            format: 1,
            security_sequence: sequence,
            engine_version: "154.0.34".into(),
            media_codecs: false,
            files,
        })
        .unwrap(),
    )
    .unwrap();
    path
}

#[test]
fn installer_migration_preserves_highest_and_floor_and_binds_seed_identity() {
    let temp = Temp::new();
    let key = key();
    let package = temp.0.join("package.tar.gz");
    archive(&package, false);
    let mut m = manifest();
    m.min_safe_sequence = 1;
    (m.size, m.sha256) = hash_file(&package).unwrap();
    install(&temp.0, &signed(&m, &key), &package, &public(&key), 1500).unwrap();
    select(&temp.0, &public(&key)).unwrap();
    fs::write(temp.0.join("core-health"), "1").unwrap();
    select(&temp.0, &public(&key)).unwrap();
    let mut state = read_state(&temp.0).unwrap();
    state.highest = 7;
    save_state(&temp.0, &state).unwrap();
    fs::write(version_dir(&temp.0, 0).join("chrominimum.dll"), [1_u8]).unwrap();
    let policy = seed_policy(&temp, 1);
    installer_seed::preflight(&temp.0, &policy).unwrap();
    installer_seed::migrate(&temp.0).unwrap();
    let state = read_state(&temp.0).unwrap();
    assert_eq!((state.active, state.highest, state.min_safe), (0, 7, 1));
    assert!(state.pending.is_none() && state.seed_policy_sha256.is_some());
    assert_eq!(select(&temp.0, &public(&key)).unwrap(), 0);
    installer_seed::migrate(&temp.0).unwrap();
    assert_eq!(read_state(&temp.0).unwrap().highest, 7);
    assert!(version_dir(&temp.0, 1).exists());
    fs::write(policy, b"{}").unwrap();
    assert!(select(&temp.0, &public(&key)).is_err());
}

#[test]
fn media_installation_rejects_stock_updates_and_receipts_but_accepts_signed_media() {
    let temp = Temp::new();
    let key = key();
    let path = seed_policy(&temp, 1);
    let mut policy: installer_seed::Policy =
        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    policy.media_codecs = true;
    fs::write(&path, serde_json::to_vec(&policy).unwrap()).unwrap();
    installer_seed::migrate(&temp.0).unwrap();
    let state = read_state(&temp.0).unwrap();
    assert_eq!(update_channel(&temp.0, &state).unwrap(), MEDIA_CHANNEL);
    let package = temp.0.join("package.tar.gz");
    archive(&package, false);
    let mut m = manifest();
    m.sequence = 2;
    (m.size, m.sha256) = hash_file(&package).unwrap();
    let before = fs::read(temp.0.join("core-state.json")).unwrap();
    // Legacy metadata omits the capability; it must not replace a media seed.
    assert!(
        !String::from_utf8(serde_json::to_vec(&m).unwrap())
            .unwrap()
            .contains("media_codecs")
    );
    assert!(require_compatible_media(&temp.0, &state, &m).is_err());
    assert!(install(&temp.0, &signed(&m, &key), &package, &public(&key), 1500).is_err());
    assert_eq!(fs::read(temp.0.join("core-state.json")).unwrap(), before);
    assert!(!version_dir(&temp.0, 2).exists());
    m.media_codecs = true;
    install(&temp.0, &signed(&m, &key), &package, &public(&key), 1500).unwrap();
    // Even a valid signature from the stock publisher is incompatible here.
    m.media_codecs = false;
    fs::write(
        version_dir(&temp.0, 2).join("core-update.json"),
        signed(&m, &key),
    )
    .unwrap();
    assert!(select(&temp.0, &public(&key)).is_err());
    m.media_codecs = true;
    fs::write(
        version_dir(&temp.0, 2).join("core-update.json"),
        signed(&m, &key),
    )
    .unwrap();
    assert_eq!(select(&temp.0, &public(&key)).unwrap(), 2);
    fs::write(temp.0.join("core-health"), "2").unwrap();
    assert_eq!(select(&temp.0, &public(&key)).unwrap(), 2);
    m.media_codecs = false;
    fs::write(
        version_dir(&temp.0, 2).join("core-update.json"),
        signed(&m, &key),
    )
    .unwrap();
    assert!(select(&temp.0, &public(&key)).is_err());
    policy.media_codecs = false;
    let downgrade = temp.0.join("stock-policy.json");
    fs::write(&downgrade, serde_json::to_vec(&policy).unwrap()).unwrap();
    assert!(installer_seed::preflight(&temp.0, &downgrade).is_err());
    fs::write(&path, serde_json::to_vec(&policy).unwrap()).unwrap();
    assert!(installer_seed::migrate(&temp.0).is_err());
    // Resuming an interrupted compatible installer must not require the old
    // policy file to still exist after copying the new seed.
    policy.media_codecs = true;
    policy.engine_version = "replacement media build".into();
    fs::write(&path, serde_json::to_vec(&policy).unwrap()).unwrap();
    installer_seed::preflight(&temp.0, &path).unwrap();
    installer_seed::migrate(&temp.0).unwrap();
    assert!(read_state(&temp.0).unwrap().media_codecs_required);
}

#[test]
fn legacy_seed_keeps_stock_channel_and_media_assertion_is_signed() {
    let temp = Temp::new();
    seed_policy(&temp, 1);
    installer_seed::migrate(&temp.0).unwrap();
    assert_eq!(
        update_channel(&temp.0, &read_state(&temp.0).unwrap()).unwrap(),
        CHANNEL
    );
    let key = key();
    let mut m = manifest();
    m.media_codecs = true;
    let bytes = signed(&m, &key);
    assert!(verify(&bytes, &public(&key), 1500, 0).unwrap().media_codecs);
    let mut envelope: Envelope = serde_json::from_slice(&bytes).unwrap();
    envelope.payload = envelope
        .payload
        .replace("\"media_codecs\":true", "\"media_codecs\":false");
    assert!(
        verify(
            &serde_json::to_vec(&envelope).unwrap(),
            &public(&key),
            1500,
            0
        )
        .is_err()
    );
    let path = version_dir(&temp.0, 0).join("installer-seed.json");
    let mut policy: installer_seed::Policy =
        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    policy.media_codecs = true;
    fs::write(path, serde_json::to_vec(&policy).unwrap()).unwrap();
    assert!(update_channel(&temp.0, &read_state(&temp.0).unwrap()).is_err());
}

#[test]
#[ignore = "Requires an explicitly supplied real media package and installer seed; no production key"]
fn real_media_archive_install_and_trial() {
    let package =
        PathBuf::from(std::env::var_os("CM_TEST_MEDIA_PACKAGE").expect("fixture package"));
    let metadata =
        PathBuf::from(std::env::var_os("CM_TEST_MEDIA_METADATA").expect("fixture metadata"));
    let source = PathBuf::from(std::env::var_os("CM_TEST_MEDIA_SEED").expect("fixture seed"));
    let report = PathBuf::from(std::env::var_os("CM_TEST_MEDIA_REPORT").expect("fixture report"));
    let temp = Temp::new();
    for name in [
        "chrominimum.exe",
        "chrominimum.dll",
        "libcef.dll",
        "chrome_elf.dll",
        "installer-seed.json",
    ] {
        fs::copy(source.join(name), version_dir(&temp.0, 0).join(name)).unwrap();
    }
    installer_seed::migrate(&temp.0).unwrap();
    let m: Manifest = serde_json::from_slice(&fs::read(metadata).unwrap()).unwrap();
    assert!(m.media_codecs);
    let key = key();
    install(
        &temp.0,
        &signed(&m, &key),
        &package,
        &public(&key),
        m.issued,
    )
    .unwrap();
    assert_eq!(select(&temp.0, &public(&key)).unwrap(), m.sequence);
    fs::write(temp.0.join("core-health"), m.sequence.to_string()).unwrap();
    assert_eq!(select(&temp.0, &public(&key)).unwrap(), m.sequence);
    for name in [
        "chrominimum.exe",
        "chrominimum.dll",
        "libcef.dll",
        "chrome_elf.dll",
        "CREDITS.html",
    ] {
        assert_eq!(
            hash_file(&version_dir(&temp.0, m.sequence).join(name)).unwrap(),
            hash_file(&source.join(name)).unwrap()
        );
    }
    assert!(read_state(&temp.0).unwrap().media_codecs_required);
    fs::write(
        report,
        serde_json::to_vec_pretty(&serde_json::json!({
            "real_archive_verified": true, "trial_and_health_confirmed": true,
            "critical_runtime_hashes_match_seed": true, "production_key_used": false,
            "browser_launched": false, "network_used": false, "sequence": m.sequence
        }))
        .unwrap(),
    )
    .unwrap();
}

#[test]
fn migration_refuses_higher_floor_corrupt_seed_and_live_runtime_without_state_write() {
    for failure in ["floor", "hash", "lease", "lock"] {
        let temp = Temp::new();
        let state = State {
            highest: 2,
            min_safe: if failure == "floor" { 2 } else { 1 },
            ..State::default()
        };
        save_state(&temp.0, &state).unwrap();
        let before = fs::read(temp.0.join("core-state.json")).unwrap();
        let policy = seed_policy(&temp, 1);
        if failure == "hash" {
            fs::write(version_dir(&temp.0, 0).join("libcef.dll"), [9_u8]).unwrap();
        }
        let _lease = if failure == "lease" {
            Some(lease(&version_dir(&temp.0, 0)).unwrap())
        } else {
            None
        };
        let _lock = if failure == "lock" {
            Some(lock(&temp.0).unwrap())
        } else {
            None
        };
        assert!(installer_seed::migrate(&temp.0).is_err(), "{failure}");
        if failure != "hash" {
            assert!(installer_seed::preflight(&temp.0, &policy).is_err());
        }
        assert_eq!(fs::read(temp.0.join("core-state.json")).unwrap(), before);
    }
}

#[test]
fn migrated_seed_allows_compatible_update_and_fallback_but_never_lower_security_floor() {
    for floor in [1, 2] {
        let temp = Temp::new();
        let key = key();
        seed_policy(&temp, 1);
        installer_seed::migrate(&temp.0).unwrap();
        let package = temp.0.join("package.tar.gz");
        archive(&package, false);
        let mut m = manifest();
        m.sequence = 2;
        m.min_safe_sequence = floor;
        (m.size, m.sha256) = hash_file(&package).unwrap();
        install(&temp.0, &signed(&m, &key), &package, &public(&key), 1500).unwrap();
        assert_eq!(select(&temp.0, &public(&key)).unwrap(), 2);
        let fallback = select(&temp.0, &public(&key));
        if floor == 1 {
            assert_eq!(fallback.unwrap(), 0);
        } else {
            assert!(fallback.is_err());
        }
        assert_eq!(read_state(&temp.0).unwrap().min_safe, floor);
    }
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
