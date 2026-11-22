//! ChroMinimum settings page `chrominimum://settings/` (D046).
//!
//! The page and its assets are embedded; nothing is read from disk or the
//! network. Its API accepts POST requests only from the main frame of the one
//! settings window, initiated by this page's origin (the request initiator
//! the browser process holds); every other request gets 403 or 404. Engine pages are links the browser process loads itself, from a
//! fixed list, because a page of a custom scheme may not navigate to chrome://.
use cef::*;
use std::{
    cell::RefCell,
    sync::{
        Arc, Mutex,
        atomic::{AtomicI32, Ordering},
    },
};

pub const SCHEME: &str = "chrominimum";
pub const HOST: &str = "settings";
pub const URL: &str = "chrominimum://settings/";
/// The serialized origin of the page, as a request initiator.
const ORIGIN: &str = "chrominimum://settings";

const PAGE: &[u8] = include_bytes!("settings_page/index.html");
const STYLE: &[u8] = include_bytes!("settings_page/settings.css");
const SCRIPT: &[u8] = include_bytes!("settings_page/settings.js");
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/// Engine settings linked from the page: (key, chrome:// address).
pub const ENGINE_PAGES: [(&str, &str); 9] = [
    ("passwords", "chrome://password-manager/passwords"),
    ("content", "chrome://settings/content"),
    ("clear", "chrome://settings/clearBrowserData"),
    ("privacy", "chrome://settings/privacy"),
    ("downloads", "chrome://settings/downloads"),
    ("languages", "chrome://settings/languages"),
    ("fonts", "chrome://settings/fonts"),
    ("appearance", "chrome://settings/appearance"),
    ("certificates", "chrome://certificate-manager/"),
];

#[derive(Debug, PartialEq)]
pub enum Route {
    Asset(&'static str, &'static [u8]),
    Api(Call),
    NotFound,
}

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Call {
    State,
    Prewarm(bool),
    CheckUpdates,
    Open(&'static str),
}

pub fn engine_page(key: &str) -> Option<&'static str> {
    ENGINE_PAGES
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, url)| *url)
}

/// Exact paths only; anything else, including other query strings, is 404.
pub fn route(method: &str, url: &str) -> Route {
    let Some(rest) = url.strip_prefix(URL) else {
        return Route::NotFound;
    };
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    match (method, path, query) {
        ("GET", "", "") => Route::Asset("text/html", PAGE),
        ("GET", "settings.css", "") => Route::Asset("text/css", STYLE),
        ("GET", "settings.js", "") => Route::Asset("text/javascript", SCRIPT),
        ("POST", "api/state", "") => Route::Api(Call::State),
        ("POST", "api/prewarm", "on=1") => Route::Api(Call::Prewarm(true)),
        ("POST", "api/prewarm", "on=0") => Route::Api(Call::Prewarm(false)),
        ("POST", "api/updates/check", "") => Route::Api(Call::CheckUpdates),
        ("POST", "api/open", query) => query
            .strip_prefix("target=")
            .and_then(engine_page)
            .map_or(Route::NotFound, |url| Route::Api(Call::Open(url))),
        _ => Route::NotFound,
    }
}

/// Receiver-side check for API calls (AGENTS.md): the settings browser, its
/// main frame, and that frame currently showing this page.
/// The initiator, not the frame's URL: CefFrame::GetURL may still hold the
/// previous address while the new page's first requests arrive.
pub fn api_allowed(settings_browser: bool, main_frame: bool, initiator: &str) -> bool {
    settings_browser && main_frame && initiator == ORIGIN
}

/// Any address of this scheme. Only the settings window may load one.
pub fn is_internal(url: &str) -> bool {
    url.trim_start()
        .get(..SCHEME.len() + 1)
        .is_some_and(|start| start.eq_ignore_ascii_case("chrominimum:"))
}

/// An address the user typed that means "open the settings".
pub fn is_settings_address(text: &str) -> bool {
    let text = text.trim();
    let Some(start) = text.get(..URL.len() - 1) else {
        return false;
    };
    start.eq_ignore_ascii_case("chrominimum://settings")
        && matches!(text.as_bytes().get(URL.len() - 1), None | Some(b'/'))
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct State {
    pub prewarm_available: bool,
    pub prewarm_on: bool,
    pub updates_label: String,
    pub updates_hint: String,
    pub updates_enabled: bool,
    pub version: String,
    pub engine: String,
}

fn json_string(out: &mut String, value: &str) {
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '<' => out.push_str("\\u003c"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

pub fn state_json(state: &State) -> String {
    let mut out = String::from("{");
    for (i, (name, value)) in [
        ("prewarmAvailable", state.prewarm_available),
        ("prewarmOn", state.prewarm_on),
        ("updatesEnabled", state.updates_enabled),
    ]
    .into_iter()
    .enumerate()
    {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&format!("\"{name}\":{value}"));
    }
    for (name, value) in [
        ("updatesLabel", &state.updates_label),
        ("updatesHint", &state.updates_hint),
        ("version", &state.version),
        ("engine", &state.engine),
    ] {
        out.push_str(&format!(",\"{name}\":"));
        json_string(&mut out, value);
    }
    out.push('}');
    out
}

// --- CEF glue -------------------------------------------------------------

/// Identifier of the settings browser; CEF identifiers start at 1.
static BROWSER_ID: AtomicI32 = AtomicI32::new(0);

#[derive(Default)]
enum Slot {
    #[default]
    Closed,
    Opening,
    Open(Browser),
}

thread_local! { static WINDOW: RefCell<Slot> = const { RefCell::new(Slot::Closed) }; }

/// UI thread. Returns false while a settings window exists or is being made.
pub fn begin_open() -> bool {
    WINDOW.with_borrow_mut(|slot| match slot {
        Slot::Closed => {
            *slot = Slot::Opening;
            true
        }
        _ => false,
    })
}

pub fn open_failed() {
    WINDOW.with_borrow_mut(|slot| *slot = Slot::Closed);
}

pub fn opened(browser: &Browser) {
    BROWSER_ID.store(browser.identifier(), Ordering::Relaxed);
    WINDOW.with_borrow_mut(|slot| *slot = Slot::Open(browser.clone()));
}

pub fn closed() {
    BROWSER_ID.store(0, Ordering::Relaxed);
    WINDOW.with_borrow_mut(|slot| *slot = Slot::Closed);
}

pub fn browser() -> Option<Browser> {
    WINDOW.with_borrow(|slot| match slot {
        Slot::Open(browser) => Some(browser.clone()),
        _ => None,
    })
}

pub fn is_settings_browser(id: i32) -> bool {
    id != 0 && BROWSER_ID.load(Ordering::Relaxed) == id
}

/// UI thread: tell an open settings page that shell state changed. An event,
/// not polling; the page then asks for the state again.
pub fn notify_state() {
    let Some(frame) = browser().and_then(|b| b.main_frame()) else {
        return;
    };
    if !CefString::from(&frame.url()).to_string().starts_with(URL) {
        return;
    }
    frame.execute_java_script(
        Some(&CefString::from(
            "document.dispatchEvent(new Event('chrominimum-state'))",
        )),
        Some(&CefString::from(URL)),
        0,
    );
}

pub fn register_scheme(registrar: Option<&mut SchemeRegistrar>) {
    use sys::cef_scheme_options_t as o;
    let Some(registrar) = registrar else { return };
    // Standard and secure like chrome://; no CORS, so web pages cannot fetch
    // it, and display-isolated, so they cannot link or frame it either.
    let options = o::CEF_SCHEME_OPTION_STANDARD as i32
        | o::CEF_SCHEME_OPTION_SECURE as i32
        | o::CEF_SCHEME_OPTION_DISPLAY_ISOLATED as i32
        | o::CEF_SCHEME_OPTION_FETCH_ENABLED as i32;
    registrar.add_custom_scheme(Some(&CefString::from(SCHEME)), options);
}

/// Browser process, after CefInitialize.
pub fn register_handler() -> bool {
    let mut factory = SettingsScheme::new();
    register_scheme_handler_factory(
        Some(&CefString::from(SCHEME)),
        Some(&CefString::from(HOST)),
        Some(&mut factory),
    ) == 1
}

fn current_state() -> State {
    let mut state = State {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        engine: super::cef_version().to_owned(),
        ..Default::default()
    };
    #[cfg(target_os = "windows")]
    {
        let (label, hint, enabled) = super::core_updates::settings_state();
        state.updates_label = label.to_owned();
        state.updates_hint = hint.to_owned();
        state.updates_enabled = enabled;
        if let Some(launcher) = super::core_updates::launcher() {
            state.prewarm_available = true;
            state.prewarm_on =
                super::login_prewarm::enabled(launcher, super::SMOKE_LOG.get().is_some());
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        state.updates_label = "Обновления ядра доступны в Windows".to_owned();
    }
    state
}

/// Runs off the UI and IO threads (CefResourceHandler::Open).
fn execute(call: Call) -> String {
    match call {
        Call::State => {}
        Call::Prewarm(on) => {
            #[cfg(target_os = "windows")]
            if let Some(launcher) = super::core_updates::launcher() {
                let test = super::SMOKE_LOG.get().is_some();
                let saved = super::login_prewarm::set(launcher, on, test);
                super::smoke_event(&format!(
                    "settings_api; call=prewarm; on={}; saved={saved}",
                    super::login_prewarm::enabled(launcher, test)
                ));
            }
            #[cfg(not(target_os = "windows"))]
            let _ = on;
        }
        Call::CheckUpdates | Call::Open(_) => {
            let mut task = UiCall::new(call);
            post_task(ThreadId::UI, Some(&mut task));
        }
    }
    state_json(&current_state())
}

wrap_task! {
    struct UiCall { call: Call }
    impl Task {
        fn execute(&self) {
            match self.call {
                Call::CheckUpdates => {
                    super::smoke_event("settings_api; call=updates");
                    #[cfg(target_os = "windows")]
                    super::core_updates::check();
                }
                Call::Open(url) => {
                    let Some(frame) = browser().and_then(|b| b.main_frame()) else { return };
                    frame.load_url(Some(&CefString::from(url)));
                    super::smoke_event(&format!("settings_api; call=open; url={url}"));
                }
                _ => {}
            }
        }
    }
}

#[derive(Default)]
struct Reply {
    status: i32,
    mime: &'static str,
    asset: bool,
    /// An allowed API call, run once in Open.
    pending: Option<Call>,
    body: Vec<u8>,
    offset: usize,
}

/// Serves one chrominimum:// request. `initiator` comes from
/// CefRequestHandler::GetResourceRequestHandler; the scheme factory has none,
/// so API calls that reach it are refused.
fn handler(
    browser: Option<&mut Browser>,
    frame: Option<&mut Frame>,
    request: Option<&mut Request>,
    initiator: &str,
) -> Option<ResourceHandler> {
    let request = request?;
    let method = CefString::from(&request.method()).to_string();
    let url = CefString::from(&request.url()).to_string();
    let settings = browser.is_some_and(|b| is_settings_browser(b.identifier()));
    let mut reply = Reply {
        status: 404,
        mime: "text/plain",
        ..Default::default()
    };
    match route(&method, &url) {
        Route::Asset(mime, body) if settings => {
            reply = Reply {
                status: 200,
                mime,
                asset: true,
                body: body.to_vec(),
                ..Default::default()
            };
        }
        Route::Api(call) => {
            let main = frame.is_some_and(|f| f.is_main() != 0);
            if api_allowed(settings, main, initiator) {
                reply = Reply {
                    status: 200,
                    mime: "application/json",
                    pending: Some(call),
                    ..Default::default()
                };
            } else {
                reply.status = 403;
                super::smoke_event(&format!(
                    "settings_api_refused; settings_browser={settings}; main_frame={main}; initiator={initiator}"
                ));
            }
        }
        _ => {}
    }
    Some(SettingsResource::new(Arc::new(Mutex::new(reply))))
}

wrap_scheme_handler_factory! {
    struct SettingsScheme;
    impl SchemeHandlerFactory {
        fn create(&self, browser: Option<&mut Browser>, frame: Option<&mut Frame>, _scheme_name: Option<&CefString>, request: Option<&mut Request>) -> Option<ResourceHandler> {
            handler(browser, frame, request, "")
        }
    }
}

wrap_resource_request_handler! {
    struct SettingsRequest { initiator: String }
    impl ResourceRequestHandler {
        // The generated default is RV_CANCEL.
        fn on_before_resource_load(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, _request: Option<&mut Request>, _callback: Option<&mut Callback>) -> ReturnValue {
            ReturnValue::CONTINUE
        }
        fn resource_handler(&self, browser: Option<&mut Browser>, frame: Option<&mut Frame>, request: Option<&mut Request>) -> Option<ResourceHandler> {
            handler(browser, frame, request, &self.initiator)
        }
    }
}

/// For CefRequestHandler::GetResourceRequestHandler on a chrominimum:// URL.
pub fn request_handler(initiator: Option<&CefString>) -> ResourceRequestHandler {
    SettingsRequest::new(initiator.map(CefString::to_string).unwrap_or_default())
}

wrap_resource_handler! {
    struct SettingsResource { reply: Arc<Mutex<Reply>> }
    impl ResourceHandler {
        fn open(&self, _request: Option<&mut Request>, handle_request: Option<&mut i32>, _callback: Option<&mut Callback>) -> i32 {
            let mut reply = self.reply.lock().unwrap();
            if let Some(call) = reply.pending.take() {
                reply.body = execute(call).into_bytes();
            }
            if let Some(handle) = handle_request { *handle = 1; }
            1
        }
        fn response_headers(&self, response: Option<&mut Response>, response_length: Option<&mut i64>, _redirect_url: Option<&mut CefString>) {
            let reply = self.reply.lock().unwrap();
            let Some(response) = response else { return };
            response.set_status(reply.status);
            response.set_mime_type(Some(&CefString::from(reply.mime)));
            response.set_charset(Some(&CefString::from("utf-8")));
            let mut headers = vec![("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff")];
            if reply.asset { headers.push(("Content-Security-Policy", CSP)); }
            for (name, value) in headers {
                response.set_header_by_name(Some(&CefString::from(name)), Some(&CefString::from(value)), 1);
            }
            if let Some(length) = response_length { *length = reply.body.len() as i64; }
        }
        #[allow(clippy::not_unsafe_ptr_arg_deref)]
        fn read(&self, data_out: *mut u8, bytes_to_read: i32, bytes_read: Option<&mut i32>, _callback: Option<&mut ResourceReadCallback>) -> i32 {
            let Some(bytes_read) = bytes_read else { return 0 };
            *bytes_read = 0;
            let mut reply = self.reply.lock().unwrap();
            let remaining = reply.body.len() - reply.offset;
            let count = remaining.min(usize::try_from(bytes_to_read).unwrap_or(0));
            if count == 0 || data_out.is_null() { return 0; }
            // CEF provides a writable buffer of at least bytes_to_read bytes.
            unsafe { std::ptr::copy_nonoverlapping(reply.body.as_ptr().add(reply.offset), data_out, count); }
            reply.offset += count;
            *bytes_read = count as i32;
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_exact_paths() {
        assert!(matches!(route("GET", URL), Route::Asset("text/html", _)));
        assert!(matches!(
            route("GET", "chrominimum://settings/settings.js"),
            Route::Asset("text/javascript", _)
        ));
        assert_eq!(
            route("POST", "chrominimum://settings/api/state"),
            Route::Api(Call::State)
        );
        assert_eq!(
            route("POST", "chrominimum://settings/api/prewarm?on=1"),
            Route::Api(Call::Prewarm(true))
        );
        assert_eq!(
            route("POST", "chrominimum://settings/api/prewarm?on=0"),
            Route::Api(Call::Prewarm(false))
        );
        assert_eq!(
            route("POST", "chrominimum://settings/api/open?target=clear"),
            Route::Api(Call::Open("chrome://settings/clearBrowserData"))
        );
    }

    #[test]
    fn refuses_other_methods_paths_and_targets() {
        for (method, url) in [
            ("GET", "chrominimum://settings/api/state"),
            ("POST", URL),
            ("POST", "chrominimum://settings/api/prewarm"),
            ("POST", "chrominimum://settings/api/prewarm?on=2"),
            ("POST", "chrominimum://settings/api/prewarm?on=1&x=1"),
            (
                "POST",
                "chrominimum://settings/api/open?target=chrome://flags/",
            ),
            ("POST", "chrominimum://settings/api/open?target=flags"),
            ("GET", "chrominimum://settings/../secret"),
            ("GET", "chrominimum://other/"),
            ("GET", "https://settings/"),
            ("GET", "chrominimum://settings/?x"),
        ] {
            assert_eq!(route(method, url), Route::NotFound, "{method} {url}");
        }
    }

    #[test]
    fn api_requires_settings_main_frame_on_this_page() {
        assert!(api_allowed(true, true, ORIGIN));
        assert!(!api_allowed(false, true, ORIGIN));
        assert!(!api_allowed(true, false, ORIGIN));
        assert!(!api_allowed(true, true, "chrome://settings"));
        assert!(!api_allowed(true, true, "https://example.com"));
        assert!(!api_allowed(true, true, "chrominimum://settingsx"));
        assert!(!api_allowed(true, true, URL));
        assert!(!api_allowed(true, true, "null"));
        assert!(!api_allowed(true, true, ""));
    }

    #[test]
    fn recognises_internal_and_settings_addresses() {
        assert!(is_internal("chrominimum://settings/"));
        assert!(is_internal(" ChroMinimum:anything"));
        assert!(!is_internal("https://chrominimum.download/"));
        assert!(!is_internal("chrominimum"));
        assert!(is_settings_address("chrominimum://settings"));
        assert!(is_settings_address(" CHROMINIMUM://Settings/ "));
        assert!(!is_settings_address("chrominimum://settingsx"));
        assert!(!is_settings_address("chrominimum://other/"));
        assert!(!is_settings_address("settings"));
    }

    #[test]
    fn engine_pages_are_chrome_addresses() {
        for (key, url) in ENGINE_PAGES {
            assert!(url.starts_with("chrome://"), "{key}");
            assert_eq!(engine_page(key), Some(url));
        }
    }

    #[test]
    fn state_is_escaped_json() {
        let json = state_json(&State {
            prewarm_available: true,
            updates_label: "a\"b\\c</script>\n".into(),
            ..Default::default()
        });
        assert_eq!(
            json,
            "{\"prewarmAvailable\":true,\"prewarmOn\":false,\"updatesEnabled\":false,\"updatesLabel\":\"a\\\"b\\\\c\\u003c/script>\\u000a\",\"updatesHint\":\"\",\"version\":\"\",\"engine\":\"\"}"
        );
    }
}
