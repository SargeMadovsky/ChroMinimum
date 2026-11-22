//! Address bar input: what the user typed → the URL to load. Pure functions;
//! the shell owns navigation, focus and fallback state.
use std::net::IpAddr;

#[derive(Debug, PartialEq, Eq)]
pub struct Typed {
    pub url: String,
    /// Plain-HTTP retry for an address typed without a scheme. Only used after
    /// a connection-level failure, never after a certificate error.
    pub http_fallback: Option<String>,
}

pub fn resolve(text: &str, external: impl FnOnce(&str) -> bool) -> Option<Typed> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let exact = |url: String| {
        Some(Typed {
            url,
            http_fallback: None,
        })
    };
    if let Some(url) = file_url(text) {
        return exact(url);
    }
    let hierarchical = crate::external_protocol::scheme(text)
        .is_some_and(|s| s.len() > 1 && text[s.len() + 1..].starts_with("//"));
    if hierarchical
        || text
            .get(..6)
            .is_some_and(|p| p.eq_ignore_ascii_case("about:"))
        || external(text)
    {
        return exact(text.to_owned());
    }
    if is_local_host(&host_of(text)) {
        // Routers, NAS and dev servers usually have no HTTPS listener.
        exact(format!("http://{text}"))
    } else {
        Some(Typed {
            url: format!("https://{text}"),
            http_fallback: Some(format!("http://{text}")),
        })
    }
}

/// Connection-level failures after which a typed HTTPS guess is retried over
/// HTTP. Certificate errors (-200..=-299) stay on Chromium's error page.
pub fn falls_back_to_http(net_error: i32) -> bool {
    matches!(
        net_error,
        -7 // TIMED_OUT
            | -100 // CONNECTION_CLOSED
            | -101 // CONNECTION_RESET
            | -102 // CONNECTION_REFUSED
            | -104 // CONNECTION_FAILED
            | -107 // SSL_PROTOCOL_ERROR (plain HTTP answered the handshake)
            | -109 // ADDRESS_UNREACHABLE
            | -113 // SSL_VERSION_OR_CIPHER_MISMATCH
            | -118 // CONNECTION_TIMED_OUT
            | -324 // EMPTY_RESPONSE
    )
}

/// Text for the address field: an empty start page shows the placeholder.
pub fn display(url: &str) -> &str {
    if url == "about:blank" { "" } else { url }
}

fn file_url(text: &str) -> Option<String> {
    let b = text.as_bytes();
    let drive =
        b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/');
    let unc = text.len() > 2 && text.starts_with("\\\\");
    let posix =
        cfg!(not(target_os = "windows")) && text.starts_with('/') && !text.starts_with("//");
    if !drive && !unc && !posix {
        return None;
    }
    let mut url = String::from(if drive {
        "file:///"
    } else if unc {
        "file:"
    } else {
        "file://"
    });
    for ch in text.chars() {
        match ch {
            '\\' => url.push('/'),
            '%' => url.push_str("%25"),
            ' ' => url.push_str("%20"),
            '#' => url.push_str("%23"),
            '?' => url.push_str("%3F"),
            _ => url.push(ch),
        }
    }
    Some(url)
}

fn host_of(text: &str) -> String {
    let authority = text.split(['/', '?', '#', '\\']).next().unwrap_or_default();
    let authority = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = match authority.strip_prefix('[') {
        Some(ipv6) => ipv6.split(']').next().unwrap_or_default(),
        None => authority.split(':').next().unwrap_or_default(),
    };
    host.trim_end_matches('.').to_ascii_lowercase()
}

fn is_local_host(host: &str) -> bool {
    if host.is_empty() {
        return false;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(ip) => {
                let [a, b, ..] = ip.octets();
                ip.is_loopback()
                    || ip.is_private()
                    || ip.is_link_local()
                    || ip.is_unspecified()
                    || (a == 100 && b & 0xc0 == 64) // carrier-grade NAT
            }
            IpAddr::V6(ip) => {
                ip.is_loopback()
                    || ip.is_unspecified()
                    || ip.is_unique_local()
                    || ip.is_unicast_link_local()
            }
        };
    }
    // Single-label intranet names and reserved non-public suffixes.
    !host.contains('.')
        || [
            "localhost",
            "local",
            "lan",
            "internal",
            "home.arpa",
            "localdomain",
            "test",
        ]
        .iter()
        .any(|suffix| {
            host.strip_suffix(suffix)
                .is_some_and(|rest| rest.ends_with('.'))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> (String, Option<String>) {
        let typed = resolve(text, |t| {
            crate::external_protocol::address_is_external(t, |_| false)
        })
        .unwrap();
        (typed.url, typed.http_fallback)
    }

    #[test]
    fn public_names_try_https_then_http() {
        for (text, https, http) in [
            ("example.com", "https://example.com", "http://example.com"),
            (
                "example.com:8443/a?b#c",
                "https://example.com:8443/a?b#c",
                "http://example.com:8443/a?b#c",
            ),
            (
                "пример.рф/путь",
                "https://пример.рф/путь",
                "http://пример.рф/путь",
            ),
            ("8.8.8.8", "https://8.8.8.8", "http://8.8.8.8"),
            (
                "  example.com  ",
                "https://example.com",
                "http://example.com",
            ),
        ] {
            assert_eq!(
                url(text),
                (https.to_owned(), Some(http.to_owned())),
                "{text}"
            );
        }
    }

    #[test]
    fn local_hosts_use_plain_http() {
        for text in [
            "localhost",
            "localhost:3000/app",
            "app.localhost:8080",
            "127.0.0.1:8000",
            "192.168.1.1",
            "10.0.0.138/login",
            "172.16.4.2",
            "169.254.1.1",
            "100.64.0.1",
            "[::1]:8080/x",
            "[fd00::1]",
            "[fe80::1]",
            "router",
            "nas:5000",
            "printer.local",
            "Router.LAN.",
            "box.home.arpa",
            "svc.internal",
            "site.test",
            "user@192.168.0.1",
        ] {
            let (resolved, fallback) = url(text);
            assert_eq!(resolved, format!("http://{}", text.trim()), "{text}");
            assert_eq!(fallback, None, "{text}");
        }
        for text in [
            "172.32.0.1",
            "100.128.0.1",
            "notlocal.com",
            "localhost.example.com",
            "mylan.com",
        ] {
            assert!(url(text).0.starts_with("https://"), "{text}");
        }
    }

    #[test]
    fn explicit_urls_are_kept() {
        for text in [
            "http://192.168.1.1",
            "https://example.com",
            "HTTP://example.com",
            "chrome://downloads/",
            "file:///C:/x.pdf",
            "about:blank",
            "ABOUT:version",
            "tg://join?invite=x",
            "mailto:a@example.invalid",
        ] {
            assert_eq!(url(text), (text.to_owned(), None), "{text}");
        }
        // "://" in a query is not a scheme.
        assert_eq!(
            url("localhost:3000/?next=http://x").0,
            "http://localhost:3000/?next=http://x"
        );
        assert_eq!(resolve("   ", |_| false), None);
    }

    #[test]
    fn typed_paths_open_as_files() {
        for (text, expected) in [
            ("C:\\Docs\\file.pdf", "file:///C:/Docs/file.pdf"),
            (
                "d:/My Files/a#1?.html",
                "file:///d:/My%20Files/a%231%3F.html",
            ),
            ("C:\\100%\\отчёт.pdf", "file:///C:/100%25/отчёт.pdf"),
            (
                "\\\\server\\share\\a b.txt",
                "file://server/share/a%20b.txt",
            ),
        ] {
            assert_eq!(url(text), (expected.to_owned(), None), "{text}");
        }
        assert!(
            !url("c:").0.starts_with("file:"),
            "a bare drive letter is not a path"
        );
    }

    #[test]
    fn fallback_never_follows_certificate_errors() {
        assert!(falls_back_to_http(-102) && falls_back_to_http(-107) && falls_back_to_http(-118));
        for code in [-3, -105, -200, -202, -207, -299, -310, 0] {
            assert!(!falls_back_to_http(code), "{code}");
        }
    }

    #[test]
    fn blank_page_shows_placeholder() {
        assert_eq!(display("about:blank"), "");
        assert_eq!(display("https://example.com/"), "https://example.com/");
    }
}
