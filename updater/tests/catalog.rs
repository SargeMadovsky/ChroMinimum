use cm_update::{
    Envelope,
    catalog::{self, Catalog, Package},
    components::{Component, InstallConfig, Locale},
    hex,
};
use ring::signature::{Ed25519KeyPair, KeyPair};

fn key() -> Ed25519KeyPair {
    let bytes = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap();
    Ed25519KeyPair::from_pkcs8(bytes.as_ref()).unwrap()
}
fn fixture() -> Catalog {
    let packages = [
        Component::Core {},
        Component::Locale {
            locale: Locale::EnUs,
        },
        Component::Locale { locale: Locale::Ru },
    ]
    .into_iter()
    .enumerate()
    .map(|(i, component)| Package {
        component,
        sequence: 10,
        engine_version: "154.0.34+g14c5a08".into(),
        adapter_sha256: "ab".repeat(32),
        size: 100,
        sha256: "cd".repeat(32),
        url: format!(
            "https://github.com/SargeMadovsky/ChroMinimum/releases/download/test/package-{i}.tar.gz"
        ),
    })
    .collect();
    Catalog {
        format: 2,
        purpose: "chrominimum-components".into(),
        launcher_api: 2,
        sequence: 10,
        min_safe_sequence: 8,
        platform: "windows-x64".into(),
        engine_version: "154.0.34+g14c5a08".into(),
        adapter_sha256: "ab".repeat(32),
        issued: 1000,
        expires: 2000,
        packages,
    }
}
fn signed(catalog: &Catalog, key: &Ed25519KeyPair) -> Vec<u8> {
    let payload = serde_json::to_string(catalog).unwrap();
    serde_json::to_vec(&Envelope {
        signature: hex(key.sign(payload.as_bytes()).as_ref()),
        payload,
    })
    .unwrap()
}
fn verify(catalog: &Catalog) -> bool {
    let key = key();
    catalog::verify(
        &signed(catalog, &key),
        &key.public_key().as_ref().try_into().unwrap(),
        1500,
        9,
        8,
    )
    .is_ok()
}
fn config(language: &str) -> InstallConfig {
    InstallConfig::parse(
        format!(r#"{{"format":1,"ui_locale":"{language}","locales":["{language}"]}}"#).as_bytes(),
    )
    .unwrap()
}

#[test]
fn authentic_catalog_selects_only_requested_packages_and_fallback() {
    let key = key();
    let verified = catalog::verify(
        &signed(&fixture(), &key),
        &key.public_key().as_ref().try_into().unwrap(),
        1500,
        9,
        8,
    )
    .unwrap();
    let en = verified.plan(&config("en-US")).unwrap();
    assert_eq!(en.packages.len(), 2);
    assert_eq!(en.total_download_bytes, 200);
    assert!(
        !en.packages
            .iter()
            .any(|p| p.component == Component::Locale { locale: Locale::Ru })
    );
    assert_eq!(verified.plan(&config("ru")).unwrap().packages.len(), 3);
}

#[test]
fn tampering_wrong_key_and_unbounded_metadata_are_rejected() {
    let first = key();
    let other = key();
    let bytes = signed(&fixture(), &first);
    let public = first.public_key().as_ref().try_into().unwrap();
    assert!(
        catalog::verify(
            &bytes,
            &other.public_key().as_ref().try_into().unwrap(),
            1500,
            9,
            8
        )
        .is_err()
    );
    let mut envelope: Envelope = serde_json::from_slice(&bytes).unwrap();
    envelope.payload = envelope.payload.replace("154.0.34", "154.0.35");
    assert!(catalog::verify(&serde_json::to_vec(&envelope).unwrap(), &public, 1500, 9, 8).is_err());
    assert!(
        catalog::verify(
            &vec![b' '; catalog::MAX_CATALOG as usize + 1],
            &public,
            1500,
            9,
            8
        )
        .is_err()
    );
    assert!(catalog::verify(b"{}", &public, 1500, 9, 8).is_err());
}

#[test]
fn incompatible_release_identity_and_expiry_are_rejected() {
    let mut variants = Vec::new();
    macro_rules! bad {
        ($field:ident, $value:expr) => {{
            let mut c = fixture();
            c.$field = $value;
            variants.push(c);
        }};
    }
    bad!(format, 1);
    bad!(purpose, "other-product".into());
    bad!(launcher_api, 1);
    bad!(platform, "linux-x64".into());
    bad!(sequence, 0);
    bad!(sequence, 8);
    bad!(min_safe_sequence, 7);
    bad!(min_safe_sequence, 11);
    bad!(issued, 1801);
    bad!(expires, 1500);
    bad!(expires, 1000 + 46 * 86400);
    bad!(engine_version, "".into());
    bad!(adapter_sha256, "bad".into());
    for c in variants {
        assert!(!verify(&c), "{c:?}");
    }
    let mut c = fixture();
    c.packages[0].sequence = 9;
    assert!(!verify(&c));
    let mut c = fixture();
    c.packages[1].engine_version.push('x');
    assert!(!verify(&c));
    let mut c = fixture();
    c.packages[2].adapter_sha256 = "ef".repeat(32);
    assert!(!verify(&c));
}

#[test]
fn duplicates_missing_core_unsafe_sources_and_bad_hashes_are_rejected() {
    let mut c = fixture();
    c.packages[2].component = c.packages[1].component.clone();
    assert!(!verify(&c));
    let mut c = fixture();
    c.packages[2].url = c.packages[1].url.clone();
    assert!(!verify(&c));
    let mut c = fixture();
    c.packages.remove(0);
    assert!(!verify(&c));
    let mut c = fixture();
    c.packages[0].sha256 = "zz".repeat(32);
    assert!(!verify(&c));
    for suffix in [
        "../file",
        "tag/../file",
        "tag/file?x",
        "tag/file#x",
        "tag/%2e%2e",
        "tag/",
        "tag/a\\b",
    ] {
        let mut c = fixture();
        c.packages[0].url =
            format!("https://github.com/SargeMadovsky/ChroMinimum/releases/download/{suffix}");
        assert!(!verify(&c), "{suffix}");
    }
    let mut c = fixture();
    c.packages[0].url = "https://example.com/payload".into();
    assert!(!verify(&c));
    for size in [0, 512 * 1024 * 1024 + 1, u64::MAX] {
        let mut c = fixture();
        c.packages[0].size = size;
        assert!(!verify(&c));
    }
}

#[test]
fn missing_language_and_combined_download_limit_fail_without_fallback_selection() {
    let key = key();
    let public = key.public_key().as_ref().try_into().unwrap();
    let mut c = fixture();
    c.packages.pop();
    let verified = catalog::verify(&signed(&c, &key), &public, 1500, 9, 8).unwrap();
    assert!(verified.plan(&config("ru")).is_err());
    assert!(verified.plan(&config("en-US")).is_ok());
    c.packages.pop();
    let verified = catalog::verify(&signed(&c, &key), &public, 1500, 9, 8).unwrap();
    assert!(verified.plan(&config("en-US")).is_err());
    let mut c = fixture();
    c.packages[0].size = 512 * 1024 * 1024;
    let verified = catalog::verify(&signed(&c, &key), &public, 1500, 9, 8).unwrap();
    assert!(verified.plan(&config("en-US")).is_err());
}

#[test]
fn signed_unknown_fields_and_unknown_components_do_not_bypass_schema() {
    let key = key();
    let public = key.public_key().as_ref().try_into().unwrap();
    let value = serde_json::to_value(fixture()).unwrap();
    for mutation in 0..3 {
        let mut value = value.clone();
        match mutation {
            0 => value["extra"] = true.into(),
            1 => value["packages"][0]["component"]["kind"] = "accessibility".into(),
            _ => value["packages"][0]["component"]["extra"] = true.into(),
        }
        let payload = serde_json::to_string(&value).unwrap();
        let bytes = serde_json::to_vec(&Envelope {
            signature: hex(key.sign(payload.as_bytes()).as_ref()),
            payload,
        })
        .unwrap();
        assert!(
            catalog::verify(&bytes, &public, 1500, 9, 8).is_err(),
            "mutation {mutation}"
        );
    }
}

#[test]
fn diagnostic_cli_rejects_unsigned_catalog_without_changing_inputs() {
    let unique = key();
    let dir = std::env::temp_dir().join(format!(
        "cm-catalog-cli-{}",
        hex(unique.public_key().as_ref())
    ));
    std::fs::create_dir(&dir).unwrap();
    let config_path = dir.join("installation.json");
    let catalog_path = dir.join("catalog.json");
    let config_bytes = br#"{"format":1,"ui_locale":"ru","locales":["ru"]}"#;
    std::fs::write(&config_path, config_bytes).unwrap();
    std::fs::write(&catalog_path, b"{}").unwrap();
    let result = std::process::Command::new(env!("CARGO_BIN_EXE_cm-update"))
        .arg("--catalog-plan")
        .arg(&config_path)
        .arg(&catalog_path)
        .args(["0", "0"])
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(result.stdout.is_empty());
    assert_eq!(std::fs::read(&config_path).unwrap(), config_bytes);
    assert_eq!(std::fs::read(&catalog_path).unwrap(), b"{}");
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
    std::fs::remove_file(config_path).unwrap();
    std::fs::remove_file(catalog_path).unwrap();
    std::fs::remove_dir(dir).unwrap();
}
