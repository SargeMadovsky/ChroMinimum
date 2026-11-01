//! Feature-list policy for the explicitly built Windows platform-codec variant.
//! This does not assert that an arbitrary CEF binary implements the feature.
const FEATURE: &str = "ChroMinimumPlatformAudioFirst";

pub fn enforce_features(enabled: &str, disabled: &str) -> (String, String) {
    let without_feature = |list: &str| -> Vec<String> {
        list.split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .filter(|value| value.split(['<', ':']).next() != Some(FEATURE))
            .map(str::to_owned)
            .collect()
    };
    let mut enabled = without_feature(enabled);
    enabled.push(FEATURE.to_owned());
    (enabled.join(","), without_feature(disabled).join(","))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn media_variant_enables_platform_path_without_test_arguments() {
        assert_eq!(enforce_features("", ""), (FEATURE.into(), String::new()));
    }
    #[test]
    fn removes_conflicting_feature_overrides_and_is_idempotent() {
        let result = enforce_features(
            "Other,ChroMinimumPlatformAudioFirst<Trial:param/value,ChroMinimumPlatformAudioFirst",
            "Disabled,ChroMinimumPlatformAudioFirst:group,ChroMinimumPlatformAudioFirstOther",
        );
        assert_eq!(result.0, "Other,ChroMinimumPlatformAudioFirst");
        assert_eq!(result.1, "Disabled,ChroMinimumPlatformAudioFirstOther");
        assert_eq!(enforce_features(&result.0, &result.1), result);
    }
    #[test]
    fn preserves_network_isolation_feature_and_other_disabled_policies() {
        assert_eq!(
            enforce_features(
                "NetworkServiceSandbox",
                "AimEnabled,AutofillServerCommunication"
            ),
            (
                "NetworkServiceSandbox,ChroMinimumPlatformAudioFirst".into(),
                "AimEnabled,AutofillServerCommunication".into()
            )
        );
    }
}
