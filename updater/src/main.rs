#![cfg_attr(windows, windows_subsystem = "windows")]
use cm_update::*;
use std::{
    fs,
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};

fn main() {
    if let Err(error) = run() {
        eprintln!("Core update: {error}");
        if std::env::args().any(|a| a == "--check") {
            println!("error");
        } else if !std::env::args().any(|a| {
            [
                "--keygen",
                "--sign",
                "--verify",
                "--inspect",
                "--components-plan",
                "--catalog-plan",
                "--stage-components",
                "--prepare-components",
                "--fetch-components",
                "--smoke-test",
                "--installer-preflight",
                "--migrate-installation",
            ]
            .contains(&a.as_str())
        }) {
            #[cfg(windows)]
            unsafe {
                use windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW;
                let message: Vec<u16> = format!("Не удалось запустить ChroMinimum.\n{error}")
                    .encode_utf16()
                    .chain(Some(0))
                    .collect();
                let title: Vec<u16> = "ChroMinimum".encode_utf16().chain(Some(0)).collect();
                MessageBoxW(std::ptr::null_mut(), message.as_ptr(), title.as_ptr(), 0x10);
            }
        }
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--installer-preflight") {
        if args.len() != 3 {
            return Err("Usage: --installer-preflight <root> <new-seed-policy>".into());
        }
        return installer_seed::preflight(Path::new(&args[1]), Path::new(&args[2]));
    }
    if args.first().map(String::as_str) == Some("--migrate-installation") {
        if args.len() != 2 {
            return Err("Usage: --migrate-installation <root>".into());
        }
        return installer_seed::migrate(Path::new(&args[1]));
    }
    if matches!(
        args.first().map(String::as_str),
        Some("--prepare-components" | "--fetch-components")
    ) {
        if args.len() != 5 {
            return Err(
                "Usage: --prepare-components|--fetch-components <root> <config> <signed-catalog> <archives-or-new-cache>".into(),
            );
        }
        let config = components::InstallConfig::read(Path::new(&args[2]))?;
        let mut bytes = Vec::new();
        fs::File::open(&args[3])?
            .take(catalog::MAX_CATALOG + 1)
            .read_to_end(&mut bytes)?;
        let key = unhex::<32>(include_str!("../public-key.hex").trim())?;
        let id = if args[0] == "--fetch-components" {
            component_install::download_and_prepare(
                Path::new(&args[1]),
                &bytes,
                &config,
                Path::new(&args[4]),
                &key,
            )?
        } else {
            component_install::prepare(
                Path::new(&args[1]),
                &bytes,
                &config,
                Path::new(&args[4]),
                &key,
                now()?,
            )?
        };
        println!("{id}");
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("--launch-components") {
        let root = std::path::absolute(args.get(1).ok_or("Installation root required")?)?;
        let key = unhex::<32>(include_str!("../public-key.hex").trim())?;
        return launch_components(&root, &args[2..], &key);
    }
    if args.first().map(String::as_str) == Some("--stage-components") {
        if args.len() != 7 {
            return Err("Usage: --stage-components <config> <signed-catalog> <archives> <new-output> <highest> <min-safe>".into());
        }
        let config = components::InstallConfig::read(Path::new(&args[1]))?;
        let key = unhex::<32>(include_str!("../public-key.hex").trim())?;
        let verified = catalog::read_verified(
            Path::new(&args[2]),
            &key,
            now()?,
            args[5].parse()?,
            args[6].parse()?,
        )?;
        let report = verified.stage_local(&config, Path::new(&args[3]), Path::new(&args[4]))?;
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("--catalog-plan") {
        if args.len() != 5 {
            return Err(
                "Usage: --catalog-plan <config> <signed-catalog> <highest> <min-safe>".into(),
            );
        }
        let config = components::InstallConfig::read(Path::new(&args[1]))?;
        let key = unhex::<32>(include_str!("../public-key.hex").trim())?;
        let verified = catalog::read_verified(
            Path::new(&args[2]),
            &key,
            now()?,
            args[3].parse()?,
            args[4].parse()?,
        )?;
        println!(
            "{}",
            serde_json::to_string_pretty(&verified.plan(&config)?)?
        );
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("--components-plan") {
        if args.len() != 2 {
            return Err("Usage: --components-plan <installation-config.json>".into());
        }
        let config = components::InstallConfig::read(Path::new(&args[1]))?;
        println!("{}", serde_json::to_string_pretty(&config.plan()?)?);
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("--keygen") {
        use ring::signature::KeyPair;
        let path = Path::new(args.get(1).ok_or("Private key path required")?);
        let bytes =
            ring::signature::Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
                .map_err(|_| "Key generation failed")?;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(path)?.write_all(bytes.as_ref())?;
        let key = ring::signature::Ed25519KeyPair::from_pkcs8(bytes.as_ref())
            .map_err(|_| "Invalid key")?;
        println!("{}", hex(key.public_key().as_ref()));
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("--sign") {
        let payload = fs::read_to_string(args.get(1).ok_or("Manifest path required")?)?;
        let key = ring::signature::Ed25519KeyPair::from_pkcs8(&fs::read(
            args.get(2).ok_or("Private key path required")?,
        )?)
        .map_err(|_| "Invalid signing key")?;
        let envelope = Envelope {
            signature: hex(key.sign(payload.as_bytes()).as_ref()),
            payload,
        };
        fs::write(
            args.get(3).ok_or("Output path required")?,
            serde_json::to_vec(&envelope)?,
        )?;
        return Ok(());
    }
    let key = unhex::<32>(include_str!("../public-key.hex").trim())?;
    if matches!(
        args.first().map(String::as_str),
        Some("--verify" | "--inspect")
    ) {
        let bytes = fs::read(args.get(1).ok_or("Signed metadata path required")?)?;
        let timestamp = if args[0] == "--inspect" {
            let envelope: Envelope = serde_json::from_slice(&bytes)?;
            let m: Manifest = serde_json::from_str(&envelope.payload)?;
            m.issued
        } else {
            now()?
        };
        let manifest = verify(&bytes, &key, timestamp, 0)?;
        println!("{}", serde_json::to_string(&manifest)?);
        return Ok(());
    }
    let exe = std::env::current_exe()?;
    let root = exe.parent().ok_or("No installation directory")?;
    if args.first().map(String::as_str) == Some("--check") {
        return check(root, &key);
    }
    let browser_args = open_target::browser_args(&args)?;
    let installation = root.join("installation.json");
    let installed_config = if installation.exists() {
        Some(components::InstallConfig::read(&installation)?)
    } else {
        None
    };
    let default_data = if installed_config.is_some() {
        std::env::var_os("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .ok_or("LOCALAPPDATA is required for an installed browser")?
            .join("ChroMinimum")
    } else {
        root.to_owned()
    };
    let guard = lock(root)?;
    let selected = select_locked(root, &key)?;
    let runtime = version_dir(root, selected);
    let runtime_lease = lease(&runtime)?;
    drop(guard);
    let mut nonce = [0; 16];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut nonce)
        .map_err(|_| "Random source unavailable")?;
    let started = root.join(format!("core-started-{}", hex(&nonce)));
    let mut command = Command::new(runtime.join("chrominimum.exe"));
    command
        .args(&browser_args)
        .current_dir(&runtime)
        .env(
            "CHROMINIMUM_DATA_DIR",
            std::env::var_os("CHROMINIMUM_DATA_DIR")
                .unwrap_or_else(|| default_data.into_os_string()),
        )
        .env("CHROMINIMUM_LAUNCHER", &exe)
        .env("CHROMINIMUM_CORE_ROOT", root)
        .env("CHROMINIMUM_STARTED", &started)
        .env("CHROMINIMUM_CORE_SEQUENCE", selected.to_string());
    if let Some(config) = installed_config {
        command.env(
            "CHROMINIMUM_INSTALL_LOCALE",
            match config.ui_locale {
                components::Locale::EnUs => "en-US",
                components::Locale::Ru => "ru",
            },
        );
    } else {
        command.env_remove("CHROMINIMUM_INSTALL_LOCALE");
    }
    // No idle launcher process. Only a bounded smoke test waits for its child.
    if args.iter().any(|a| a == "--smoke-test") && !args.iter().any(|a| a == "--launcher-no-wait") {
        let status = command.status()?;
        let _ = fs::remove_file(started);
        std::process::exit(status.code().unwrap_or(1));
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    // Hand off the shared lease before exiting: no deletion race during startup.
    while !started.exists() {
        if child.try_wait()?.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = fs::remove_file(started);
    drop(runtime_lease);
    Ok(())
}

fn launch_components(root: &Path, args: &[String], key: &[u8; 32]) -> Result<()> {
    let (selection, lease, runtime) = component_install::select_for_launch(root, key)?;
    let mut random = [0; 16];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut random)
        .map_err(|_| "Random source unavailable")?;
    let ready = hex(&random);
    let locale = match selection.ui_locale {
        components::Locale::EnUs => "en-US",
        components::Locale::Ru => "ru",
    };
    let mut child = Command::new(runtime.join("chrominimum.exe"))
        .args(args)
        .current_dir(&runtime)
        .env(
            "CHROMINIMUM_DATA_DIR",
            std::env::var_os("CHROMINIMUM_DATA_DIR").unwrap_or_else(|| root.as_os_str().to_owned()),
        )
        .env("CHROMINIMUM_LAUNCHER", std::env::current_exe()?)
        .env("CHROMINIMUM_CORE_ROOT", root)
        .env("CHROMINIMUM_COMPONENT_ID", &selection.id)
        .env("CHROMINIMUM_COMPONENT_LOCALE", locale)
        .env("CHROMINIMUM_COMPONENT_READY", &ready)
        .env_remove("CHROMINIMUM_CORE_SEQUENCE")
        .env_remove("CHROMINIMUM_STARTED")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Component readiness pipe unavailable")?;
    let expected = format!("component-ready {} {ready}", selection.id);
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        let found = BufReader::new(stdout.take(8192))
            .lines()
            .any(|line| line.is_ok_and(|s| s == expected));
        let _ = sender.send(found);
    });
    if !receiver
        .recv_timeout(Duration::from_secs(60))
        .unwrap_or(false)
    {
        return Err("Component browser did not confirm page readiness".into());
    }
    if let Some(token) = selection.trial_token {
        component_install::confirm(root, &selection.id, &token, key)?;
    }
    // The browser acquired its own runtime lease before it reported readiness.
    drop(lease);
    if args.iter().any(|a| a == "--smoke-test") {
        let status = child.wait()?;
        if !status.success() {
            return Err("Component browser smoke failed".into());
        }
    }
    Ok(())
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .https_only(true)
        .timeout_global(Some(Duration::from_secs(600)))
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        .build()
        .into()
}

fn check(root: &Path, key: &[u8; 32]) -> Result<()> {
    println!("checking");
    let state = {
        let _guard = lock(root)?;
        read_state(root)?
    };
    let channel = update_channel(root, &state)?;
    let agent = agent();
    let mut bytes = Vec::new();
    agent
        .get(channel)
        .call()?
        .into_body()
        .into_reader()
        .take(MAX_MANIFEST + 1)
        .read_to_end(&mut bytes)?;
    let state = {
        let _guard = lock(root)?;
        read_state(root)?
    };
    let manifest = verify(&bytes, key, now()?, state.highest)?;
    require_compatible_media(root, &state, &manifest)?;
    if manifest.sequence <= state.highest || state.pending.is_some() {
        println!(
            "{}",
            if state.pending.is_some() {
                "ready"
            } else {
                "current"
            }
        );
        atomic_write(&root.join("core-last-check"), now()?.to_string().as_bytes())?;
        return Ok(());
    }
    println!("downloading");
    // A unique download file avoids touching the running core or user data.
    let download = root.join(format!("core-download-{}.tmp", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&download)?;
    let result = (|| -> Result<()> {
        let mut response = agent
            .get(&manifest.url)
            .call()?
            .into_body()
            .into_reader()
            .take(manifest.size + 1);
        let length = std::io::copy(&mut response, &mut file)?;
        file.sync_all()?;
        if length != manifest.size {
            return Err("Downloaded package length mismatch".into());
        }
        println!("verifying");
        install(root, &bytes, &download, key, now()?)?;
        // Pruning is best-effort; an old core still running is left untouched.
        let _ = prune(root, key);
        atomic_write(&root.join("core-last-check"), now()?.to_string().as_bytes())?;
        println!("ready");
        Ok(())
    })();
    drop(file);
    let _ = fs::remove_file(download);
    result
}
