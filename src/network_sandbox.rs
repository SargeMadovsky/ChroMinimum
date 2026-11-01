//! Windows policy: network isolation is mandatory, not a field-trial default.
fn is_network_feature(feature: &str) -> bool {
    feature.split(['<', ':']).next() == Some("NetworkServiceSandbox")
}

pub fn enforce_features(enabled: &str, disabled: &str) -> (String, String) {
    let without_network = |list: &str| -> Vec<String> {
        list.split(',')
            .filter(|s| !s.is_empty() && !is_network_feature(s))
            .map(str::to_owned)
            .collect()
    };
    let mut enabled = without_network(enabled);
    enabled.push("NetworkServiceSandbox".into());
    (enabled.join(","), without_network(disabled).join(","))
}

pub fn refuse_network_launch(subtype: &str, sandbox: &str) -> bool {
    subtype == "network.mojom.NetworkService" && sandbox != "network"
}

fn platform_supported(major: u32, build: u32, native_machine: u16) -> bool {
    major >= 10 && build >= 19041 && native_machine == 0x8664
}

#[cfg(windows)]
pub fn terminate_refused_network() -> ! {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn TerminateProcess(process: *mut std::ffi::c_void, code: u32) -> i32;
        fn ExitProcess(code: u32) -> !;
    }
    // Do not run CEF/CRT at-exit handlers from its launch callback: CEF has
    // not shut down, and those handlers can turn a controlled refusal into fail-fast.
    unsafe {
        TerminateProcess((-1_isize) as *mut _, 1);
        ExitProcess(1);
    }
}

#[cfg(windows)]
pub fn supported() -> bool {
    #[repr(C)]
    struct Version {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        service_pack: [u16; 128],
    }
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn RtlGetVersion(info: *mut Version) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn IsWow64Process2(
            process: *mut std::ffi::c_void,
            process_machine: *mut u16,
            native_machine: *mut u16,
        ) -> i32;
    }
    let mut version = Version {
        size: std::mem::size_of::<Version>() as u32,
        major: 0,
        minor: 0,
        build: 0,
        platform: 0,
        service_pack: [0; 128],
    };
    let mut process_machine = 0;
    let mut native_machine = 0;
    // Pseudo handle for this process; all queries are read-only.
    unsafe {
        RtlGetVersion(&mut version) == 0
            && IsWow64Process2(
                (-1_isize) as *mut _,
                &mut process_machine,
                &mut native_machine,
            ) != 0
            && platform_supported(version.major, version.build, native_machine)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mandatory_feature_preserves_unrelated_settings_and_is_idempotent() {
        let result = enforce_features(
            "Other,NetworkServiceSandbox<Trial:param/value",
            "OtherDisabled,NetworkServiceSandbox,NetworkServiceSandboxOther",
        );
        assert_eq!(result.0, "Other,NetworkServiceSandbox");
        assert_eq!(result.1, "OtherDisabled,NetworkServiceSandboxOther");
        assert_eq!(enforce_features(&result.0, &result.1), result);
        assert_eq!(
            enforce_features("", "NetworkServiceSandbox:group"),
            ("NetworkServiceSandbox".into(), String::new())
        );
    }
    #[test]
    fn network_fallback_is_refused_without_affecting_other_services() {
        assert!(!refuse_network_launch(
            "network.mojom.NetworkService",
            "network"
        ));
        for mode in ["none", "", "service"] {
            assert!(refuse_network_launch("network.mojom.NetworkService", mode));
        }
        assert!(!refuse_network_launch(
            "storage.mojom.StorageService",
            "service"
        ));
    }
    #[test]
    fn unsupported_windows_and_arm_emulation_do_not_silently_lose_network_sandbox() {
        assert!(platform_supported(10, 19041, 0x8664));
        assert!(!platform_supported(10, 19040, 0x8664));
        assert!(!platform_supported(6, 19045, 0x8664));
        assert!(!platform_supported(10, 26100, 0xAA64));
    }
    #[cfg(windows)]
    #[test]
    fn current_windows_host_supports_required_network_sandbox() {
        assert!(supported());
    }
}
