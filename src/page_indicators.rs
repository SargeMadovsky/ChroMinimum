//! Page indicators beside the address field (D049), after Maxthon 3's status
//! bar: page zoom other than the default (a click resets it) and muted page
//! audio (a click turns the sound back on). Each stays hidden while there is
//! nothing to show.
//!
//! Event-driven, no timers. CEF 154 reports neither zoom changes nor "page is
//! audible", so zoom follows Chrome's per-site zoom preference (menu,
//! shortcuts and Ctrl+wheel all write it) plus navigation; mute changes only
//! through our own commands and stays on for the window until turned off.
use crate::{Nav, smoke_event, toolbar_style, zoom_percent};
use cef::*;

/// Menu check item "Без звука".
pub const MENU_MUTE: i32 = 13;
/// Chrome's per-site zoom levels; a pref change here is a zoom change.
const ZOOM_PREFERENCE: &str = "partition.per_host_zoom_levels";

wrap_button_delegate! {
    struct ZoomIndicator { nav: Nav }
    impl ViewDelegate {}
    impl ButtonDelegate {
        fn on_button_pressed(&self, _button: Option<&mut Button>) { reset_zoom(&self.nav); }
    }
}

wrap_button_delegate! {
    struct MuteIndicator { nav: Nav }
    impl ViewDelegate {
        fn on_theme_changed(&self, view: Option<&mut View>) {
            let focused = view.as_ref().is_some_and(|v| v.has_focus() != 0);
            toolbar_style::apply_view(view, toolbar_style::Icon::Muted, focused);
        }
        fn on_focus(&self, view: Option<&mut View>) { toolbar_style::apply_view(view, toolbar_style::Icon::Muted, true); }
        fn on_blur(&self, view: Option<&mut View>) { toolbar_style::apply_view(view, toolbar_style::Icon::Muted, false); }
    }
    impl ButtonDelegate {
        fn on_button_pressed(&self, _button: Option<&mut Button>) { set_muted(&self.nav, false); }
    }
}

wrap_preference_observer! {
    struct ZoomObserver { nav: Nav }
    impl PreferenceObserver {
        fn on_preference_changed(&self, _name: Option<&CefString>) { refresh_zoom(&self.nav); }
    }
}

fn host(nav: &Nav) -> Option<BrowserHost> {
    nav.borrow().browser.as_ref().and_then(|b| b.host())
}

/// Adds both hidden indicators to the toolbar, after the address field.
pub fn add_to_toolbar(nav: &Nav, panel: &Panel) -> Option<()> {
    let mut delegate = ZoomIndicator::new(nav.clone());
    let zoom = label_button_create(Some(&mut delegate), Some(&CefString::from("100%")))?;
    zoom.set_focusable(1);
    zoom.set_ink_drop_enabled(1);
    zoom.set_minimum_size(Some(&Size {
        width: 36,
        height: 32,
    }));
    zoom.set_visible(0);
    let mut view = View::from(&zoom);
    panel.add_child_view(Some(&mut view));

    let mut delegate = MuteIndicator::new(nav.clone());
    let mute = label_button_create(Some(&mut delegate), Some(&CefString::from("")))?;
    let text = CefString::from("Звук страницы выключен. Нажмите, чтобы включить");
    mute.set_tooltip_text(Some(&text));
    mute.set_accessible_name(Some(&text));
    mute.set_minimum_size(Some(&Size {
        width: 36,
        height: 32,
    }));
    toolbar_style::configure(&mute, toolbar_style::Icon::Muted);
    mute.set_visible(0);
    let mut view = View::from(&mute);
    panel.add_child_view(Some(&mut view));

    let mut state = nav.borrow_mut();
    state.zoom_indicator = Some(zoom);
    state.mute_indicator = Some(mute);
    Some(())
}

/// Observes the browser's profile zoom preference while the window lives.
pub fn observe(nav: &Nav, browser: &Browser) {
    let Some(context) = browser.host().and_then(|h| h.request_context()) else {
        return;
    };
    let name = CefString::from(ZOOM_PREFERENCE);
    let known = context.has_preference(Some(&name)) != 0;
    let mut observer = ZoomObserver::new(nav.clone());
    let registration = context.add_preference_observer(Some(&name), Some(&mut observer));
    smoke_event(&format!(
        "zoom_observer; preference={known}; registered={}",
        registration.is_some()
    ));
    nav.borrow_mut().zoom_observer = registration;
}

/// Drops the observer, which holds this window's state.
pub fn closed(nav: &Nav) {
    nav.borrow_mut().zoom_observer = None;
}

wrap_task! {
    struct MuteSync { nav: Nav }
    impl Task {
        fn execute(&self) { keep_muted(&self.nav); }
    }
}

/// After a navigation: another site may have another zoom. Mute belongs to
/// the window, as a tab mute does in Chrome, but Chrome's sound content
/// setting unmutes on navigation unless the tab strip muted it, so it is
/// applied again now and once more after the other navigation observers.
pub fn page_changed(nav: &Nav) {
    refresh_zoom(nav);
    keep_muted(nav);
    let mut task = MuteSync::new(nav.clone());
    post_task(ThreadId::UI, Some(&mut task));
}

/// The visible mute indicator is the window's wish to stay muted.
fn keep_muted(nav: &Nav) {
    let wanted = nav
        .borrow()
        .mute_indicator
        .as_ref()
        .is_some_and(|b| b.is_visible() != 0);
    if let Some(host) = host(nav)
        && wanted
        && host.is_audio_muted() == 0
    {
        host.set_audio_muted(1);
        smoke_event("audio_muted; reapplied=true");
    }
}

pub fn refresh_zoom(nav: &Nav) {
    let (button, shown) = {
        let state = nav.borrow();
        (state.zoom_indicator.clone(), state.zoom_shown)
    };
    let (Some(host), Some(button)) = (host(nav), button) else {
        return;
    };
    // Chrome allows a reset exactly when the page is not at the default zoom.
    let percent = (host.can_zoom(ZoomCommand::RESET) != 0).then(|| zoom_percent(host.zoom_level()));
    if percent == shown {
        return;
    }
    nav.borrow_mut().zoom_shown = percent;
    if let Some(percent) = percent {
        button.set_text(Some(&CefString::from(format!("{percent}%").as_str())));
        let text =
            CefString::from(format!("Масштаб {percent}%. Нажмите, чтобы вернуть обычный").as_str());
        button.set_tooltip_text(Some(&text));
        button.set_accessible_name(Some(&text));
    }
    button.set_visible(percent.is_some().into());
    smoke_event(&format!(
        "zoom_indicator; percent={}",
        percent.map_or("hidden".to_owned(), |p| p.to_string())
    ));
}

fn reset_zoom(nav: &Nav) {
    if let Some(host) = host(nav) {
        host.zoom(ZoomCommand::RESET);
        host.set_focus(1);
    }
    refresh_zoom(nav);
    smoke_event("zoom_indicator_pressed");
}

pub fn set_muted(nav: &Nav, muted: bool) {
    let Some(host) = host(nav) else { return };
    host.set_audio_muted(muted.into());
    let muted = host.is_audio_muted() != 0;
    let button = nav.borrow().mute_indicator.clone();
    if let Some(button) = button {
        button.set_visible(muted.into());
    }
    smoke_event(&format!("audio_muted; muted={muted}"));
}

pub fn toggle_mute(nav: &Nav) {
    let muted = host(nav).is_some_and(|h| h.is_audio_muted() != 0);
    set_muted(nav, !muted);
}

pub fn fill_menu(model: &MenuModel, nav: &Nav) {
    let host = host(nav);
    model.add_check_item(MENU_MUTE, Some(&CefString::from("Без звука")));
    model.set_checked(
        MENU_MUTE,
        host.as_ref()
            .is_some_and(|h| h.is_audio_muted() != 0)
            .into(),
    );
    model.set_enabled(MENU_MUTE, host.is_some().into());
}

/// Smoke-only: reports or presses the indicators through their delegates.
pub fn probe(nav: &Nav, command: &str) -> bool {
    match command {
        "indicators" => {
            let (zoom, mute) = {
                let state = nav.borrow();
                (state.zoom_indicator.clone(), state.mute_indicator.clone())
            };
            let describe = |b: Option<LabelButton>| {
                b.map_or("none".to_owned(), |b| {
                    format!(
                        "{}/{}/{}/{}",
                        b.is_visible(),
                        b.is_drawn(),
                        b.bounds().width,
                        CefString::from(&b.text())
                    )
                })
            };
            let host = host(nav);
            smoke_event(&format!(
                "menu_indicators; zoom={}; mute={}; muted={}; level={}",
                describe(zoom),
                describe(mute),
                host.as_ref().is_some_and(|h| h.is_audio_muted() != 0),
                host.as_ref().map_or(0, |h| zoom_percent(h.zoom_level())),
            ));
        }
        "press:zoom" => ZoomIndicator::new(nav.clone()).on_button_pressed(None),
        "press:mute" => MuteIndicator::new(nav.clone()).on_button_pressed(None),
        _ => return false,
    }
    if command.starts_with("press:") {
        smoke_event(&format!("menu_pressed; {command}"));
    }
    true
}
