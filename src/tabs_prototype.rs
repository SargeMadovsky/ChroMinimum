//! Measurement-only tab prototype (D047). Active only with
//! `--smoke-test --test-tabs-prototype`; release behaviour stays one page per
//! window (D044). No tab strip.
//!
//! Several BrowserViews in one window are not possible in CEF 154 Chrome
//! style: `CefBrowserViewImpl::AddedToWidget` refuses a second one ("Cannot
//! add multiple Chrome style BrowserViews"), and the window stays bound to
//! its first browser even after that view is removed
//! (`ChromeBrowserWidget::GetThemeProfile` prefers its `browser_view()`);
//! a swapped-in page was never created (checked by running).
//!
//! So a tab here is a whole window of a group: background tabs are windows
//! that are never shown, a switch shows the target window over the shown one
//! with the same bounds and hides the shown one. Each window keeps its own
//! toolbar. Ctrl+Tab / Ctrl+Shift+Tab switch, Ctrl+W closes the shown tab;
//! closing the shown window by its frame closes the whole group.

use super::*;

pub const NEXT: i32 = 1004;
pub const PREVIOUS: i32 = 1005;
pub const CLOSE: i32 = 1006;

struct Group {
    windows: Vec<Window>,
    shown: usize,
}

/// How a newly created window joins a group.
pub enum Adopt {
    /// Not a prototype tab: an ordinary window.
    None,
    /// Created for a background tab: never shown.
    Background,
    /// Shown in place of this window, which is hidden after the show.
    Foreground(Window),
}

thread_local! {
    static GROUPS: RefCell<Vec<Group>> = const { RefCell::new(Vec::new()) };
    /// The next AppWindow to be created is a tab of this opener.
    static PENDING: RefCell<Option<(Window, bool)>> = const { RefCell::new(None) };
}

pub fn enabled() -> bool {
    SMOKE_LOG.get().is_some() && std::env::args().any(|a| a == "--test-tabs-prototype")
}

pub fn set_accelerators(window: &Window) {
    window.set_accelerator(NEXT, 9, 0, 1, 0, 1);
    window.set_accelerator(PREVIOUS, 9, 1, 1, 0, 1);
    window.set_accelerator(CLOSE, 87, 0, 1, 0, 1);
}

fn same(a: &Window, b: &Window) -> bool {
    a.is_same(Some(&mut View::from(b))) != 0
}

fn group_of(all: &mut [Group], window: &Window) -> Option<usize> {
    all.iter()
        .position(|g| g.windows.iter().any(|w| same(w, window)))
}

/// Puts `to` exactly where `from` is.
fn place(from: &Window, to: &Window) {
    if from.is_maximized() != 0 {
        to.maximize();
    } else {
        to.set_bounds(Some(&from.bounds()));
    }
}

/// Opens a page as a tab of `opener`'s group.
pub fn add(opener: &Window, url: &str, background: bool) {
    PENDING.with_borrow_mut(|p| *p = Some((opener.clone(), background)));
    open_window_from(url, true, Some(opener.clone()), background);
    PENDING.with_borrow_mut(|p| p.take());
}

/// Called from `on_window_created` before the window is shown.
pub fn adopt(window: &Window) -> Adopt {
    let Some((opener, background)) = PENDING.with_borrow_mut(|p| p.take()) else {
        return Adopt::None;
    };
    let count = GROUPS.with_borrow_mut(|all| {
        let index = match group_of(all, &opener) {
            Some(i) => i,
            None => {
                all.push(Group {
                    windows: vec![opener.clone()],
                    shown: 0,
                });
                all.len() - 1
            }
        };
        let group = &mut all[index];
        let at = group.shown + 1;
        group.windows.insert(at, window.clone());
        if !background {
            group.shown = at;
        }
        group.windows.len()
    });
    place(&opener, window);
    smoke_event(&format!(
        "tab_prototype_added; background={background}; tabs={count}"
    ));
    if background {
        Adopt::Background
    } else {
        Adopt::Foreground(opener)
    }
}

fn show_instead(from: &Window, to: &Window) {
    place(from, to);
    to.show();
    to.activate();
    from.hide();
}

/// Shows the next (or previous) tab. Returns false with fewer than two.
pub fn switch(window: &Window, forward: bool) -> bool {
    let Some((from, to, index, count)) = GROUPS.with_borrow_mut(|all| {
        let index = group_of(all, window)?;
        let group = &mut all[index];
        let n = group.windows.len();
        if n < 2 {
            return None;
        }
        let from = group.windows[group.shown].clone();
        group.shown = if forward {
            (group.shown + 1) % n
        } else {
            (group.shown + n - 1) % n
        };
        Some((from, group.windows[group.shown].clone(), group.shown, n))
    }) else {
        return false;
    };
    show_instead(&from, &to);
    smoke_event(&format!(
        "tab_prototype_switched; index={index}; tabs={count}; at_us={}",
        unix_micros()
    ));
    true
}

/// Closes the shown tab and shows its neighbour.
pub fn close_shown(window: &Window) -> bool {
    let Some((closing, next, count)) = GROUPS.with_borrow_mut(|all| {
        let index = group_of(all, window)?;
        let group = &mut all[index];
        if group.windows.len() < 2 {
            return None;
        }
        let closing = group.windows.remove(group.shown);
        group.shown = group.shown.min(group.windows.len() - 1);
        Some((
            closing,
            group.windows[group.shown].clone(),
            group.windows.len(),
        ))
    }) else {
        return false;
    };
    show_instead(&closing, &next);
    closing.close();
    smoke_event(&format!("tab_prototype_closed; tabs={count}"));
    true
}

/// The shown window of a group is closing (frame button, last page): the
/// hidden tabs go with it, otherwise they would keep the browser running.
pub fn closing(window: &Window) {
    let others = GROUPS.with_borrow_mut(|all| {
        let index = group_of(all, window)?;
        let group = &all[index];
        if !same(&group.windows[group.shown], window) {
            return None;
        }
        Some(all.remove(index).windows)
    });
    for other in others.into_iter().flatten() {
        if !same(&other, window) {
            other.close();
        }
    }
}

/// A destroyed window leaves its group (a hidden tab closed by its page).
pub fn release(window: &Window) {
    GROUPS.with_borrow_mut(|all| {
        let Some(index) = group_of(all, window) else {
            return;
        };
        let group = &mut all[index];
        let Some(at) = group.windows.iter().position(|w| same(w, window)) else {
            return;
        };
        group.windows.remove(at);
        if at < group.shown {
            group.shown -= 1;
        }
        if group.windows.len() < 2 {
            all.remove(index);
        }
    });
}
