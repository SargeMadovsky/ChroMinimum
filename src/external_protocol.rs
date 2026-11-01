//! URL classification and escaping; consent and OS dispatch stay in Chromium.
pub fn scheme(url: &str) -> Option<&str> {
    let (scheme, _) = url.split_once(':')?;
    let mut bytes = scheme.bytes();
    if !bytes.next()?.is_ascii_alphabetic()
        || !bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
    {
        return None;
    }
    Some(scheme)
}

pub fn is_external(url: &str) -> bool {
    let Some(scheme) = scheme(url) else {
        return false;
    };
    // A drive path must never reach ShellExecute as an external URL.
    if scheme.len() == 1 {
        return false;
    }
    ![
        "http",
        "https",
        "file",
        "ws",
        "wss",
        "about",
        "blob",
        "data",
        "javascript",
        "chrome",
        "chrome-untrusted",
        "chrome-extension",
        "devtools",
        "view-source",
        "filesystem",
        "chrome-search",
        "chrome-distiller",
        "isolated-app",
    ]
    .iter()
    .any(|s| scheme.eq_ignore_ascii_case(s))
}

pub fn address_is_external(text: &str, registered: impl FnOnce(&str) -> bool) -> bool {
    if !is_external(text) {
        return false;
    }
    // A numeric payload can also be a host:port. Prefer the OS association
    // when one exists; preserve the old HTTPS default for unregistered names.
    if let Some((scheme, rest)) = text.split_once(':') {
        let port = rest.split(['/', '?', '#']).next().unwrap_or_default();
        if !port.is_empty()
            && port.bytes().all(|b| b.is_ascii_digit())
            && port.parse::<u16>().is_ok()
        {
            return registered(scheme);
        }
    }
    true
}

pub fn renderer_navigation(url: &str, source_url: &str) -> String {
    use std::fmt::Write;
    let escape = |value: &str| {
        let mut encoded = String::new();
        for unit in value.encode_utf16() {
            write!(&mut encoded, "\\u{unit:04x}").expect("writing to String");
        }
        encoded
    };
    // Recheck in the receiving document too: it can navigate after the UI
    // thread's check but before ExecuteJavaScript arrives. Ignore hash-only
    // changes, without calling page-overridable String/URL helper functions.
    let source = escape(without_fragment(source_url));
    let mut code = format!(
        "(()=>{{const u=window.location.href,s=\"{source}\";let ok=u.length>=s.length&&(u.length===s.length||u[s.length]===\"#\");for(let i=0;ok&&i<s.length;i++)ok=u[i]===s[i];if(ok)window.location.href=\""
    );
    code.push_str(&escape(url));
    code.push_str("\";})();");
    code
}

pub fn without_fragment(url: &str) -> &str {
    url.split('#').next().unwrap_or(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn external_schemes_are_not_an_application_allowlist() {
        for url in [
            "tg://join?invite=test",
            "steam://launch/1891700/Dialog",
            "mailto:a@example.invalid",
            "custom+v2.test:payload",
            "ftp://example.invalid/file",
            "custom-protocol:path\\segment",
        ] {
            assert!(is_external(url), "{url}");
        }
        for url in [
            "https://example.invalid",
            "JaVaScRiPt:alert(1)",
            "file:///C:/test",
            "chrome://settings",
            "data:text/plain,x",
            "blob:https://example.invalid/x",
            "x:\nmalformed",
            "1bad:payload",
            "noscheme",
            "C:/Windows/test.exe",
            "C:\\Windows\\test.exe",
        ] {
            assert!(!is_external(url), "{url}");
        }
    }
    #[test]
    fn address_keeps_host_ports() {
        let registered = |s: &str| matches!(s, "tel" | "custom-protocol" | "custom.app");
        for address in [
            "localhost:8080/test",
            "example.invalid:443",
            "devserver:8080/test",
            "devserver:8080?value=1",
            "devserver:8080#anchor",
        ] {
            assert!(!address_is_external(address, registered), "{address}");
        }
        for address in [
            "steam://launch/1891700/Dialog",
            "mailto:a@example.invalid",
            "tel:12345",
            "custom-protocol:42",
            "custom.app:42",
            "unknown-protocol:12345678901",
        ] {
            assert!(address_is_external(address, registered), "{address}");
        }
    }
    #[test]
    fn url_cannot_escape_navigation_literal() {
        let code = renderer_navigation(
            "custom://x/\";alert(1)//\n\\\u{2028}😀",
            "https://example.invalid/\";attack()#hash",
        );
        let body = code
            .split("if(ok)window.location.href=\"")
            .nth(1)
            .unwrap()
            .strip_suffix("\";})();")
            .unwrap();
        assert!(body.as_bytes().chunks(6).all(|c| c.len() == 6
            && &c[..2] == b"\\u"
            && c[2..].iter().all(u8::is_ascii_hexdigit)));
        assert!(body.contains("\\ud83d\\ude00"));
        assert!(!code.contains("alert(1)"));
        assert!(!code.contains("attack()"));
        assert_eq!(
            without_fragment("https://example.invalid/a%23b#fragment"),
            "https://example.invalid/a%23b"
        );
    }
}
