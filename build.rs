fn main() {
    println!("cargo:rerun-if-changed=src/engine_loader_win.cc");
    #[cfg(target_os = "windows")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let cef_dir = std::env::var("DEP_CEF_DLL_WRAPPER_CEF_DIR").expect("CEF headers");
        let api = std::env::var("DEP_CEF_DLL_WRAPPER_CEF_API_VERSION").expect("stable CEF API");
        cc::Build::new()
            .cpp(true)
            // Match the CEF wrapper's MultiThreaded C++ runtime.
            .static_crt(true)
            .flag("/std:c++17")
            .define("CEF_API_VERSION", api.as_str())
            .include(cef_dir)
            .file("src/engine_loader_win.cc")
            .compile("cm_engine_loader");
        // No libcef code may run before the official loader verifies it.
        println!("cargo:rustc-cdylib-link-arg=/DELAYLOAD:libcef.dll");
        println!("cargo:rustc-link-lib=wintrust");
        println!("cargo:rustc-link-lib=crypt32");
    }
}
