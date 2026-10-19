#[cfg(target_os = "macos")]
fn main() {
    use cef::*;
    let args = args::Args::new();
    let mut sandbox = sandbox::Sandbox::new();
    sandbox.initialize(args.as_main_args());
    let loader =
        library_loader::LibraryLoader::new(&std::env::current_exe().expect("executable"), true);
    assert!(loader.load(), "Cannot load bundled CEF framework");
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    let code = execute_process(
        Some(args.as_main_args()),
        None::<&mut App>,
        std::ptr::null_mut(),
    );
    // Let the framework loader and sandbox context tear down normally.
    drop(loader);
    drop(sandbox);
    std::process::exit(code.max(0));
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("This helper is only used inside a macOS app bundle.");
    std::process::exit(1);
}
