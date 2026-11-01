//! Strict parsing of the existing window-size file, independent of CEF.

pub fn parse(value: &str) -> Option<(i32, i32, bool)> {
    let mut fields = value.split_whitespace();
    let width = fields.next()?.parse::<i32>().ok()?;
    let height = fields.next()?.parse::<i32>().ok()?;
    if !(640..=10_000).contains(&width) || !(360..=10_000).contains(&height) {
        return None;
    }
    let maximized = match fields.next() {
        None | Some("normal") => false,
        Some("maximized") => true,
        Some(_) => return None,
    };
    if fields.next().is_some() {
        return None;
    }
    Some((width, height, maximized))
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn legacy_and_current_records_are_supported() {
        assert_eq!(parse("920 680"), Some((920, 680, false)));
        assert_eq!(parse("920 680 normal\n"), Some((920, 680, false)));
        assert_eq!(parse("920 680 maximized\r\n"), Some((920, 680, true)));
        assert_eq!(parse("  920\t680  normal  "), Some((920, 680, false)));
    }

    #[test]
    fn corrupt_records_are_not_partially_restored() {
        for value in [
            "",
            "920",
            "broken 920 680",
            "920 broken 680",
            "920 680 unknown",
            "920 680 normal extra",
            "broken broken maximized",
            "920 680 123",
            "920 680 maximized normal",
            "920.5 680 normal",
            "2147483648 680",
        ] {
            assert_eq!(parse(value), None, "{value:?}");
        }
    }

    #[test]
    fn dimensions_obey_existing_limits() {
        assert_eq!(parse("640 360 maximized"), Some((640, 360, true)));
        assert_eq!(parse("10000 10000"), Some((10000, 10000, false)));
        for value in [
            "639 360",
            "640 359",
            "10001 760",
            "1100 10001",
            "-920 680",
            "0 0",
        ] {
            assert_eq!(parse(value), None, "{value:?}");
        }
    }
}
