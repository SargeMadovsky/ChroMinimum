//! Explicit shell file target. Never interpret a filename as browser switches.
use crate::Result;
use std::path::Path;

pub fn file_url(path: &Path) -> Result<String> {
    if !path.is_file()
        || !path.extension().and_then(|s| s.to_str()).is_some_and(|s| {
            ["html", "htm", "pdf"]
                .iter()
                .any(|allowed| s.eq_ignore_ascii_case(allowed))
        })
    {
        return Err("Select an existing HTML or PDF file".into());
    }
    let full = path.canonicalize()?;
    let text = full.to_str().ok_or("File path is not Unicode")?;
    #[cfg(windows)]
    let text = text
        .strip_prefix(r"\\?\UNC\")
        .map(|s| format!(r"\\{s}"))
        .unwrap_or_else(|| text.strip_prefix(r"\\?\").unwrap_or(text).to_owned());
    #[cfg(not(windows))]
    let text = text.to_owned();
    let text = text.replace('\\', "/");
    let prefix = if text.starts_with("//") {
        "file:"
    } else if text.starts_with('/') {
        "file://"
    } else {
        "file:///"
    };
    let mut url = prefix.to_owned();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"/-._~:".contains(&byte) {
            url.push(byte as char);
        } else {
            use std::fmt::Write;
            write!(url, "%{byte:02X}")?;
        }
    }
    Ok(url)
}

pub fn browser_args(args: &[String]) -> Result<Vec<String>> {
    let Some(index) = args.iter().position(|arg| arg == "--open") else {
        return Ok(args.to_vec());
    };
    if args.iter().filter(|arg| arg.as_str() == "--open").count() != 1
        || args
            .iter()
            .any(|arg| arg == "--url" || arg.starts_with("--url="))
    {
        return Err("Pass one file target without --url".into());
    }
    let path = args.get(index + 1).ok_or("File target missing")?;
    let url = file_url(Path::new(path))?;
    let mut result = args[..index].to_vec();
    result.push(format!("--url={url}"));
    result.extend_from_slice(&args[index + 2..]);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shell_file_is_encoded_and_never_becomes_switches() {
        let dir = std::env::temp_dir().join(format!("cm-open-file-{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("Файл #100% --test.HTML");
        std::fs::write(&file, b"test").unwrap();
        let args = browser_args(&[
            "--smoke-test".into(),
            "--open".into(),
            file.to_str().unwrap().into(),
        ])
        .unwrap();
        assert_eq!(args.len(), 2);
        assert!(args[1].starts_with("--url=file:///"));
        assert!(args[1].ends_with("%D0%A4%D0%B0%D0%B9%D0%BB%20%23100%25%20--test.HTML"));
        assert!(browser_args(&["--open".into()]).is_err());
        assert!(
            browser_args(&[
                "--open".into(),
                file.to_str().unwrap().into(),
                "--url=about:blank".into()
            ])
            .is_err()
        );
        let bad = dir.join("bad.exe");
        std::fs::write(&bad, b"test").unwrap();
        assert!(file_url(&bad).is_err());
        std::fs::remove_file(file).unwrap();
        std::fs::remove_file(bad).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
