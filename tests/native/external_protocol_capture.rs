//! Disposable OS protocol handler; never executes a supplied command.
#![windows_subsystem = "windows"]
use std::{fs::OpenOptions, io::Write};
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        std::process::exit(2);
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&args[0])
        .unwrap();
    writeln!(file, "{}", args[1]).unwrap();
}
