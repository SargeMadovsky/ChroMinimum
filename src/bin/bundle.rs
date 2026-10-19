fn main() {
    #[cfg(target_os = "windows")]
    if std::env::args().nth(1).as_deref() == Some("--icon") {
        let file = std::env::args_os().nth(2).expect("executable path");
        set_icon(std::path::Path::new(&file)).expect("icon update");
        return;
    }
    let output = std::env::args_os()
        .nth(1)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_dir()
                .expect("working directory")
                .join(if cfg!(debug_assertions) {
                    "target/bundle"
                } else {
                    "target/release-bundle"
                })
        });
    let target = std::env::current_exe().expect("bundle helper path");
    let target = target.parent().expect("target directory");
    match platform_bundle(&output, target) {
        Ok(executable) => {
            #[cfg(target_os = "windows")]
            if let Err(error) = set_icon(&executable) {
                eprintln!("Icon packaging failed: {error}");
                std::process::exit(1);
            }
            println!("Browser: {}", executable.display());
        }
        Err(error) => {
            eprintln!("Bundle failed: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(target_os = "windows")]
fn platform_bundle(
    output: &std::path::Path,
    target: &std::path::Path,
) -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    let runtime = output.join("core/seed");
    let executable = cef::build_util::win::bundle(&runtime, target, "chrominimum")?;
    set_icon(&executable)?;
    let launcher = std::env::current_dir()?.join("updater/target/release/cm-update.exe");
    let output_exe = output.join("chrominimum.exe");
    std::fs::copy(launcher, &output_exe)?;
    Ok(output_exe)
}

#[cfg(target_os = "linux")]
fn platform_bundle(
    output: &std::path::Path,
    target: &std::path::Path,
) -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    let executable = cef::build_util::linux::bundle(output, target, "chrominimum")?;
    std::fs::write(
        output.join("run.sh"),
        "#!/bin/sh\nset -eu\ncd -- \"$(dirname -- \"$0\")\"\nexport LD_LIBRARY_PATH=\"$PWD${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}\"\nexec ./chrominimum \"$@\"\n",
    )?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(
        output.join("run.sh"),
        std::fs::Permissions::from_mode(0o755),
    )?;
    Ok(executable)
}

#[cfg(target_os = "macos")]
fn platform_bundle(
    output: &std::path::Path,
    target: &std::path::Path,
) -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    let info = cef::build_util::mac::BundleInfo::new(
        "chrominimum",
        "io.github.sargemadovsky.chrominimum",
        "ChroMinimum",
        "English",
        semver::Version::parse(env!("CARGO_PKG_VERSION"))?,
    );
    let bundle = cef::build_util::mac::bundle(
        output,
        target,
        "chrominimum",
        "chrominimum_helper",
        None,
        info,
    )?;
    let cef_dir =
        cef::sys::get_cef_dir().ok_or_else(|| std::io::Error::other("CEF directory missing"))?;
    std::fs::copy(cef_dir.join("CREDITS.html"), output.join("CREDITS.html"))?;
    Ok(bundle)
}

#[cfg(target_os = "windows")]
fn set_icon(executable: &std::path::Path) -> std::io::Result<()> {
    use windows_sys::Win32::System::LibraryLoader::{
        BeginUpdateResourceW, EndUpdateResourceW, UpdateResourceW,
    };
    let ico = include_bytes!("../../assets/chrominimum.ico");
    let count = u16::from_le_bytes([ico[4], ico[5]]) as usize;
    let path: Vec<u16> = executable
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // Update only icon resources in the copied bootstrap; preserve its sandbox
    // implementation, manifest and all other resources.
    let handle = unsafe { BeginUpdateResourceW(path.as_ptr(), 0) };
    if handle.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    let result = (|| {
        let mut group = ico[..6].to_vec();
        for index in 0..count {
            let entry = &ico[6 + index * 16..6 + (index + 1) * 16];
            let size = u32::from_le_bytes(entry[8..12].try_into().unwrap()) as usize;
            let offset = u32::from_le_bytes(entry[12..16].try_into().unwrap()) as usize;
            let image = &ico[offset..offset + size];
            let id = index + 1;
            if unsafe {
                UpdateResourceW(
                    handle,
                    3usize as _,
                    id as _,
                    0,
                    image.as_ptr().cast(),
                    size as u32,
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            group.extend_from_slice(&entry[..12]);
            group.extend_from_slice(&(id as u16).to_le_bytes());
        }
        if unsafe {
            UpdateResourceW(
                handle,
                14usize as _,
                1usize as _,
                0,
                group.as_ptr().cast(),
                group.len() as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    })();
    let finished = unsafe { EndUpdateResourceW(handle, i32::from(result.is_err())) };
    result?;
    if finished == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;
