//! Cross-check the Python producer against the actual Rust catalog verifier.
use cm_update::{Envelope, catalog, components::InstallConfig, hex};
use ring::{
    digest,
    signature::{Ed25519KeyPair, KeyPair},
};

#[test]
#[ignore = "Requires locally generated real CEF archives and a new output path"]
fn assemble_real_component_archives_offline() {
    let archives =
        std::path::PathBuf::from(std::env::var_os("CHROMINIMUM_COMPONENT_TEST_INPUT").unwrap());
    let output =
        std::path::PathBuf::from(std::env::var_os("CHROMINIMUM_COMPONENT_TEST_OUTPUT").unwrap());
    assert!(!output.exists());
    let secret = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap();
    let key = Ed25519KeyPair::from_pkcs8(secret.as_ref()).unwrap();
    let payload = std::fs::read_to_string(archives.join("catalog.unsigned.json")).unwrap();
    let envelope = Envelope {
        signature: hex(key.sign(payload.as_bytes()).as_ref()),
        payload,
    };
    let verified = catalog::verify(
        &serde_json::to_vec(&envelope).unwrap(),
        &key.public_key().as_ref().try_into().unwrap(),
        cm_update::now().unwrap(),
        0,
        0,
    )
    .unwrap();
    let config =
        InstallConfig::parse(br#"{"format":1,"ui_locale":"ru","locales":["ru"]}"#).unwrap();
    if std::env::var_os("CHROMINIMUM_COMPONENT_TEST_TRANSACTION").is_some() {
        std::fs::create_dir(&output).unwrap();
        let public = key.public_key().as_ref().try_into().unwrap();
        let id = cm_update::component_install::prepare(
            &output,
            &serde_json::to_vec(&envelope).unwrap(),
            &config,
            &archives,
            &public,
            cm_update::now().unwrap(),
        )
        .unwrap();
        let trial = cm_update::component_install::select(&output, &public).unwrap();
        assert_eq!(trial.id, id);
        cm_update::component_install::confirm(
            &output,
            &id,
            trial.trial_token.as_ref().unwrap(),
            &public,
        )
        .unwrap();
        let active = cm_update::component_install::select(&output, &public).unwrap();
        assert_eq!(active.id, id);
        assert!(active.trial_token.is_none());
        assert!(!output.join("core-state.json").exists());
        let bytes = serde_json::to_vec_pretty(&active).unwrap();
        use std::io::Write;
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(output.with_extension("report.json"))
            .unwrap()
            .write_all(&bytes)
            .unwrap();
        println!("{}", String::from_utf8(bytes).unwrap());
        return;
    }
    let report = verified.stage_local(&config, &archives, &output).unwrap();
    assert_eq!(report.files, 31);
    assert!(output.join("locales/ru.pak").is_file());
    assert!(output.join("locales/en-US.pak").is_file());
    assert!(!output.join("locales/de.pak").exists());
    let bytes = serde_json::to_vec_pretty(&report).unwrap();
    use std::io::Write;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output.with_extension("report.json"))
        .unwrap()
        .write_all(&bytes)
        .unwrap();
    println!("{}", String::from_utf8(bytes).unwrap());
}

#[test]
fn producer_output_is_accepted_and_archive_hashes_match() {
    let secret = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap();
    let key = Ed25519KeyPair::from_pkcs8(secret.as_ref()).unwrap();
    let root = std::env::temp_dir().join(format!("cm-producer-{}", hex(key.public_key().as_ref())));
    std::fs::create_dir(&root).unwrap();
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let code = r#"
import pathlib, runpy, sys
m = runpy.run_path(sys.argv[1])
root = pathlib.Path(sys.argv[2])
bundle = root / 'bundle'
bundle.mkdir()
names = m['RUNTIME'] | set().union(*(m['locale_names'](x) for x in m['LOCALES']))
for name in names:
    file = bundle / name
    file.parent.mkdir(exist_ok=True)
    file.write_bytes(name.encode())
licenses = root / 'licenses.html'
licenses.write_text('Synthetic test licenses')
m['build'](bundle, root / 'out', 1, 0, '154.0.34', 'test', licenses, 1000)
"#;
    let result = std::process::Command::new("python")
        .args(["-c", code])
        .arg(repo.join("scripts/package-components.py"))
        .arg(&root)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let payload = std::fs::read_to_string(root.join("out/catalog.unsigned.json")).unwrap();
    let envelope = Envelope {
        signature: hex(key.sign(payload.as_bytes()).as_ref()),
        payload,
    };
    let verified = catalog::verify(
        &serde_json::to_vec(&envelope).unwrap(),
        &key.public_key().as_ref().try_into().unwrap(),
        1500,
        0,
        0,
    )
    .unwrap();
    let config =
        InstallConfig::parse(br#"{"format":1,"ui_locale":"ru","locales":["ru"]}"#).unwrap();
    let plan = verified.plan(&config).unwrap();
    assert_eq!(plan.packages.len(), 3);
    let assembled = root.join("assembled");
    let report = verified
        .stage_local(&config, &root.join("out"), &assembled)
        .unwrap();
    assert_eq!(report.files, 31);
    assert!(assembled.join("locales/ru.pak").is_file());
    assert!(
        verified
            .stage_local(&config, &root.join("out"), &assembled)
            .is_err()
    );
    let en =
        InstallConfig::parse(br#"{"format":1,"ui_locale":"en-US","locales":["en-US"]}"#).unwrap();
    let en_output = root.join("english");
    assert_eq!(
        verified
            .stage_local(&en, &root.join("out"), &en_output)
            .unwrap()
            .files,
        27
    );
    assert!(!en_output.join("locales/ru.pak").exists());
    // Full local transaction, including same-release language changes and rollback.
    let tx = root.join("transaction");
    std::fs::create_dir(&tx).unwrap();
    let signed_bytes = serde_json::to_vec(&envelope).unwrap();
    let public = key.public_key().as_ref().try_into().unwrap();
    let first = cm_update::component_install::prepare(
        &tx,
        &signed_bytes,
        &config,
        &root.join("out"),
        &public,
        1500,
    )
    .unwrap();
    // Simulate publication succeeding before the first atomic state commit.
    std::fs::remove_file(tx.join("component-state.json")).unwrap();
    assert_eq!(
        cm_update::component_install::prepare(
            &tx,
            &signed_bytes,
            &config,
            &root.join("out"),
            &public,
            1500
        )
        .unwrap(),
        first
    );
    assert!(
        cm_update::component_install::prepare(
            &tx,
            &signed_bytes,
            &config,
            &root.join("out"),
            &public,
            1500
        )
        .is_err()
    );
    let trial = cm_update::component_install::select(&tx, &public).unwrap();
    assert_eq!(trial.id, first);
    assert!(cm_update::component_install::confirm(&tx, &first, &"00".repeat(16), &public).is_err());
    cm_update::component_install::confirm(
        &tx,
        &first,
        trial.trial_token.as_ref().unwrap(),
        &public,
    )
    .unwrap();
    assert!(
        cm_update::component_install::select(&tx, &public)
            .unwrap()
            .trial_token
            .is_none()
    );
    let (_, held, runtime) = cm_update::component_install::select_for_launch(&tx, &public).unwrap();
    let exclusive = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(runtime.join("core-running.lock"))
        .unwrap();
    assert!(exclusive.try_lock().is_err());
    drop(held);
    assert!(exclusive.try_lock().is_ok());
    drop(exclusive);
    let second = cm_update::component_install::prepare(
        &tx,
        &signed_bytes,
        &en,
        &root.join("out"),
        &public,
        1500,
    )
    .unwrap();
    assert_ne!(first, second);
    let (rejected, pending_lease, _) =
        cm_update::component_install::select_for_launch(&tx, &public).unwrap();
    assert_eq!(rejected.id, second);
    assert!(cm_update::component_install::select(&tx, &public).is_err());
    drop(pending_lease);
    // No confirmation: next selection must return the last confirmed RU copy.
    assert_eq!(
        cm_update::component_install::select(&tx, &public)
            .unwrap()
            .id,
        first
    );
    assert!(
        cm_update::component_install::confirm(
            &tx,
            &second,
            rejected.trial_token.as_ref().unwrap(),
            &public
        )
        .is_err()
    );
    assert!(!tx.join("core-state.json").exists());
    // Advancing the signed security floor must prevent rollback to release 1.
    let mut newer: catalog::Catalog = serde_json::from_str(&envelope.payload).unwrap();
    newer.sequence = 2;
    newer.min_safe_sequence = 2;
    for package in &mut newer.packages {
        package.sequence = 2;
    }
    let payload = serde_json::to_string(&newer).unwrap();
    let raised = Envelope {
        signature: hex(key.sign(payload.as_bytes()).as_ref()),
        payload,
    };
    let raised_bytes = serde_json::to_vec(&raised).unwrap();
    let third = cm_update::component_install::prepare(
        &tx,
        &raised_bytes,
        &en,
        &root.join("out"),
        &public,
        1500,
    )
    .unwrap();
    assert_eq!(
        cm_update::component_install::select(&tx, &public)
            .unwrap()
            .id,
        third
    );
    assert!(cm_update::component_install::select(&tx, &public).is_err());
    assert!(
        cm_update::component_install::prepare(
            &tx,
            &signed_bytes,
            &config,
            &root.join("out"),
            &public,
            1500
        )
        .is_err()
    );
    // Retry the safe release; changing even receipt whitespace must invalidate its ID.
    cm_update::component_install::prepare(
        &tx,
        &raised_bytes,
        &en,
        &root.join("out"),
        &public,
        1500,
    )
    .unwrap();
    let receipt_path = tx
        .join("component-core")
        .join(&third)
        .join("component-receipt.json");
    let mut receipt_bytes = std::fs::read(&receipt_path).unwrap();
    receipt_bytes.push(b' ');
    std::fs::write(&receipt_path, receipt_bytes).unwrap();
    assert!(cm_update::component_install::select(&tx, &public).is_err());
    for package in plan.packages {
        let name = package.url.rsplit('/').next().unwrap();
        let bytes = std::fs::read(root.join("out").join(name)).unwrap();
        assert_eq!(bytes.len() as u64, package.size);
        assert_eq!(
            hex(digest::digest(&digest::SHA256, &bytes).as_ref()),
            package.sha256
        );
    }
    let original: catalog::Catalog = serde_json::from_str(&envelope.payload).unwrap();
    let target = root
        .join("out")
        .join(original.packages[1].url.rsplit('/').next().unwrap());
    let good_bytes = std::fs::read(&target).unwrap();
    std::fs::write(&target, b"tampered").unwrap();
    let output = root.join("bad-hash");
    assert!(
        verified
            .stage_local(&config, &root.join("out"), &output)
            .is_err()
    );
    assert!(!output.exists());
    std::fs::write(&target, &good_bytes).unwrap();
    // Even a valid signature/hash must not allow a locale package to install code,
    // aliases, links, duplicates, incomplete files or a decompression bomb.
    for (case, name, kind, size) in [
        ("dll", "chrominimum.dll", b'0', 1),
        ("traversal", "../outside", b'0', 1),
        ("link", "locales/en-US.pak", b'2', 0),
        ("missing", "locales/en-US.pak", b'0', 1),
        ("duplicate", "locales/en-US.pak", b'0', 1),
        (
            "huge",
            "locales/en-US.pak",
            b'0',
            2 * 1024 * 1024 * 1024 + 1,
        ),
    ] {
        use std::io::Write;
        let mut encoded = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut header = tar::Header::new_ustar();
        header.set_size(size);
        header.set_mode(0o644);
        header.set_entry_type(tar::EntryType::new(kind));
        header.as_mut_bytes()[..name.len()].copy_from_slice(name.as_bytes());
        header.set_cksum();
        for _ in 0..(if case == "duplicate" { 2 } else { 1 }) {
            encoded.write_all(header.as_bytes()).unwrap();
            if kind == b'0' && size == 1 {
                encoded.write_all(&[0; 512]).unwrap();
            }
        }
        encoded.write_all(&[0; 1024]).unwrap();
        let bytes = encoded.finish().unwrap();
        std::fs::write(&target, &bytes).unwrap();
        let mut changed = original.clone();
        changed.packages[1].size = bytes.len() as u64;
        changed.packages[1].sha256 = hex(digest::digest(&digest::SHA256, &bytes).as_ref());
        let payload = serde_json::to_string(&changed).unwrap();
        let signed = Envelope {
            signature: hex(key.sign(payload.as_bytes()).as_ref()),
            payload,
        };
        let checked = catalog::verify(
            &serde_json::to_vec(&signed).unwrap(),
            &key.public_key().as_ref().try_into().unwrap(),
            1500,
            0,
            0,
        )
        .unwrap();
        assert!(
            checked
                .stage_local(&config, &root.join("out"), &root.join(case))
                .is_err(),
            "{case}"
        );
        assert!(!root.join("outside").exists());
    }
    // Only this uniquely created synthetic directory is removed.
    std::fs::remove_dir_all(root).unwrap();
}
