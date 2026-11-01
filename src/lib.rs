//! Native browser prototype. CEF lifecycle adapted from the MIT/Apache-2.0
//! cef-rs cefsimple example, pinned in Cargo.toml; see THIRD_PARTY.md.

#[cfg(target_os = "macos")]
mod mac;

mod external_protocol;
mod toolbar_style;
mod window_state;

#[cfg(target_os = "windows")]
mod core_updates;

#[cfg(target_os = "windows")]
mod component_ready;

#[cfg(target_os = "windows")]
mod network_sandbox;

#[cfg(all(target_os = "windows", feature = "windows-platform-codecs"))]
mod platform_codecs;

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
static WINDOW_SIZE_PATH: OnceLock<PathBuf> = OnceLock::new();
static RUNTIME_CEF_VERSION: OnceLock<String> = OnceLock::new();
static BROWSER_COUNT: AtomicUsize = AtomicUsize::new(0);
static EXTERNAL_ADDRESS_PROBED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
const NAVIGATION_TOOLBAR_ID: i32 = 2001;
// Shared with the optional 0005 CEF patch. Stock CEF ignores this view ID.
const DOWNLOAD_ANCHOR_VIEW_ID: i32 = 0x434d4401;

fn cef_version() -> &'static str {
    RUNTIME_CEF_VERSION.get_or_init(|| {
        unsafe extern "C" {
            fn cef_version_full() -> *const std::ffi::c_char;
        }
        let raw = unsafe { cef_version_full() };
        if raw.is_null() {
            return "unknown".to_owned();
        }
        let full = unsafe { std::ffi::CStr::from_ptr(raw) }.to_string_lossy();
        full.split('+').next().unwrap_or("unknown").to_owned()
    })
}

fn application_title(page_title: Option<&str>) -> String {
    let suffix = format!(
        "ChroMinimum v.{} | CEF v.{}",
        env!("CARGO_PKG_VERSION"),
        cef_version()
    );
    match page_title.filter(|title| !title.is_empty()) {
        Some(title) => format!("{title} — {suffix}"),
        None => suffix,
    }
}

fn show_about_window() {
    let mut delegate = AboutWindow::new();
    let _ = window_create_top_level(Some(&mut delegate));
}

fn saved_window_state() -> (i32, i32, bool) {
    WINDOW_SIZE_PATH
        .get()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| window_state::parse(&s))
        .unwrap_or((1100, 760, false))
}

fn saved_window_maximized() -> bool {
    saved_window_state().2
}

fn saved_window_size() -> Size {
    let (width, height, _) = saved_window_state();
    Size { width, height }
}

fn save_window_size(width: i32, height: i32, maximized: bool) {
    if !(640..=10_000).contains(&width) || !(360..=10_000).contains(&height) {
        return;
    }
    let Some(path) = WINDOW_SIZE_PATH.get() else {
        return;
    };
    let temporary = path.with_extension("tmp");
    if std::fs::write(
        &temporary,
        format!(
            "{width} {height} {}\n",
            if maximized { "maximized" } else { "normal" }
        ),
    )
    .is_ok()
    {
        let _ = std::fs::rename(temporary, path);
    }
}

#[derive(Default)]
struct Navigation {
    downloads: Option<LabelButton>,
    active_downloads: std::collections::BTreeSet<u32>,
    browser: Option<Browser>,
    address: Option<Textfield>,
    back: Option<LabelButton>,
    forward: Option<LabelButton>,
    reload: Option<LabelButton>,
    menu: Option<MenuButton>,
    loading: bool,
    title: String,
    exercise_navigation: bool,
    navigation_probe_started: bool,
}
type Nav = UiRef<RefCell<Navigation>>;

fn registered_external_scheme(scheme: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::{Foundation::ERROR_SUCCESS, System::Registry::*};
        // Classification only, never permission to launch. Chrome rechecks
        // the association and applies its own consent/sandbox policy later.
        if scheme.len() > 255 {
            return false;
        }
        let key_name: Vec<u16> = scheme.encode_utf16().chain(Some(0)).collect();
        let value_name: Vec<u16> = "URL Protocol".encode_utf16().chain(Some(0)).collect();
        let mut key = std::ptr::null_mut();
        if unsafe {
            RegOpenKeyExW(
                HKEY_CLASSES_ROOT,
                key_name.as_ptr(),
                0,
                KEY_QUERY_VALUE,
                &mut key,
            )
        } != ERROR_SUCCESS
        {
            return false;
        }
        let mut size = 0;
        let found = unsafe {
            RegQueryValueExW(
                key,
                value_name.as_ptr(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut size,
            )
        } == ERROR_SUCCESS;
        unsafe {
            RegCloseKey(key);
        }
        found
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = scheme;
        false
    }
}

fn navigate(nav: &Nav, text: &str) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    let url = if text.contains("://")
        || external_protocol::address_is_external(text, registered_external_scheme)
        || text.starts_with("about:")
    {
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
    impl ViewDelegate {
        fn on_theme_changed(&self, view: Option<&mut View>) {
            let focused = view.as_ref().is_some_and(|v| v.has_focus() != 0);
            toolbar_style::apply_view(view, self.icon(), focused);
        }
        fn on_focus(&self, view: Option<&mut View>) { toolbar_style::apply_view(view, self.icon(), true); }
        fn on_blur(&self, view: Option<&mut View>) { toolbar_style::apply_view(view, self.icon(), false); }
    }
    impl ButtonDelegate {
        fn on_button_pressed(&self, _button: Option<&mut Button>) {
            let (browser, loading) = { let nav = self.nav.borrow(); (nav.browser.clone(), nav.loading) };
            if let Some(browser) = browser {
                // Clear mouse-click focus before opening any download bubble,
                // so its focus is not stolen after it has been displayed.
                if let Some(host) = browser.host() { host.set_focus(1); }
                match self.action {
                    1 => browser.go_back(),
                    2 => browser.go_forward(),
                    4 => {
                        if let Some(host) = browser.host() {
                            let id = unsafe { sys::cef_id_for_command_id_name(c"IDC_SHOW_DOWNLOADS".as_ptr()) };
                            if id >= 0 && host.can_execute_chrome_command(id) != 0 {
                                host.execute_chrome_command(id, WindowOpenDisposition::CURRENT_TAB);
                            } else { navigate(&self.nav, "chrome://downloads/"); }
                        }
                    },
                    _ if loading => browser.stop_load(),
                    _ => browser.reload(),
                }
            }
        }
    }
}

impl NavigationButton {
    fn icon(&self) -> toolbar_style::Icon {
        use toolbar_style::Icon;
        match self.action {
            1 => Icon::Back,
            2 => Icon::Forward,
            4 if !self.nav.borrow().active_downloads.is_empty() => Icon::DownloadHidden,
            4 => Icon::Download,
            _ if self.nav.borrow().loading => Icon::Stop,
            _ => Icon::Reload,
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
    for (label, action, icon) in [
        ("Назад", 1, toolbar_style::Icon::Back),
        ("Вперёд", 2, toolbar_style::Icon::Forward),
        ("Обновить", 3, toolbar_style::Icon::Reload),
    ] {
        let mut delegate = NavigationButton::new(nav.clone(), action);
        let button = label_button_create(Some(&mut delegate), Some(&CefString::from("")))?;
        button.set_accessible_name(Some(&CefString::from(label)));
        button.set_tooltip_text(Some(&CefString::from(label)));
        button.set_minimum_size(Some(&Size {
            width: 36,
            height: 32,
        }));
        toolbar_style::configure(&button, icon);
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
    let mut download_delegate = NavigationButton::new(nav.clone(), 4);
    let download_button =
        label_button_create(Some(&mut download_delegate), Some(&CefString::from("")))?;
    download_button.set_accessible_name(Some(&CefString::from("Загрузки")));
    download_button.set_id(DOWNLOAD_ANCHOR_VIEW_ID);
    download_button.set_tooltip_text(Some(&CefString::from("Загрузки (Ctrl+J)")));
    download_button.set_minimum_size(Some(&Size {
        width: 36,
        height: 32,
    }));
    toolbar_style::configure(&download_button, toolbar_style::Icon::Download);
    let mut view = View::from(&download_button);
    panel.add_child_view(Some(&mut view));
    let mut delegate = BrowserMenuButton::new();
    let menu_button = menu_button_create(Some(&mut delegate), Some(&CefString::from("")))?;
    menu_button.set_accessible_name(Some(&CefString::from("Меню")));
    menu_button.set_tooltip_text(Some(&CefString::from("Меню")));
    menu_button.set_minimum_size(Some(&Size {
        width: 36,
        height: 32,
    }));
    toolbar_style::configure(&LabelButton::from(&menu_button), toolbar_style::Icon::Menu);
    let mut view = View::from(&menu_button);
    panel.add_child_view(Some(&mut view));
    let mut state = nav.borrow_mut();
    state.back = Some(buttons.remove(0));
    state.forward = Some(buttons.remove(0));
    state.reload = Some(buttons.remove(0));
    state.address = Some(field);
    state.downloads = Some(download_button);
    state.menu = Some(menu_button);
    Some(panel)
}

wrap_menu_model_delegate! {
    struct BrowserMenuModel {}
    impl MenuModelDelegate {
        fn execute_command(&self, _model: Option<&mut MenuModel>, command_id: i32, _flags: EventFlags) {
            if command_id == 1 {
                #[cfg(target_os = "windows")]
                core_updates::check();
            } else if command_id == 2 {
                show_about_window();
            }
        }
    }
}

wrap_menu_button_delegate! {
    struct BrowserMenuButton {}
    impl ViewDelegate {
        fn on_theme_changed(&self, view: Option<&mut View>) {
            let focused = view.as_ref().is_some_and(|v| v.has_focus() != 0);
            toolbar_style::apply_view(view, toolbar_style::Icon::Menu, focused);
        }
        fn on_focus(&self, view: Option<&mut View>) { toolbar_style::apply_view(view, toolbar_style::Icon::Menu, true); }
        fn on_blur(&self, view: Option<&mut View>) { toolbar_style::apply_view(view, toolbar_style::Icon::Menu, false); }
    }
    impl ButtonDelegate {}
    impl MenuButtonDelegate {
        fn on_menu_button_pressed(&self, button: Option<&mut MenuButton>, point: Option<&Point>, _lock: Option<&mut MenuButtonPressedLock>) {
            let Some(button) = button else { return };
            let mut delegate = BrowserMenuModel::new();
            let Some(mut model) = menu_model_create(Some(&mut delegate)) else { return };
            #[cfg(target_os = "windows")]
            {
                model.add_item(1, Some(&CefString::from(core_updates::current_menu_label())));
                core_updates::menu_model(model.clone());
            }
            #[cfg(not(target_os = "windows"))]
            {
                model.add_item(1, Some(&CefString::from("Обновления ядра доступны в Windows")));
                model.set_enabled(1, 0);
            }
            model.add_separator();
            model.add_item(2, Some(&CefString::from("О программе")));
            button.show_menu(Some(&mut model), point, MenuAnchorPosition::TOPLEFT);
        }
    }
}

wrap_button_delegate! {
    struct AboutTextButton { url: Option<&'static str> }
    impl ViewDelegate {}
    impl ButtonDelegate {
        fn on_button_pressed(&self, _button: Option<&mut Button>) {
            if let Some(url) = self.url { open_window(url, false); }
        }
    }
}

wrap_panel_delegate! {
    struct AboutPanel {}
    impl ViewDelegate {
        fn preferred_size(&self, _view: Option<&mut View>) -> Size {
            Size { width: 460, height: 300 }
        }
    }
    impl PanelDelegate {}
}

wrap_window_delegate! {
    struct AboutWindow {}
    impl ViewDelegate {
        fn preferred_size(&self, _view: Option<&mut View>) -> Size {
            Size { width: 500, height: 340 }
        }
        fn minimum_size(&self, _view: Option<&mut View>) -> Size {
            Size { width: 500, height: 340 }
        }
    }
    impl PanelDelegate {}
    impl WindowDelegate {
        fn with_standard_window_buttons(&self, _window: Option<&mut Window>) -> i32 { 1 }
        fn can_resize(&self, _window: Option<&mut Window>) -> i32 { 0 }
        fn can_maximize(&self, _window: Option<&mut Window>) -> i32 { 0 }
        fn can_minimize(&self, _window: Option<&mut Window>) -> i32 { 0 }
        fn on_window_created(&self, window: Option<&mut Window>) {
            let Some(window) = window else { return };
            let Some(_window_layout) = window.set_to_box_layout(Some(&BoxLayoutSettings {
                horizontal: 0,
                cross_axis_alignment: AxisAlignment::STRETCH,
                ..Default::default()
            })) else { return };
            let mut panel_delegate = AboutPanel::new();
            let Some(panel) = panel_create(Some(&mut panel_delegate)) else { return };
            let Some(layout) = panel.set_to_box_layout(Some(&BoxLayoutSettings {
                horizontal: 0,
                between_child_spacing: 12,
                inside_border_horizontal_spacing: 24,
                inside_border_vertical_spacing: 24,
                cross_axis_alignment: AxisAlignment::CENTER,
                ..Default::default()
            })) else { return };
            for (text, url) in [
                (format!("ChroMinimum v.{}", env!("CARGO_PKG_VERSION")), None),
                (format!("CEF v.{}", cef_version()), None),
                ("Дата сборки: 22.10.2026".to_owned(), None),
                ("https://chrominimum.download".to_owned(), Some("https://chrominimum.download")),
                ("GitHub: SargeMadovsky/ChroMinimum".to_owned(), Some("https://github.com/SargeMadovsky/ChroMinimum")),
            ] {
                let mut button_delegate = AboutTextButton::new(url);
                let Some(button) = label_button_create(
                    Some(&mut button_delegate),
                    Some(&CefString::from(text.as_str())),
                ) else { return };
                if url.is_none() { button.set_enabled(0); }
                if text.starts_with("ChroMinimum") && let Some(mut image) = image_create() {
                    image.add_png(1.0, Some(include_bytes!("../assets/chrominimum-32.png")));
                    button.set_image(ButtonState::NORMAL, Some(&mut image));
                    button.set_image(ButtonState::DISABLED, Some(&mut image));
                }
                button.set_accessible_name(Some(&CefString::from(text.as_str())));
                let mut view = View::from(&button);
                panel.add_child_view(Some(&mut view));
            }
            let mut panel_view = View::from(&panel);
            window.add_child_view(Some(&mut panel_view));
            let _ = layout;
            window.set_title(Some(&CefString::from("О программе — ChroMinimum")));
            window.center_window(Some(&Size { width: 500, height: 340 }));
            window.show();
            window.layout();
            // Center the actual outer frame, including native decorations.
            if let Some(display) = window.display() {
                let work = display.work_area();
                let bounds = window.bounds();
                window.set_position(Some(&Point {
                    x: work.x + (work.width - bounds.width) / 2,
                    y: work.y + (work.height - bounds.height) / 2,
                }));
            }
        }
        fn can_close(&self, _window: Option<&mut Window>) -> i32 { 1 }
    }
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
    version_info: *mut std::ffi::c_void,
) -> i32 {
    unsafe extern "C" {
        fn cm_load_engine(info: *mut std::ffi::c_void, managed: bool) -> i32;
    }
    if unsafe { cm_load_engine(version_info, false) } != 1 {
        return 1;
    }
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
    if !network_sandbox::supported() {
        eprintln!("ChroMinimum requires native Windows x64 build 19041+ for the network sandbox");
        return 1;
    }
    #[cfg(target_os = "windows")]
    let _runtime_lease = match core_updates::runtime_lease() {
        Ok(lease) => lease,
        Err(_) => return 1,
    };

    #[cfg(target_os = "windows")]
    let Some(directory) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
    else {
        return 1;
    };
    let smoke = command.has_switch(Some(&CefString::from("smoke-test"))) != 0;
    // Direct smoke override only; a managed component selection takes precedence.
    let test_locale = if smoke {
        CefString::from(&command.switch_value(Some(&CefString::from("test-cef-locale"))))
            .to_string()
    } else {
        String::new()
    };
    if !test_locale.is_empty() && !matches!(test_locale.as_str(), "en-US" | "ru") {
        return 1;
    }
    let component_locale = if std::env::var_os("CHROMINIMUM_COMPONENT_ID").is_some() {
        match std::env::var("CHROMINIMUM_COMPONENT_LOCALE") {
            Ok(locale) if matches!(locale.as_str(), "en-US" | "ru") => locale,
            _ => return 1,
        }
    } else {
        String::new()
    };
    let install_locale = std::env::var("CHROMINIMUM_INSTALL_LOCALE").unwrap_or_default();
    if !install_locale.is_empty() && !matches!(install_locale.as_str(), "en-US" | "ru") {
        return 1;
    }
    let locale = if component_locale.is_empty() {
        if install_locale.is_empty() {
            test_locale.as_str()
        } else {
            install_locale.as_str()
        }
    } else {
        component_locale.as_str()
    };
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
    if !smoke {
        let _ = WINDOW_SIZE_PATH.set(directory.join("window-size"));
    }
    if smoke {
        let path = directory.join("smoke.log");
        if std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .and_then(|mut file| file.write_all(b"starting; sandbox_requested=true\n"))
            .is_err()
        {
            return 1;
        }
        let _ = SMOKE_LOG.set(path);
        if !component_locale.is_empty() {
            smoke_event(&format!("component_locale={component_locale}"));
        }
        if !test_locale.is_empty() {
            smoke_event(&format!("test_cef_locale={test_locale}"));
        }
        if !install_locale.is_empty() {
            smoke_event(&format!("installed_locale={install_locale}"));
        }
        #[cfg(target_os = "windows")]
        {
            // Stable CEF C API (15101+); not exposed by this cef-rs revision.
            unsafe extern "C" {
                fn cef_version_full() -> *const std::ffi::c_char;
            }
            let version = unsafe { cef_version_full() };
            if !version.is_null() {
                smoke_event(&format!(
                    "engine_version={}",
                    unsafe { std::ffi::CStr::from_ptr(version) }.to_string_lossy()
                ));
            }
        }
    }
    let profile = directory.join(if smoke { "profile-smoke" } else { "profile" });
    if std::fs::create_dir_all(&profile).is_err() {
        return 1;
    }
    let profile = profile.to_string_lossy();
    let log = directory.join("cef.log");
    let settings = Settings {
        no_sandbox: 0,
        background_color: 0xFFFFFFFF,
        command_line_args_disabled: 1,
        chrome_app_icon_id: 1,
        locale: CefString::from(locale),
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
    let net_log = if smoke && command.has_switch(Some(&CefString::from("test-net-log"))) != 0 {
        directory.join("netlog.json").to_string_lossy().into_owned()
    } else {
        String::new()
    };
    let trace_log =
        if smoke && command.has_switch(Some(&CefString::from("test-startup-trace"))) != 0 {
            directory
                .join("startup-trace.json")
                .to_string_lossy()
                .into_owned()
        } else {
            String::new()
        };
    let mut app = BrowserApp::new(initial_url, smoke, net_log, trace_log);
    #[cfg(target_os = "windows")]
    core_updates::configure(directory.clone());
    if initialize(
        Some(args.as_main_args()),
        Some(&settings),
        Some(&mut app),
        sandbox_info,
    ) != 1
    {
        let code = get_exit_code();
        return if code == sys::cef_resultcode_t::CEF_RESULT_CODE_NORMAL_EXIT_PROCESS_NOTIFIED as i32
        {
            0
        } else if code == 0 {
            1
        } else {
            code
        };
    }
    #[cfg(target_os = "windows")]
    core_updates::initialize(smoke);
    run_message_loop();
    #[cfg(target_os = "windows")]
    core_updates::shutdown_bridge();
    shutdown();
    smoke_event("shutdown_complete");
    0
}

wrap_app! {
    struct BrowserApp { url: String, smoke: bool, net_log: String, trace_log: String }
    impl App {
        fn on_before_command_line_processing(&self, process_type: Option<&CefString>, command: Option<&mut CommandLine>) {
            if self.smoke && std::env::args().any(|arg| arg == "--test-signin-log")
                && let Some(command) = command.as_ref() {
                command.append_switch_with_value(Some(&CefString::from("vmodule")), Some(&CefString::from("account_reconcilor=2,gaia_auth_fetcher=2,identity_manager=2,gaia_cookie_manager_service=2,sync_session_durations_metrics_recorder=2")));
            }
            // Chromium 154's AimEligibilityService constructor returns before
            // scheduling requests or observing identity changes when disabled.
            if let Some(command) = command.as_ref() {
                let disabled = CefString::from(&command.switch_value(Some(&CefString::from("disable-features")))).to_string();
                // Disable crowdsourcing queries/uploads, not local form input or
                // the password store. Chromium checks this before either request.
                // CEF 154 non-official builds enable raw_ptr instance tracing.
                // Lock timing's sampler can allocate recursively through that
                // tracer and BoringSSL; keep allocator checks and omit timing.
                let disabled = if disabled.is_empty() { "AimEnabled,AutofillServerCommunication,RecordLockAcquisitionTime".to_owned() } else { format!("{disabled},AimEnabled,AutofillServerCommunication,RecordLockAcquisitionTime") };
                command.remove_switch(Some(&CefString::from("disable-features")));
                command.append_switch_with_value(Some(&CefString::from("disable-features")), Some(&CefString::from(disabled.as_str())));
            }
            if self.smoke && std::env::args().any(|arg| arg == "--test-cdp")
                && let Some(command) = command.as_ref() {
                command.append_switch_with_value(Some(&CefString::from("remote-debugging-port")), Some(&CefString::from("0")));
                command.append_switch_with_value(Some(&CefString::from("remote-debugging-address")), Some(&CefString::from("127.0.0.1")));
                // Isolated media experiment only; ordinary launches keep the
                // default decoder order. CEF propagates features to children.
                if std::env::args().any(|arg| arg == "--test-platform-aac") {
                    let enabled = CefString::from(&command.switch_value(Some(&CefString::from("enable-features")))).to_string();
                    let enabled = if enabled.is_empty() { "ChroMinimumPlatformAudioFirst".to_owned() } else { format!("{enabled},ChroMinimumPlatformAudioFirst") };
                    command.append_switch_with_value(Some(&CefString::from("enable-features")), Some(&CefString::from(enabled.as_str())));
                }
            }
            // CEF removes application arguments with command_line_args_disabled.
            // Restore only our parsed target for ProcessSingleton's relaunch IPC.
            if process_type.is_none_or(|kind| kind.to_string().is_empty())
                && let Some(command) = command.as_ref() {
                command.append_switch_with_value(Some(&CefString::from("url")), Some(&CefString::from(self.url.as_str())));
                // Preserve only the explicit smoke probe opt-in for native
                // download geometry diagnostics; normal launches omit both.
                if self.smoke && std::env::args().any(|arg| arg == "--test-chrome-downloads") {
                    command.append_switch(Some(&CefString::from("smoke-test")));
                    command.append_switch(Some(&CefString::from("test-chrome-downloads")));
                }
                // Chromium 154 ExternalProviderImpl returns before registry and
                // bundled-extension providers. Do not globally disable extensions;
                // do not disable the separate security component updater.
                command.append_switch(Some(&CefString::from("disable-default-apps")));
            }
            // This variant is explicitly built for the verified system-codec core.
            // Apply in every process, including Chromium relaunch, without test flags.
            #[cfg(all(target_os = "windows", feature = "windows-platform-codecs"))]
            if let Some(command) = command.as_ref() {
                let enabled = CefString::from(&command.switch_value(Some(&CefString::from("enable-features")))).to_string();
                let disabled = CefString::from(&command.switch_value(Some(&CefString::from("disable-features")))).to_string();
                let (enabled, disabled) = platform_codecs::enforce_features(&enabled, &disabled);
                command.remove_switch(Some(&CefString::from("enable-features")));
                command.remove_switch(Some(&CefString::from("disable-features")));
                command.append_switch_with_value(Some(&CefString::from("enable-features")), Some(&CefString::from(enabled.as_str())));
                if !disabled.is_empty() {
                    command.append_switch_with_value(Some(&CefString::from("disable-features")), Some(&CefString::from(disabled.as_str())));
                }
            }
            #[cfg(target_os = "windows")]
            if let Some(command) = command.as_ref() {
                let enable = CefString::from(&command.switch_value(Some(&CefString::from("enable-features")))).to_string();
                let disable = CefString::from(&command.switch_value(Some(&CefString::from("disable-features")))).to_string();
                let (enable, disable) = network_sandbox::enforce_features(&enable, &disable);
                for (name, value) in [("enable-features", enable), ("disable-features", disable)] {
                    command.remove_switch(Some(&CefString::from(name)));
                    if !value.is_empty() { command.append_switch_with_value(Some(&CefString::from(name)), Some(&CefString::from(value.as_str()))); }
                }
            }
            if self.smoke && !self.trace_log.is_empty() && let Some(command) = command.as_ref() {
                    for (name, value) in [
                        ("trace-startup", "net,startup,toplevel,os_crypt,sql,base,disabled-by-default-toplevel.flow"),
                        ("trace-startup-format", "json"),
                        ("trace-startup-duration", "60"),
                        ("trace-startup-file", self.trace_log.as_str()),
                    ] {
                        command.append_switch_with_value(Some(&CefString::from(name)), Some(&CefString::from(value)));
                    }
            }
            if self.smoke && !self.net_log.is_empty() && let Some(command) = command {
                    command.append_switch_with_value(Some(&CefString::from("log-net-log")), Some(&CefString::from(self.net_log.as_str())));
            }
        }
        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            Some(ProcessHandler::new(self.url.clone(), self.smoke))
        }
    }
}

wrap_browser_process_handler! {
    struct ProcessHandler { url: String, smoke: bool }
    impl BrowserProcessHandler {
        fn on_before_child_process_launch(&self, _command: Option<&mut CommandLine>) {
            #[cfg(target_os = "windows")]
            if let Some(command) = _command {
                let subtype = CefString::from(&command.switch_value(Some(&CefString::from("utility-sub-type")))).to_string();
                let sandbox = CefString::from(&command.switch_value(Some(&CefString::from("service-sandbox-type")))).to_string();
                if network_sandbox::refuse_network_launch(&subtype, &sandbox) {
                    smoke_event("network_sandbox_refused");
                    eprintln!("Refusing unsandboxed network service; check installation read/execute permissions");
                    // Chromium retries unsandboxed after a failed sandbox launch. Stop
                    // before that child can be spawned; never unwind across this callback.
                    network_sandbox::terminate_refused_network();
                }
            }
        }
        fn on_context_initialized(&self) {
            open_window(&self.url, self.smoke);
        }
        fn on_already_running_app_relaunch(&self, command: Option<&mut CommandLine>, _current_directory: Option<&CefString>) -> i32 {
            let url = command.map(|c| CefString::from(&c.switch_value(Some(&CefString::from("url")))).to_string())
                .filter(|s| !s.is_empty()).unwrap_or_else(|| "about:blank".into());
            smoke_event("app_relaunch_received");
            open_window(&url, self.smoke);
            1
        }
    }
}

// Reuse the native single-page window for explicit shell relaunches.
fn open_window(url: &str, smoke: bool) {
    let nav = UiRef::new(RefCell::new(Navigation::default()));
    nav.borrow_mut().exercise_navigation = smoke && url.ends_with("/smoke.html");
    let mut client = BrowserClient::new(smoke, nav.clone());
    let mut delegate = PageDelegate::new();
    let mut view = browser_view_create(
        Some(&mut client),
        Some(&CefString::from(url)),
        Some(&BrowserSettings {
            background_color: 0xFFFFFFFF,
            ..Default::default()
        }),
        None,
        None,
        Some(&mut delegate),
    );
    let mut window_delegate = AppWindow::new(RefCell::new(view.take()), nav);
    window_create_top_level(Some(&mut window_delegate));
}

wrap_browser_view_delegate! {
    struct PageDelegate {}
    impl ViewDelegate {
        fn on_theme_changed(&self, view: Option<&mut View>) {
            // The transparent document canvas shows this Views layer. Keep the
            // fallback white even when Windows gives the browser a dark theme.
            if let Some(view) = view { view.set_background_color(0xFFFFFFFF); }
        }
    }
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
            saved_window_size()
        }
        fn minimum_size(&self, _view: Option<&mut View>) -> Size {
            Size { width: 640, height: 360 }
        }
    }
    impl PanelDelegate {}
    impl WindowDelegate {
        fn initial_bounds(&self, _window: Option<&mut Window>) -> Rect {
            let size = saved_window_size();
            Rect { x: 0, y: 0, width: size.width, height: size.height }
        }
        fn initial_show_state(&self, _window: Option<&mut Window>) -> ShowState {
            if saved_window_maximized() { ShowState::MAXIMIZED } else { ShowState::NORMAL }
        }

        fn with_standard_window_buttons(&self, _window: Option<&mut Window>) -> i32 { 1 }
        // cef-rs defaults these bool callbacks to 0, unlike the C++ delegate.
        // Set them explicitly so Windows exposes its normal frame controls.
        fn can_resize(&self, _window: Option<&mut Window>) -> i32 { 1 }
        fn can_maximize(&self, _window: Option<&mut Window>) -> i32 { 1 }
        fn can_minimize(&self, _window: Option<&mut Window>) -> i32 { 1 }
        fn on_window_fullscreen_transition(&self, window: Option<&mut Window>, is_completed: i32) {
            // Match cefclient: macOS notifies at the beginning and completion;
            // other platforms notify once after the synchronous transition.
            let should_change = if cfg!(target_os = "macos") { is_completed == 0 } else { is_completed != 0 };
            if !should_change { return; }
            let Some(window) = window else { return };
            let fullscreen = window.is_fullscreen() != 0;
            if let Some(toolbar) = window.view_for_id(NAVIGATION_TOOLBAR_ID) {
                toolbar.set_visible((!fullscreen).into());
                window.layout();
                smoke_event(if fullscreen { "fullscreen_toolbar_hidden" } else { "fullscreen_toolbar_restored" });
            }
            if fullscreen {
                let page = self.page.borrow().clone();
                if let Some(page) = page { page.request_focus(); }
            }
        }
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
                toolbar.set_id(NAVIGATION_TOOLBAR_ID);
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
            window.set_accelerator(1003, 74, 0, 1, 0, 1);
            window.layout();
            window.set_title(Some(&CefString::from(application_title(None).as_str())));
            window.show();
            window.layout();
            content.request_focus();
        }
        fn can_close(&self, _window: Option<&mut Window>) -> i32 {
            let page = self.page.borrow().clone();
            page.and_then(|p| p.browser()).and_then(|b| b.host())
                .map(|host| host.try_close_browser()).unwrap_or(1)
        }
        fn on_window_closing(&self, window: Option<&mut Window>) {
            if let Some(window) = window {
                let bounds = window.bounds();
                let maximized = window.is_maximized() != 0;
                #[cfg(target_os = "windows")]
                {
                    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowPlacement, WINDOWPLACEMENT, WPF_RESTORETOMAXIMIZED, SW_SHOWMAXIMIZED, SW_SHOWMINIMIZED};
                    let mut placement: WINDOWPLACEMENT = unsafe { std::mem::zeroed() };
                    placement.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
                    if unsafe { GetWindowPlacement(window.window_handle().0 as _, &mut placement) } != 0 {
                        let r = placement.rcNormalPosition;
                        let bounds = display_convert_screen_rect_from_pixels(Some(&Rect {
                            x: r.left, y: r.top, width: r.right-r.left, height: r.bottom-r.top,
                        }));
                        let maximized = placement.showCmd == SW_SHOWMAXIMIZED as u32
                            || (placement.showCmd == SW_SHOWMINIMIZED as u32 && placement.flags & WPF_RESTORETOMAXIMIZED != 0);
                        save_window_size(bounds.width, bounds.height, maximized);
                        return;
                    }
                }
                save_window_size(bounds.width, bounds.height, maximized);
            }
        }
        fn on_window_destroyed(&self, _window: Option<&mut Window>) {
            self.page.borrow_mut().take();
            let mut nav = self.nav.borrow_mut();
            nav.address = None; nav.back = None; nav.forward = None; nav.reload = None; nav.menu = None;
            nav.downloads = None;
        }
        fn on_accelerator(&self, _window: Option<&mut Window>, command_id: i32) -> i32 {
            if command_id == 1003 {
                navigate(&self.nav, "chrome://downloads/");
                return 1;
            }
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
        fn download_handler(&self) -> Option<DownloadHandler> { Some(DownloadAppearance::new(self.nav.clone())) }
        fn command_handler(&self) -> Option<CommandHandler> { Some(SinglePageCommands::new()) }
        fn display_handler(&self) -> Option<DisplayHandler> { Some(PageTitle::new(self.nav.clone())) }
        fn request_handler(&self) -> Option<RequestHandler> { Some(SinglePageLinks::new()) }
    }
}

wrap_download_handler! {
    struct DownloadAppearance { nav: Nav }
    impl DownloadHandler {
        // Match CEF's default; Chromium's own policy checks remain in control.
        fn can_download(&self, _browser: Option<&mut Browser>, _url: Option<&CefString>, _request_method: Option<&CefString>) -> i32 { 1 }
        // Default OnBeforeDownload=false retains Chrome's handling and dialog.
        fn on_download_updated(&self, _browser: Option<&mut Browser>, item: Option<&mut DownloadItem>, _callback: Option<&mut DownloadItemCallback>) {
            let Some(item) = item else { return };
            let (button, hidden, changed) = {
                let mut state = self.nav.borrow_mut();
                let was_hidden = !state.active_downloads.is_empty();
                if item.is_in_progress() != 0 {
                    state.active_downloads.insert(item.id());
                } else {
                    state.active_downloads.remove(&item.id());
                }
                let hidden = !state.active_downloads.is_empty();
                (state.downloads.clone(), hidden, hidden != was_hidden)
            };
            if changed {
                if let Some(button) = button {
                    let icon = if hidden { toolbar_style::Icon::DownloadHidden } else { toolbar_style::Icon::Download };
                    toolbar_style::apply(&button, icon, button.has_focus() != 0);
                }
                smoke_event(if hidden { "download_glyph_hidden" } else { "download_glyph_restored" });
            }
        }
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
                    let title_changed = {
                        let mut state = self.nav.borrow_mut();
                        let changed = state.title != title;
                        state.title = title.clone();
                        changed
                    };
                    if title == "ChroMinimum smoke JS OK" { smoke_event("fixture_javascript_ok"); }
                    if SMOKE_LOG.get().is_some() && std::env::args().any(|a| a == "--test-external-protocols")
                        && let Some(url) = title.strip_prefix("ChroMinimum test external address ")
                        && !EXTERNAL_ADDRESS_PROBED.swap(true, Ordering::Relaxed) {
                        let mut task = ExternalAddressProbe::new(self.nav.clone(), url.to_owned());
                        post_task(ThreadId::UI, Some(&mut task));
                    }
                    if title_changed && SMOKE_LOG.get().is_some() && std::env::args().any(|a| a == "--test-chrome-downloads") {
                        let action = match title.as_str() {
                            "ChroMinimum test downloads button" => 1,
                            "ChroMinimum test downloads shortcut" => 2,
                            "ChroMinimum test downloads resize" => 3,
                            _ => 0,
                        };
                        if action != 0 {
                            let mut task = DownloadsUiProbe::new(self.nav.clone(), action);
                            post_task(ThreadId::UI, Some(&mut task));
                        }
                    }
                    window.set_title(Some(&CefString::from(application_title(Some(&title)).as_str())));
            }
        }
    }
}

// Smoke-only invocation of the actual native delegates, without desktop input.
wrap_task! {
    struct ExternalAddressProbe { nav: Nav, url: String }
    impl Task {
        fn execute(&self) {
            let field = self.nav.borrow().address.clone();
            if let Some(mut field) = field {
                field.set_text(Some(&CefString::from(self.url.as_str())));
                AddressInput::new(self.nav.clone()).on_key_event(Some(&mut field), Some(&KeyEvent {
                    type_: KeyEventType::RAWKEYDOWN, windows_key_code: 13, ..Default::default()
                }));
                smoke_event("external_address_delegate_invoked");
            }
        }
    }
}

wrap_task! {
    struct DownloadsUiProbe { nav: Nav, action: i32 }
    impl Task {
        fn execute(&self) {
            if self.action == 1 {
                let button = self.nav.borrow().downloads.clone();
                if button.is_some_and(|b| b.id() == DOWNLOAD_ANCHOR_VIEW_ID && b.is_drawn() != 0 && b.image(ButtonState::NORMAL).is_some()) {
                    smoke_event("downloads_button_drawn");
                    NavigationButton::new(self.nav.clone(), 4).on_button_pressed(None);
                    smoke_event("downloads_button_pressed");
                }
            } else if self.action == 2 {
                let handled = AppWindow::new(RefCell::new(None), self.nav.clone()).on_accelerator(None, 1003);
                if handled != 0 { smoke_event("downloads_shortcut_handled"); }
            } else {
                let mut browser = self.nav.borrow().browser.clone();
                if let Some(view) = browser_view_get_for_browser(browser.as_mut())
                    && let Some(window) = view.window() {
                    let mut bounds = window.bounds();
                    bounds.width = 900; bounds.height = 600;
                    window.set_bounds(Some(&bounds)); window.layout();
                    smoke_event("downloads_window_resized");
                }
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
                    let (reload, menu) = { let state = self.nav.borrow(); (state.reload.clone(), state.menu.clone()) };
                    let has_states = |b: &LabelButton| [ButtonState::NORMAL, ButtonState::HOVERED, ButtonState::PRESSED, ButtonState::DISABLED]
                        .into_iter().all(|state| b.image(state).is_some());
                    let downloads = self.nav.borrow().downloads.clone();
                    let icons_drawn = [Some(back.clone()), Some(forward.clone()), reload, downloads].into_iter()
                        .all(|button| button.is_some_and(|b| b.is_drawn() != 0 && has_states(&b)));
                    let menu_drawn = menu.is_some_and(|b| b.is_drawn() != 0 && has_states(&LabelButton::from(&b)));
                    let drawn = field.is_drawn() != 0 && back.is_drawn() != 0 && forward.is_drawn() != 0
                        && bounds.width > 100 && bounds.height >= 24 && icons_drawn && menu_drawn;
                    if drawn {
                        smoke_event("toolbar_icons_and_menu_drawn");
                        smoke_event("toolbar_state_images_present");
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
                    #[cfg(target_os = "windows")]
                    if std::env::args().any(|a| a == "--exercise-updater") {
                        BrowserMenuModel::new().execute_command(None, 1, EventFlags::default());
                        smoke_event("core_update_button_pressed");
                    }
                    if cfg!(target_os = "windows") && let Some(window) = field.window() {
                        let original = window.bounds();
                        let mut probe = WindowProbe::new(window, original, 0, browser.clone());
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
    struct WindowProbe { window: Window, original: Rect, step: i32, browser: Browser }
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
                    // Finish the smoke after its assertions, not on a timer racing page load.
                    if !std::env::args().any(|a| a == "--exercise-updater") {
                        let mut close = SmokeClose::new(self.browser.clone());
                        post_delayed_task(ThreadId::UI, Some(&mut close), 250);
                    }
                    return;
                }
                _ => false,
            };
            if ok {
                let mut next = WindowProbe::new(self.window.clone(), self.original.clone(), self.step + 1, self.browser.clone());
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

// Only explicit web-link gestures may replace the current page. Never promote
// script URLs, local files or unsolicited popups to top-level navigation.
fn queue_web_link(
    browser: Option<&mut Browser>,
    source_frame: Option<&mut Frame>,
    url: Option<&CefString>,
    user_gesture: i32,
) {
    if user_gesture == 0 {
        return;
    }
    let Some(url) = url else { return };
    let text = url.to_string();
    let scheme = text.split(':').next().unwrap_or_default();
    if !scheme.eq_ignore_ascii_case("http")
        && !scheme.eq_ignore_ascii_case("https")
        && !external_protocol::is_external(&text)
    {
        return;
    }
    if let Some(browser) = browser {
        let source_frame = if external_protocol::is_external(&text) {
            source_frame.cloned()
        } else {
            None
        };
        if external_protocol::is_external(&text) && source_frame.is_none() {
            return;
        }
        let source_url = source_frame
            .as_ref()
            .map(|f| CefString::from(&f.url()).to_string())
            .unwrap_or_default();
        let mut task = FollowWebLink::new(browser.clone(), source_frame, source_url, text);
        post_task(ThreadId::UI, Some(&mut task));
    }
}

wrap_task! {
    struct FollowWebLink { browser: Browser, source_frame: Option<Frame>, source_url: String, url: String }
    impl Task {
        fn execute(&self) {
            if let Some(frame) = &self.source_frame {
                if frame.is_valid() != 0 && external_protocol::without_fragment(&CefString::from(&frame.url()).to_string()) == external_protocol::without_fragment(&self.source_url) {
                    // Navigate in the real initiating document. CEF LoadURL and
                    // LoadRequest discard its initiator/sandbox context. Escape
                    // every UTF-16 unit, so URL text cannot become script code.
                    let code = external_protocol::renderer_navigation(&self.url, &self.source_url);
                    frame.execute_java_script(Some(&CefString::from(code.as_str())), None, 0);
                }
                return;
            }
            if let Some(frame) = self.browser.main_frame() {
                frame.load_url(Some(&CefString::from(self.url.as_str())));
            }
        }
    }
}

// CEF delegates to Chrome's ExternalProtocolHandler. Consent, OS association
// lookup and launch remain in Chromium; never call ShellExecute from our UI.
wrap_resource_request_handler! {
    struct ExternalProtocols;
    impl ResourceRequestHandler {
        fn on_before_resource_load(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, _request: Option<&mut Request>, _callback: Option<&mut Callback>) -> ReturnValue { ReturnValue::CONTINUE }
        fn on_protocol_execution(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, request: Option<&mut Request>, allow_os_execution: Option<&mut i32>) {
            let Some(request) = request else { return };
            let url = CefString::from(&request.url()).to_string();
            if external_protocol::is_external(&url) {
                if let Some(allow) = allow_os_execution { *allow = 1; }
                smoke_event("external_protocol_delegated_to_chrome");
            }
        }
    }
}

wrap_request_handler! {
    struct SinglePageLinks;
    impl RequestHandler {
        fn resource_request_handler(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, request: Option<&mut Request>, _is_navigation: i32, _is_download: i32, _request_initiator: Option<&CefString>, _disable_default_handling: Option<&mut i32>) -> Option<ResourceRequestHandler> {
            request.filter(|r| external_protocol::is_external(&CefString::from(&r.url()).to_string())).map(|r| {
                if SMOKE_LOG.get().is_some() {
                    let origin = _request_initiator.map(CefString::to_string).unwrap_or_default();
                    smoke_event(&format!("external_request_metadata; transition={:#x}; origin_empty={}; origin_opaque={}; navigation={}", r.transition_type().get_raw(), origin.is_empty(), origin == "null", _is_navigation));
                }
                smoke_event("external_resource_handler_created"); ExternalProtocols::new()
            })
        }
        fn on_before_browse(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, request: Option<&mut Request>, _user_gesture: i32, _is_redirect: i32) -> i32 {
            if SMOKE_LOG.get().is_some() && std::env::args().any(|a| a == "--test-external-protocols")
                && request.as_ref().is_some_and(|r| {
                    let url = CefString::from(&r.url()).to_string();
                    url.starts_with("http://chrominimum-probe-") || url.starts_with("https://chrominimum-probe-")
                }) {
                smoke_event("test_numeric_protocol_rewritten_as_web_blocked");
                return 1;
            }
            if request.is_some_and(|r| external_protocol::is_external(&CefString::from(&r.url()).to_string())) { smoke_event("external_before_browse_allowed"); }
            0
        }
        fn on_open_urlfrom_tab(&self, browser: Option<&mut Browser>, frame: Option<&mut Frame>, target_url: Option<&CefString>, _target_disposition: WindowOpenDisposition, user_gesture: i32) -> i32 {
            queue_web_link(browser, frame, target_url, user_gesture);
            1
        }
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
                    // Navigation closes on WindowProbe completion; retain a bounded watchdog.
                    let timeout = if std::env::args().any(|a| a == "--test-chrome-downloads" || a == "--test-external-protocols") {
                        600000
                    } else if std::env::args().any(|a| a == "--exercise-updater") {
                        120000
                    } else if self.nav.borrow().exercise_navigation {
                        45000
                    } else {
                        30000
                    };
                    post_delayed_task(ThreadId::UI, Some(&mut close), timeout);
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
        // User-initiated web links reuse this window; unsolicited popups remain blocked.
        fn on_before_popup(
            &self, browser: Option<&mut Browser>, frame: Option<&mut Frame>, _popup_id: i32,
            target_url: Option<&CefString>, _target_frame_name: Option<&CefString>,
            _target_disposition: WindowOpenDisposition, user_gesture: i32,
            _popup_features: Option<&PopupFeatures>, _window_info: Option<&mut WindowInfo>,
            _client: Option<&mut Option<Client>>, _settings: Option<&mut BrowserSettings>,
            _extra_info: Option<&mut Option<DictionaryValue>>, _no_javascript_access: Option<&mut i32>,
        ) -> i32 {
            queue_web_link(browser, frame, target_url, user_gesture);
            1
        }
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
                let (label, icon) = if loading != 0 {
                    ("Остановить", toolbar_style::Icon::Stop)
                } else {
                    ("Обновить", toolbar_style::Icon::Reload)
                };
                let label = CefString::from(label);
                button.set_accessible_name(Some(&label));
                button.set_tooltip_text(Some(&label));
                toolbar_style::apply(&button, icon, button.has_focus() != 0);
            }
        }
        fn on_load_end(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, status: i32) {
            if let Some(frame) = frame.as_ref() && frame.is_main() != 0 {
                smoke_event(&format!("main_frame_url={}", CefString::from(&frame.url())));
            }
            if frame.is_some_and(|f| f.is_main() != 0) {
                #[cfg(target_os = "windows")]
                if (0..400).contains(&status) {
                    core_updates::healthy();
                }
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
                #[cfg(target_os = "windows")]
                core_updates::healthy(); // A network/TLS failure is not a failed engine startup.
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
