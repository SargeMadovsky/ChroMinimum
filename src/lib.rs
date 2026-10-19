//! Native browser prototype. CEF lifecycle adapted from the MIT/Apache-2.0
//! cef-rs cefsimple example, pinned in Cargo.toml; see THIRD_PARTY.md.

#[cfg(target_os = "macos")]
mod mac;

use cef::*;
use std::rc::Rc as UiRef;
use std::{
    cell::RefCell,
    io::Write,
    path::PathBuf,
    sync::{
        OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
};

static SMOKE_LOG: OnceLock<PathBuf> = OnceLock::new();
static BROWSER_COUNT: AtomicUsize = AtomicUsize::new(0);

#[derive(Default)]
struct Navigation {
    browser: Option<Browser>,
    address: Option<Textfield>,
    back: Option<LabelButton>,
    forward: Option<LabelButton>,
    reload: Option<LabelButton>,
    loading: bool,
    title: String,
    exercise_navigation: bool,
    navigation_probe_started: bool,
}
type Nav = UiRef<RefCell<Navigation>>;

fn navigate(nav: &Nav, text: &str) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    let url = if text.contains("://") || text.starts_with("about:") {
        text.to_owned()
    } else {
        format!("https://{text}")
    };
    let browser = nav.borrow().browser.clone();
    if let Some(browser) = browser {
        if let Some(frame) = browser.main_frame() {
            frame.load_url(Some(&CefString::from(url.as_str())));
        }
        if let Some(host) = browser.host() {
            host.set_focus(1);
        }
    }
}

wrap_button_delegate! {
    struct NavigationButton { nav: Nav, action: i32 }
    impl ViewDelegate {}
    impl ButtonDelegate {
        fn on_button_pressed(&self, _button: Option<&mut Button>) {
            let (browser, loading) = { let nav = self.nav.borrow(); (nav.browser.clone(), nav.loading) };
            if let Some(browser) = browser {
                match self.action {
                    1 => browser.go_back(),
                    2 => browser.go_forward(),
                    _ if loading => browser.stop_load(),
                    _ => browser.reload(),
                }
            }
        }
    }
}

wrap_textfield_delegate! {
    struct AddressInput { nav: Nav }
    impl ViewDelegate {
        fn preferred_size(&self, _view: Option<&mut View>) -> Size { Size { width: 400, height: 32 } }
    }
    impl TextfieldDelegate {
        fn on_key_event(&self, field: Option<&mut Textfield>, event: Option<&KeyEvent>) -> i32 {
            if let (Some(field), Some(event)) = (field, event)
                && event.type_ == KeyEventType::RAWKEYDOWN && event.windows_key_code == 13 {
                navigate(&self.nav, &CefString::from(&field.text()).to_string());
                return 1;
            }
            0
        }
    }
}

wrap_panel_delegate! {
    struct ToolbarPanel {}
    impl ViewDelegate {
        fn preferred_size(&self, _view: Option<&mut View>) -> Size { Size { width: 600, height: 44 } }
    }
    impl PanelDelegate {}
}

fn toolbar(nav: &Nav) -> Option<Panel> {
    let mut delegate = ToolbarPanel::new();
    let panel = panel_create(Some(&mut delegate))?;
    let layout = panel.set_to_box_layout(Some(&BoxLayoutSettings {
        horizontal: 1,
        between_child_spacing: 6,
        inside_border_horizontal_spacing: 8,
        inside_border_vertical_spacing: 6,
        cross_axis_alignment: AxisAlignment::CENTER,
        ..Default::default()
    }))?;
    let mut buttons = Vec::new();
    for (label, action) in [("Назад", 1), ("Вперёд", 2), ("Обновить", 3)] {
        let mut delegate = NavigationButton::new(nav.clone(), action);
        let button = label_button_create(Some(&mut delegate), Some(&CefString::from(label)))?;
        button.set_accessible_name(Some(&CefString::from(label)));
        button.set_minimum_size(Some(&Size {
            width: 88,
            height: 32,
        }));
        let mut view = View::from(&button);
        panel.add_child_view(Some(&mut view));
        buttons.push(button);
    }
    buttons[0].set_enabled(0);
    buttons[1].set_enabled(0);
    let mut delegate = AddressInput::new(nav.clone());
    let field = textfield_create(Some(&mut delegate))?;
    field.set_placeholder_text(Some(&CefString::from(
        "Введите адрес сайта и нажмите Enter",
    )));
    field.set_font_list(Some(&CefString::from("Segoe UI, 14px")));
    let mut view = View::from(&field);
    panel.add_child_view(Some(&mut view));
    layout.set_flex_for_view(Some(&mut view), 1);
    let mut state = nav.borrow_mut();
    state.back = Some(buttons.remove(0));
    state.forward = Some(buttons.remove(0));
    state.reload = Some(buttons.remove(0));
    state.address = Some(field);
    Some(panel)
}

// Test-only evidence, using a disposable profile; normal browsing writes no URL
// or document contents here. Failure to write is visible to the smoke runner.
fn smoke_event(event: &str) {
    if let Some(path) = SMOKE_LOG.get()
        && let Ok(mut file) = std::fs::OpenOptions::new().append(true).open(path)
    {
        let _ = writeln!(file, "{event}");
    }
}

// The CEF-supplied bootstrap initializes the Windows sandbox before loading this
// DLL. Do not replace this entry point with an ordinary executable/no_sandbox.
#[unsafe(no_mangle)]
#[cfg(target_os = "windows")]
unsafe extern "C" fn RunWinMain(
    instance: sys::HINSTANCE,
    _command_line: *const u8,
    _command_show: i32,
    sandbox_info: *mut u8,
) -> i32 {
    // Never unwind a Rust panic across the bootstrap's C ABI boundary.
    std::panic::catch_unwind(|| run(args::Args::from(MainArgs { instance }), sandbox_info))
        .unwrap_or(1)
}

#[cfg(not(target_os = "windows"))]
pub fn main_process() -> i32 {
    #[cfg(target_os = "macos")]
    let _loader = {
        let loader = library_loader::LibraryLoader::new(
            &std::env::current_exe().expect("executable"),
            false,
        );
        assert!(loader.load(), "Cannot load bundled CEF framework");
        mac::setup();
        loader
    };
    run(args::Args::new(), std::ptr::null_mut())
}

fn run(args: args::Args, sandbox_info: *mut u8) -> i32 {
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    let Some(command) = args.as_cmd_line() else {
        return 1;
    };
    let child_exit = execute_process(Some(args.as_main_args()), None, sandbox_info);
    if child_exit >= 0 {
        return child_exit;
    }

    #[cfg(target_os = "windows")]
    let Some(directory) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
    else {
        return 1;
    };
    let smoke = command.has_switch(Some(&CefString::from("smoke-test"))) != 0;
    let directory = std::env::var_os("CHROMINIMUM_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            #[cfg(target_os = "windows")]
            {
                directory
            }
            #[cfg(target_os = "macos")]
            {
                PathBuf::from(std::env::var_os("HOME").expect("HOME"))
                    .join("Library/Application Support/ChroMinimum")
            }
            #[cfg(target_os = "linux")]
            {
                std::env::var_os("XDG_DATA_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        PathBuf::from(std::env::var_os("HOME").expect("HOME")).join(".local/share")
                    })
                    .join("chrominimum")
            }
        });
    if std::fs::create_dir_all(&directory).is_err() {
        return 1;
    }
    if smoke {
        let path = directory.join("smoke.log");
        if std::fs::write(&path, "starting; sandbox_requested=true\n").is_err() {
            return 1;
        }
        let _ = SMOKE_LOG.set(path);
    }
    let profile = directory.join(if smoke { "profile-smoke" } else { "profile" });
    if std::fs::create_dir_all(&profile).is_err() {
        return 1;
    }
    let profile = profile.to_string_lossy();
    let log = directory.join("cef.log");
    let settings = Settings {
        no_sandbox: 0,
        command_line_args_disabled: 1,
        chrome_app_icon_id: 1,
        root_cache_path: CefString::from(profile.as_ref()),
        cache_path: CefString::from(profile.as_ref()),
        log_file: CefString::from(log.to_string_lossy().as_ref()),
        ..Default::default()
    };
    let initial_url =
        CefString::from(&command.switch_value(Some(&CefString::from("url")))).to_string();
    let initial_url = if initial_url.is_empty() {
        "about:blank".to_owned()
    } else {
        initial_url
    };
    let mut app = BrowserApp::new(initial_url, smoke);
    if initialize(
        Some(args.as_main_args()),
        Some(&settings),
        Some(&mut app),
        sandbox_info,
    ) != 1
    {
        return 1;
    }
    run_message_loop();
    shutdown();
    smoke_event("shutdown_complete");
    0
}

wrap_app! {
    struct BrowserApp { url: String, smoke: bool }
    impl App {
        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            Some(ProcessHandler::new(self.url.clone(), self.smoke))
        }
    }
}

wrap_browser_process_handler! {
    struct ProcessHandler { url: String, smoke: bool }
    impl BrowserProcessHandler {
        fn on_context_initialized(&self) {
            let nav = UiRef::new(RefCell::new(Navigation::default()));
            nav.borrow_mut().exercise_navigation = self.smoke && self.url.ends_with("/smoke.html");
            let mut client = BrowserClient::new(self.smoke, nav.clone());
            let mut delegate = PageDelegate::new();
            let mut view = browser_view_create(
                Some(&mut client), Some(&CefString::from(self.url.as_str())),
                Some(&BrowserSettings::default()), None, None, Some(&mut delegate),
            );
            let mut window_delegate = AppWindow::new(RefCell::new(view.take()), nav);
            window_create_top_level(Some(&mut window_delegate));
        }
    }
}

wrap_browser_view_delegate! {
    struct PageDelegate {}
    impl ViewDelegate {}
    impl BrowserViewDelegate {
        fn browser_runtime_style(&self) -> RuntimeStyle { RuntimeStyle::CHROME }
        fn chrome_toolbar_type(&self, _view: Option<&mut BrowserView>) -> ChromeToolbarType {
            ChromeToolbarType::NONE
        }
    }
}

wrap_window_delegate! {
    struct AppWindow { page: RefCell<Option<BrowserView>>, nav: Nav }
    impl ViewDelegate {
        fn preferred_size(&self, _view: Option<&mut View>) -> Size {
            Size { width: 1100, height: 760 }
        }
        fn minimum_size(&self, _view: Option<&mut View>) -> Size {
            Size { width: 640, height: 360 }
        }
    }
    impl PanelDelegate {}
    impl WindowDelegate {
        fn with_standard_window_buttons(&self, _window: Option<&mut Window>) -> i32 { 1 }
        // cef-rs defaults these bool callbacks to 0, unlike the C++ delegate.
        // Set them explicitly so Windows exposes its normal frame controls.
        fn can_resize(&self, _window: Option<&mut Window>) -> i32 { 1 }
        fn can_maximize(&self, _window: Option<&mut Window>) -> i32 { 1 }
        fn can_minimize(&self, _window: Option<&mut Window>) -> i32 { 1 }
        fn on_window_created(&self, window: Option<&mut Window>) {
            let Some(window) = window else { return };
            // Clone and release the RefCell borrow before calling into CEF.
            let Some(page) = self.page.borrow().clone() else { return };
            let layout = window.set_to_box_layout(Some(&BoxLayoutSettings {
                horizontal: 0, cross_axis_alignment: AxisAlignment::STRETCH, ..Default::default()
            }));
            let mut content = View::from(&page);
            window.add_child_view(Some(&mut content));
            if let Some(toolbar) = toolbar(&self.nav) {
                let mut toolbar = View::from(&toolbar);
                window.add_child_view_at(Some(&mut toolbar), 0);
                smoke_event("toolbar_created");
            } else {
                eprintln!("ChroMinimum: native toolbar creation failed");
            }
            if let Some(layout) = layout { layout.set_flex_for_view(Some(&mut content), 1); }
            if let Some(mut icon) = image_create() {
                // CEF requires exactly 16 logical pixels for the title-bar icon.
                icon.add_png(1.0, Some(include_bytes!("../assets/chrominimum-16.png")));
                icon.add_png(2.0, Some(include_bytes!("../assets/chrominimum-32.png")));
                window.set_window_icon(Some(&mut icon));
                if let Some(mut app_icon) = image_create() {
                    app_icon.add_png(1.0, Some(include_bytes!("../assets/chrominimum-32.png")));
                    app_icon.add_png(8.0, Some(include_bytes!("../assets/chrominimum.png")));
                    window.set_window_app_icon(Some(&mut app_icon));
                }
                if window.window_icon().is_some() && window.window_app_icon().is_some() { smoke_event("window_icons_set"); }
            }
            window.set_accelerator(1001, 76, 0, 1, 0, 1);
            window.set_accelerator(1002, 116, 0, 0, 0, 1);
            window.layout();
            window.set_title(Some(&CefString::from("ChroMinimum — Prototype")));
            window.show();
            window.layout();
            content.request_focus();
        }
        fn can_close(&self, _window: Option<&mut Window>) -> i32 {
            let page = self.page.borrow().clone();
            page.and_then(|p| p.browser()).and_then(|b| b.host())
                .map(|host| host.try_close_browser()).unwrap_or(1)
        }
        fn on_window_destroyed(&self, _window: Option<&mut Window>) {
            self.page.borrow_mut().take();
            let mut nav = self.nav.borrow_mut();
            nav.address = None; nav.back = None; nav.forward = None; nav.reload = None;
        }
        fn on_accelerator(&self, _window: Option<&mut Window>, command_id: i32) -> i32 {
            if command_id == 1001 {
                let field = self.nav.borrow().address.clone();
                if let Some(field) = field { field.request_focus(); field.select_all(0); }
                return 1;
            }
            if command_id == 1002 {
                let browser = self.nav.borrow().browser.clone();
                if let Some(browser) = browser { browser.reload(); }
                return 1;
            }
            0
        }
        fn window_runtime_style(&self) -> RuntimeStyle { RuntimeStyle::CHROME }
    }
}

wrap_client! {
    struct BrowserClient { smoke: bool, nav: Nav }
    impl Client {
        fn life_span_handler(&self) -> Option<LifeSpanHandler> { Some(Lifetime::new(self.smoke, self.nav.clone())) }
        fn load_handler(&self) -> Option<LoadHandler> { Some(LoadObserver::new(self.nav.clone())) }
        fn command_handler(&self) -> Option<CommandHandler> { Some(SinglePageCommands::new()) }
        fn display_handler(&self) -> Option<DisplayHandler> { Some(PageTitle::new(self.nav.clone())) }
    }
}

wrap_display_handler! {
    struct PageTitle { nav: Nav }
    impl DisplayHandler {
        fn on_address_change(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, url: Option<&CefString>) {
            if frame.is_some_and(|f| f.is_main() != 0) {
                let field = self.nav.borrow().address.clone();
                if let Some(field) = field { field.set_text(url); }
            }
        }
        fn on_title_change(&self, browser: Option<&mut Browser>, title: Option<&CefString>) {
            if let Some(view) = browser_view_get_for_browser(browser)
                && let Some(window) = view.window() {
                    let title = title.map(CefString::to_string).unwrap_or_default();
                    self.nav.borrow_mut().title = title.clone();
                    if title == "ChroMinimum smoke JS OK" { smoke_event("fixture_javascript_ok"); }
                    window.set_title(Some(&CefString::from(format!("{title} — ChroMinimum").as_str())));
            }
        }
    }
}

// Integration test of the same delegates used by the actual controls, with two
// local documents. This does not substitute for a real mouse/keyboard UI check.
wrap_task! {
    struct NavigationProbe { nav: Nav, step: i32 }
    impl Task {
        fn execute(&self) {
            let (field, back, forward, browser, title) = {
                let state = self.nav.borrow();
                (state.address.clone(), state.back.clone(), state.forward.clone(), state.browser.clone(), state.title.clone())
            };
            let (Some(mut field), Some(back), Some(forward), Some(browser)) = (field, back, forward, browser) else { return };
            let ok = match self.step {
                0 => {
                    let bounds = field.bounds();
                    let drawn = field.is_drawn() != 0 && back.is_drawn() != 0 && forward.is_drawn() != 0
                        && bounds.width > 100 && bounds.height >= 24;
                    if drawn {
                        smoke_event("navigation_controls_drawn");
                        let url = CefString::from(&field.text()).to_string().replace("smoke.html", "navigation.html");
                        field.set_text(Some(&CefString::from(url.as_str())));
                        let delegate = AddressInput::new(self.nav.clone());
                        delegate.on_key_event(Some(&mut field), Some(&KeyEvent {
                            type_: KeyEventType::RAWKEYDOWN, windows_key_code: 13, ..Default::default()
                        }));
                    }
                    drawn
                }
                1 if title == "ChroMinimum navigation ready" && back.is_enabled() != 0 => {
                    smoke_event("address_enter_navigated");
                    NavigationButton::new(self.nav.clone(), 1).on_button_pressed(None);
                    true
                }
                2 if title == "ChroMinimum smoke JS OK" && forward.is_enabled() != 0 => {
                    smoke_event("back_button_navigated");
                    NavigationButton::new(self.nav.clone(), 2).on_button_pressed(None);
                    true
                }
                3 if title == "ChroMinimum navigation ready" && browser.can_go_forward() == 0 => {
                    smoke_event("forward_button_navigated");
                    NavigationButton::new(self.nav.clone(), 3).on_button_pressed(None);
                    true
                }
                4 if title == "ChroMinimum navigation reloaded" => {
                    smoke_event("reload_button_navigated");
                    if cfg!(target_os = "windows") && let Some(window) = field.window() {
                        let original = window.bounds();
                        let mut probe = WindowProbe::new(window, original, 0);
                        post_delayed_task(ThreadId::UI, Some(&mut probe), 250);
                    }
                    return;
                }
                _ => false,
            };
            if ok {
                let mut next = NavigationProbe::new(self.nav.clone(), self.step + 1);
                post_delayed_task(ThreadId::UI, Some(&mut next), 2000);
            } else { smoke_event(&format!("navigation_probe_failed; step={}", self.step)); }
        }
    }
}

// Exercise actual CEF window state changes, without synthesizing OS input.
wrap_task! {
    struct WindowProbe { window: Window, original: Rect, step: i32 }
    impl Task {
        fn execute(&self) {
            let ok = match self.step {
                0 => {
                    self.window.set_bounds(Some(&Rect { width: 900, height: 600, ..self.original.clone() }));
                    true
                }
                1 if self.window.bounds().width == 900 && self.window.bounds().height == 600 => {
                    smoke_event("window_resized");
                    self.window.maximize();
                    true
                }
                2 if self.window.is_maximized() != 0 => {
                    smoke_event("window_maximized");
                    self.window.restore();
                    true
                }
                3 if self.window.is_maximized() == 0 && self.window.is_minimized() == 0 => {
                    smoke_event("window_restored");
                    self.window.minimize();
                    true
                }
                4 if self.window.is_minimized() != 0 => {
                    smoke_event("window_minimized");
                    self.window.restore();
                    true
                }
                5 if self.window.is_minimized() == 0 && self.window.is_maximized() == 0 => {
                    self.window.set_bounds(Some(&self.original));
                    smoke_event("window_returned_to_normal");
                    return;
                }
                _ => false,
            };
            if ok {
                let mut next = WindowProbe::new(self.window.clone(), self.original.clone(), self.step + 1);
                post_delayed_task(ThreadId::UI, Some(&mut next), 250);
            } else { smoke_event(&format!("window_probe_failed; step={}", self.step)); }
        }
    }
}

fn opens_another_page(command_id: i32) -> bool {
    [
        c"IDC_NEW_TAB",
        c"IDC_NEW_WINDOW",
        c"IDC_NEW_INCOGNITO_WINDOW",
        c"IDC_NEW_ISOLATED_WINDOW",
        c"IDC_NEW_SPLIT_TAB",
        c"IDC_DUPLICATE_TAB",
        c"IDC_DUPLICATE_TARGET_TAB",
        c"IDC_RESTORE_TAB",
        c"IDC_RESTORE_WINDOW",
        c"IDC_NEW_TAB_TO_RIGHT",
    ]
    .iter()
    .any(|name| {
        // Static NUL-terminated names; CEF resolves version-specific IDs.
        command_id == unsafe { sys::cef_id_for_command_id_name(name.as_ptr()) }
    })
}

wrap_command_handler! {
    struct SinglePageCommands;
    impl CommandHandler {
        fn on_chrome_command(&self, _browser: Option<&mut Browser>, id: i32, disposition: WindowOpenDisposition) -> i32 {
            (opens_another_page(id) || disposition == WindowOpenDisposition::NEW_FOREGROUND_TAB
                || disposition == WindowOpenDisposition::NEW_BACKGROUND_TAB
                || disposition == WindowOpenDisposition::NEW_WINDOW).into()
        }
        fn is_chrome_app_menu_item_visible(&self, _browser: Option<&mut Browser>, id: i32) -> i32 {
            (!opens_another_page(id)).into()
        }
        fn is_chrome_app_menu_item_enabled(&self, _browser: Option<&mut Browser>, id: i32) -> i32 {
            (!opens_another_page(id)).into()
        }
        fn is_chrome_toolbar_button_visible(&self, button: ChromeToolbarButtonType) -> i32 {
            (button != ChromeToolbarButtonType::AVATAR).into()
        }
        fn is_chrome_page_action_icon_visible(&self, _icon: ChromePageActionIconType) -> i32 { 1 }
    }
}

wrap_life_span_handler! {
    struct Lifetime { smoke: bool, nav: Nav }
    impl LifeSpanHandler {
        fn on_after_created(&self, browser: Option<&mut Browser>) {
            BROWSER_COUNT.fetch_add(1, Ordering::Relaxed);
            let browser = browser.cloned();
            self.nav.borrow_mut().browser = browser.clone();
            #[cfg(target_os = "macos")]
            mac::set_browser(browser.clone());
            smoke_event("browser_created");
            if self.smoke && let Some(browser) = browser {
                    let mut close = SmokeClose::new(browser.clone());
                    post_delayed_task(ThreadId::UI, Some(&mut close), 30000);
            }
        }
        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            smoke_event("browser_closed");
            self.nav.borrow_mut().browser = None;
            #[cfg(target_os = "macos")]
            mac::set_browser(None);
            // CEF can create auxiliary browsers (e.g. DevTools). Never shut
            // down the runtime while another browser still exists.
            if BROWSER_COUNT.fetch_sub(1, Ordering::Relaxed) == 1 { quit_message_loop(); }
        }
        // Popups are disabled in this initial one-page prototype. This is an
        // explicit temporary limitation, not a hidden second tab or window.
        fn on_before_popup(
            &self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, _popup_id: i32,
            _target_url: Option<&CefString>, _target_frame_name: Option<&CefString>,
            _target_disposition: WindowOpenDisposition, _user_gesture: i32,
            _popup_features: Option<&PopupFeatures>, _window_info: Option<&mut WindowInfo>,
            _client: Option<&mut Option<Client>>, _settings: Option<&mut BrowserSettings>,
            _extra_info: Option<&mut Option<DictionaryValue>>, _no_javascript_access: Option<&mut i32>,
        ) -> i32 { 1 }
    }
}

wrap_load_handler! {
    struct LoadObserver { nav: Nav }
    impl LoadHandler {
        fn on_loading_state_change(&self, _browser: Option<&mut Browser>, loading: i32, back: i32, forward: i32) {
            let (back_button, forward_button, reload_button) = {
                let mut state = self.nav.borrow_mut();
                state.loading = loading != 0;
                (state.back.clone(), state.forward.clone(), state.reload.clone())
            };
            if let Some(button) = back_button { button.set_enabled(back); }
            if let Some(button) = forward_button { button.set_enabled(forward); }
            if let Some(button) = reload_button {
                let label = CefString::from(if loading != 0 { "Остановить" } else { "Обновить" });
                button.set_text(Some(&label)); button.set_accessible_name(Some(&label));
            }
        }
        fn on_load_end(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, status: i32) {
            if frame.is_some_and(|f| f.is_main() != 0) {
                smoke_event(&format!("main_frame_loaded; status={status}"));
                eprintln!("ChroMinimum main frame loaded; status={status}");
                let start_probe = {
                    let mut state = self.nav.borrow_mut();
                    let start = state.exercise_navigation && !state.navigation_probe_started;
                    if start { state.navigation_probe_started = true; }
                    start
                };
                if start_probe {
                    let mut probe = NavigationProbe::new(self.nav.clone(), 0);
                    post_delayed_task(ThreadId::UI, Some(&mut probe), 250);
                }
            }
        }
        fn on_load_error(
            &self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, code: Errorcode,
            _text: Option<&CefString>, _url: Option<&CefString>,
        ) {
            if frame.is_some_and(|f| f.is_main() != 0) {
                smoke_event(&format!("main_frame_error; code={code:?}"));
                eprintln!("ChroMinimum main frame load error: {code:?}");
            }
            // Chrome style renders the error page. Never bypass TLS failures.
        }
    }
}

wrap_task! {
    struct SmokeClose { browser: Browser }
    impl Task {
        fn execute(&self) {
            if let Some(host) = self.browser.host() { host.close_browser(0); }
        }
    }
}
