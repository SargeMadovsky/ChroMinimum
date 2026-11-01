//! Download only an authenticated selection into a fresh private cache.
use crate::{Result, catalog::VerifiedCatalog, components::InstallConfig};
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    path::Path,
    time::Duration,
};

impl VerifiedCatalog {
    pub fn download(&self, config: &InstallConfig, destination: &Path) -> Result<()> {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .https_only(true)
            .timeout_global(Some(Duration::from_secs(600)))
            .timeout_connect(Some(Duration::from_secs(15)))
            .timeout_recv_response(Some(Duration::from_secs(30)))
            .build()
            .into();
        self.download_with(config, destination, |url| {
            Ok(Box::new(agent.get(url).call()?.into_body().into_reader()))
        })
    }

    // Transport injection is private: tests cannot add an insecure production option.
    fn download_with(
        &self,
        config: &InstallConfig,
        destination: &Path,
        mut fetch: impl FnMut(&str) -> Result<Box<dyn Read>>,
    ) -> Result<()> {
        let plan = self.plan(config)?;
        let destination = std::path::absolute(destination)?;
        crate::packages::plain_path(destination.parent().ok_or("Cache parent required")?)?;
        let mut names = BTreeSet::new();
        for package in &plan.packages {
            let name = package
                .url
                .rsplit('/')
                .next()
                .ok_or("Missing package name")?;
            crate::safe_path(Path::new(name))?;
            if name.eq_ignore_ascii_case("download.part")
                || !names.insert(name.to_ascii_lowercase())
            {
                return Err("Colliding package filenames".into());
            }
        }
        fs::create_dir(&destination)?;
        for package in &plan.packages {
            let name = package
                .url
                .rsplit('/')
                .next()
                .ok_or("Missing package name")?;
            let temporary = destination.join("download.part");
            let mut created = false;
            let result = (|| -> Result<()> {
                let mut output = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temporary)?;
                created = true;
                let mut input = fetch(&package.url)?.take(package.size + 1);
                let mut hash = ring::digest::Context::new(&ring::digest::SHA256);
                let mut buffer = [0; 64 * 1024];
                let mut size = 0;
                loop {
                    let count = input.read(&mut buffer)?;
                    if count == 0 {
                        break;
                    }
                    size += count as u64;
                    if size > package.size {
                        return Err("Downloaded package exceeds signed size".into());
                    }
                    hash.update(&buffer[..count]);
                    output.write_all(&buffer[..count])?;
                }
                if size != package.size || crate::hex(hash.finish().as_ref()) != package.sha256 {
                    return Err("Downloaded package size or hash mismatch".into());
                }
                output.sync_all()?;
                drop(output);
                fs::rename(&temporary, destination.join(name))?;
                Ok(())
            })();
            if result.is_err() && created {
                // Only our known partial file; verified earlier packages remain for diagnosis.
                let _ = fs::remove_file(&temporary);
            }
            result?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Envelope,
        catalog::{self, Catalog, Package},
        components::{Component, Locale},
    };
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use std::{
        io::{BufRead, BufReader},
        net::TcpListener,
        sync::{Arc, Mutex},
    };

    fn fixture() -> (VerifiedCatalog, InstallConfig, std::path::PathBuf) {
        let key = Ed25519KeyPair::from_seed_unchecked(&[7; 32]).unwrap();
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
            sequence: 1,
            engine_version: "test".into(),
            adapter_sha256: "aa".repeat(32),
            url: format!(
                "https://github.com/SargeMadovsky/ChroMinimum/releases/download/test/{i}.tar.gz"
            ),
            size: 4,
            sha256: crate::hex(ring::digest::digest(&ring::digest::SHA256, b"data").as_ref()),
        })
        .collect();
        let catalog = Catalog {
            format: 2,
            purpose: "chrominimum-components".into(),
            launcher_api: 2,
            sequence: 1,
            min_safe_sequence: 0,
            platform: "windows-x64".into(),
            engine_version: "test".into(),
            adapter_sha256: "aa".repeat(32),
            issued: 1000,
            expires: 2000,
            packages,
        };
        let payload = serde_json::to_string(&catalog).unwrap();
        let bytes = serde_json::to_vec(&Envelope {
            signature: crate::hex(key.sign(payload.as_bytes()).as_ref()),
            payload,
        })
        .unwrap();
        let verified = catalog::verify(
            &bytes,
            &key.public_key().as_ref().try_into().unwrap(),
            1500,
            0,
            0,
        )
        .unwrap();
        let config =
            InstallConfig::parse(br#"{"format":1,"ui_locale":"en-US","locales":["en-US"]}"#)
                .unwrap();
        let mut nonce = [0; 16];
        ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut nonce).unwrap();
        let root = std::env::temp_dir().join(format!("cm-download-{}", crate::hex(&nonce)));
        fs::create_dir(&root).unwrap();
        (verified, config, root)
    }

    // Only the test transport maps signed GitHub URLs to loopback HTTP.
    fn http_download(
        verified: &VerifiedCatalog,
        config: &InstallConfig,
        cache: &Path,
        body: &'static [u8],
    ) -> (bool, Vec<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let count = if body == b"data" {
            verified.plan(config).unwrap().packages.len()
        } else {
            1
        };
        let server = std::thread::spawn(move || {
            for _ in 0..count {
                let (mut socket, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                recorded.lock().unwrap().push(line.trim().to_owned());
                loop {
                    line.clear();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                }
                // Claim 4 bytes even for a truncated connection.
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len().max(4)
                )
                .unwrap();
                socket.write_all(body).unwrap();
            }
        });
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(5)))
            .build()
            .into();
        let result = verified.download_with(config, cache, |url| {
            let name = url.rsplit('/').next().unwrap();
            Ok(Box::new(
                agent
                    .get(format!("http://{address}/{name}"))
                    .call()?
                    .into_body()
                    .into_reader(),
            ))
        });
        server.join().unwrap();
        let observed = requests.lock().unwrap().clone();
        (result.is_ok(), observed)
    }

    #[test]
    fn http_downloads_only_selected_languages_and_preserves_installation() {
        let (verified, en, root) = fixture();
        fs::write(root.join("component-state.json"), b"active-state-sentinel").unwrap();
        let cache = root.join("en");
        let (ok, requests) = http_download(&verified, &en, &cache, b"data");
        assert!(ok);
        assert_eq!(
            requests,
            ["GET /0.tar.gz HTTP/1.1", "GET /1.tar.gz HTTP/1.1"]
        );
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 2);
        let ru =
            InstallConfig::parse(br#"{"format":1,"ui_locale":"ru","locales":["ru"]}"#).unwrap();
        let (ok, requests) = http_download(&verified, &ru, &root.join("ru"), b"data");
        assert!(ok);
        assert_eq!(requests.len(), 3);
        assert!(requests[2].contains("/2.tar.gz"));
        assert_eq!(
            fs::read(root.join("component-state.json")).unwrap(),
            b"active-state-sentinel"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interruption_tampering_and_oversize_never_publish_a_package() {
        for body in [b"xx".as_slice(), b"evil", b"extra"] {
            let (verified, config, root) = fixture();
            let cache = root.join("cache");
            fs::write(root.join("component-state.json"), b"unchanged").unwrap();
            let (ok, requests) = http_download(&verified, &config, &cache, body);
            assert!(!ok);
            assert_eq!(requests.len(), 1);
            assert_eq!(fs::read_dir(cache).unwrap().count(), 0);
            assert_eq!(
                fs::read(root.join("component-state.json")).unwrap(),
                b"unchanged"
            );
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn existing_cache_is_never_reused_and_invalid_signature_creates_no_cache() {
        let (verified, config, root) = fixture();
        let cache = root.join("cache");
        fs::create_dir(&cache).unwrap();
        let mut called = false;
        assert!(
            verified
                .download_with(&config, &cache, |_| {
                    called = true;
                    Err("unexpected network".into())
                })
                .is_err()
        );
        assert!(!called);
        let fresh = root.join("fresh");
        assert!(
            crate::component_install::download_and_prepare(
                &root,
                b"bad signature",
                &config,
                &fresh,
                &[0; 32]
            )
            .is_err()
        );
        assert!(!fresh.exists());
        assert!(!root.join("component-state.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "Requires loopback HTTPS fixture, real component catalog and fresh output directories"]
    fn real_components_over_verified_tls() {
        use ureq::tls::{Certificate, RootCerts, TlsConfig};
        let fixture = std::path::PathBuf::from(
            std::env::var_os("CM_COMPONENT_TLS_FIXTURE").expect("fixture directory"),
        );
        let origin = fs::read_to_string(fixture.join("origin.txt")).unwrap();
        assert!(origin.starts_with("https://localhost:"));
        let port: u16 = origin
            .trim_start_matches("https://localhost:")
            .parse()
            .unwrap();
        let root_cert =
            Certificate::from_der(&fs::read(fixture.join("ca.der")).unwrap()).to_owned();
        let trusted: ureq::Agent = ureq::Agent::config_builder()
            .https_only(true)
            .proxy(None)
            .timeout_global(Some(Duration::from_secs(60)))
            .tls_config(
                TlsConfig::builder()
                    .root_certs(RootCerts::Specific(vec![root_cert].into()))
                    .build(),
            )
            .build()
            .into();
        let untrusted: ureq::Agent = ureq::Agent::config_builder()
            .https_only(true)
            .proxy(None)
            .timeout_global(Some(Duration::from_secs(5)))
            .build()
            .into();
        let mut source: Catalog =
            serde_json::from_slice(&fs::read(fixture.join("catalog.unsigned.json")).unwrap())
                .unwrap();
        source.issued = crate::now().unwrap();
        source.expires = source.issued + 3600;
        let first_name = source.packages[0].url.rsplit('/').next().unwrap();
        assert!(
            untrusted
                .get(format!("{origin}/{first_name}"))
                .call()
                .is_err()
        );
        assert!(
            trusted
                .get(format!("https://127.0.0.1:{port}/{first_name}"))
                .call()
                .is_err()
        );
        assert!(
            trusted
                .get(format!("http://127.0.0.1:{port}/{first_name}"))
                .call()
                .is_err()
        );
        // Disposable, publicly known fixture signing key. Never used by shipped binaries.
        let key = Ed25519KeyPair::from_seed_unchecked(&[7; 32]).unwrap();
        let public: [u8; 32] = key.public_key().as_ref().try_into().unwrap();
        let payload = serde_json::to_string(&source).unwrap();
        let signed = serde_json::to_vec(&Envelope {
            signature: crate::hex(key.sign(payload.as_bytes()).as_ref()),
            payload,
        })
        .unwrap();
        fs::write(fixture.join("catalog.signed.json"), &signed).unwrap();
        fs::write(fixture.join("public-key.hex"), crate::hex(&public)).unwrap();
        let verified = catalog::verify(&signed, &public, crate::now().unwrap(), 0, 0).unwrap();
        for locale in ["en-US", "ru"] {
            let config_bytes =
                format!(r#"{{"format":1,"ui_locale":"{locale}","locales":["{locale}"]}}"#);
            let config = InstallConfig::parse(config_bytes.as_bytes()).unwrap();
            fs::write(fixture.join(format!("{locale}.json")), config_bytes).unwrap();
            let cache = fixture.join(format!("cache-{locale}"));
            verified
                .download_with(&config, &cache, |url| {
                    let name = url.rsplit('/').next().unwrap();
                    Ok(Box::new(
                        trusted
                            .get(format!("{origin}/{name}"))
                            .call()?
                            .into_body()
                            .into_reader(),
                    ))
                })
                .unwrap();
            assert_eq!(
                fs::read_dir(&cache).unwrap().count(),
                if locale == "ru" { 3 } else { 2 }
            );
            let root = fixture.join(format!("installation-{locale}"));
            fs::create_dir(&root).unwrap();
            let id = crate::component_install::prepare(
                &root,
                &signed,
                &config,
                &cache,
                &public,
                crate::now().unwrap(),
            )
            .unwrap();
            fs::write(fixture.join(format!("prepared-{locale}.txt")), id).unwrap();
            let state: serde_json::Value =
                serde_json::from_slice(&fs::read(root.join("component-state.json")).unwrap())
                    .unwrap();
            assert!(state["active"].is_null());
            assert_eq!(state["pending"]["attempted"], false);
        }
        fs::write(fixture.join("tls-result.json"), br#"{"trusted_download":true,"unknown_issuer_rejected":true,"wrong_hostname_rejected":true,"http_rejected":true,"en_packages":2,"ru_packages":3,"prepared_only":true}"#).unwrap();
    }
}
