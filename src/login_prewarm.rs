//! Opt-in login prewarm (D045). An HKCU Run value starts the launcher with
//! `--prewarm`, which reads the runtime into the OS file cache and exits. The
//! Run value is the setting itself: no other settings store, no service.
use std::path::Path;
use windows_sys::Win32::{Foundation::ERROR_SUCCESS, System::Registry::*};

const VALUE: &str = "ChroMinimum Prewarm";
const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
// Smoke runs use their own keys and never touch the user's autostart.
const TEST_RUN: &str = r"Software\ChroMinimum\SmokeTest\Run";
const TEST_APPROVED: &str = r"Software\ChroMinimum\SmokeTest\StartupApproved";

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

fn keys(test: bool) -> (&'static str, &'static str) {
    if test {
        (TEST_RUN, TEST_APPROVED)
    } else {
        (RUN, APPROVED)
    }
}

fn command(launcher: &Path) -> String {
    format!("\"{}\" --prewarm", launcher.display())
}

/// Our Run value, if present.
fn read_run(key: &str) -> Option<String> {
    let (key, value) = (wide(key), wide(VALUE));
    let mut buffer = [0u16; 1024];
    let mut size = size_of_val(&buffer) as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    (status == ERROR_SUCCESS).then(|| {
        let length = (size as usize / 2).saturating_sub(1);
        String::from_utf16_lossy(&buffer[..length])
    })
}

/// Task Manager's Startup tab records "disabled" as an odd first byte.
fn disabled_by_user(key: &str) -> bool {
    let (key, value) = (wide(key), wide(VALUE));
    let mut data = [0u8; 12];
    let mut size = data.len() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_BINARY,
            std::ptr::null_mut(),
            data.as_mut_ptr().cast(),
            &mut size,
        )
    };
    status == ERROR_SUCCESS && size > 0 && data[0] & 1 == 1
}

/// On only if Windows will start this launcher with `--prewarm` at login.
pub fn enabled(launcher: &Path, test: bool) -> bool {
    let (run, approved) = keys(test);
    read_run(run).is_some_and(|value| value.eq_ignore_ascii_case(&command(launcher)))
        && !disabled_by_user(approved)
}

/// Turning it on also clears a Task Manager "disabled" mark for our value.
pub fn set(launcher: &Path, on: bool, test: bool) -> bool {
    let (run, approved) = keys(test);
    let (run, approved, value) = (wide(run), wide(approved), wide(VALUE));
    unsafe {
        RegDeleteKeyValueW(HKEY_CURRENT_USER, approved.as_ptr(), value.as_ptr());
        if !on {
            let status = RegDeleteKeyValueW(HKEY_CURRENT_USER, run.as_ptr(), value.as_ptr());
            return status == ERROR_SUCCESS || status == 2; // ERROR_FILE_NOT_FOUND
        }
        let data = wide(&command(launcher));
        // Creates the subkey if needed (the smoke key starts absent).
        let status = RegSetKeyValueW(
            HKEY_CURRENT_USER,
            run.as_ptr(),
            value.as_ptr(),
            REG_SZ,
            data.as_ptr().cast(),
            (data.len() * 2) as u32,
        );
        status == ERROR_SUCCESS
    }
}
