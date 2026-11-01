use cm_update::components::{Component, InstallConfig, Locale};

#[test]
fn russian_choice_keeps_fallback_and_core_without_extra_modules() {
    let config =
        InstallConfig::parse(br#"{"format":1,"ui_locale":"ru","locales":["ru"]}"#).unwrap();
    let plan = config.plan().unwrap();
    assert_eq!(plan.ui_locale, Locale::Ru);
    assert_eq!(
        plan.components,
        vec![
            Component::Core {},
            Component::Locale {
                locale: Locale::EnUs
            },
            Component::Locale { locale: Locale::Ru }
        ]
    );
}

#[test]
fn english_choice_does_not_pull_russian() {
    let config =
        InstallConfig::parse(br#"{"format":1,"ui_locale":"en-US","locales":["en-US"]}"#).unwrap();
    assert_eq!(
        config.plan().unwrap().components,
        vec![
            Component::Core {},
            Component::Locale {
                locale: Locale::EnUs
            }
        ]
    );
}

#[test]
fn invalid_configuration_never_silently_changes_selection() {
    for invalid in [
        r#"{"format":2,"ui_locale":"ru","locales":["ru"]}"#,
        r#"{"format":1,"ui_locale":"ru","locales":["en-US"]}"#,
        r#"{"format":1,"ui_locale":"ru","locales":["ru","ru"]}"#,
        r#"{"format":1,"ui_locale":"ru","locales":["../ru"]}"#,
        r#"{"format":1,"ui_locale":"de","locales":["de"]}"#,
        r#"{"format":1,"ui_locale":"ru","locales":["ru"],"accessibility":false}"#,
        r#"{"format":1,"format":1,"ui_locale":"ru","locales":["ru"]}"#,
        r#"{"format":1,"ui_locale":"ru","locales":[]}"#,
    ] {
        assert!(
            InstallConfig::parse(invalid.as_bytes()).is_err(),
            "{invalid}"
        );
    }
    assert!(InstallConfig::parse(&vec![b' '; 4097]).is_err());
}
