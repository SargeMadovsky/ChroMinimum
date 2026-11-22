//! The UI and its lifetime are owned by Chromium PageInfo, not a Rust overlay.
use crate::{Nav, smoke_event};
use cef::*;

pub const ANCHOR_VIEW_ID: i32 = 0x434d5301;
const SHOW_SECURITY: i32 = 0x434d5302;
const INSPECT_SECURITY: i32 = 0x434d5303;

pub fn toggle(nav: &Nav) {
    let browser = nav.borrow().browser.clone();
    let Some(host) = browser.and_then(|b| b.host()) else {
        return;
    };
    if host.can_execute_chrome_command(SHOW_SECURITY) == 0 {
        smoke_event("native_security_panel_unavailable");
        return;
    }
    // PageInfo owns focus/activation. Forcing page focus here would dismiss an
    // existing bubble before the native toggle command can close it.
    host.execute_chrome_command(SHOW_SECURITY, WindowOpenDisposition::CURRENT_TAB);
    smoke_event("native_security_panel_command_sent");
}

pub fn inspect(nav: &Nav) {
    let browser = nav.borrow().browser.clone();
    if let Some(host) = browser.and_then(|b| b.host())
        && host.can_execute_chrome_command(INSPECT_SECURITY) != 0
    {
        host.execute_chrome_command(INSPECT_SECURITY, WindowOpenDisposition::CURRENT_TAB);
    }
}
