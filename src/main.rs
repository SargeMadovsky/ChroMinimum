#[cfg(not(target_os = "windows"))]
fn main() {
    std::process::exit(chrominimum::main_process());
}

#[cfg(target_os = "windows")]
fn main() {
    eprintln!("Launch the bundled chrominimum.exe sandbox bootstrap, not this build target.");
    std::process::exit(1);
}
