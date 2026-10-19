//! CEF-required NSApplication protocols, adapted from cef-rs cefsimple.
use cef::application_mac::{CefAppProtocol, CrAppControlProtocol, CrAppProtocol};
use cef::{Browser, ImplBrowser, ImplBrowserHost};
use objc2::{
    ClassType, DefinedClass, MainThreadMarker, define_class, extern_methods, msg_send,
    rc::Retained,
    runtime::{AnyObject, Bool, NSObjectProtocol},
};
use objc2_app_kit::{NSApp, NSApplication, NSEvent};
use std::cell::{Cell, RefCell};

thread_local! { static BROWSER: RefCell<Option<Browser>> = const { RefCell::new(None) }; }

pub fn set_browser(browser: Option<Browser>) {
    BROWSER.with(|state| *state.borrow_mut() = browser);
}

#[derive(Default)]
pub struct ApplicationIvars {
    handling_event: Cell<Bool>,
}

define_class!(
    #[unsafe(super(NSApplication))]
    #[ivars = ApplicationIvars]
    pub struct BrowserApplication;

    impl BrowserApplication {
        #[unsafe(method(sendEvent:))]
        unsafe fn send_event(&self, event: &NSEvent) {
            let previous = self.ivars().handling_event.replace(Bool::YES);
            let _: () = unsafe { msg_send![super(self), sendEvent:event] };
            self.ivars().handling_event.set(previous);
        }

        #[unsafe(method(terminate:))]
        unsafe fn terminate(&self, _sender: &AnyObject) {
            let browser = BROWSER.with(|state| state.borrow().clone());
            if let Some(browser) = browser && let Some(host) = browser.host() { host.close_browser(0); }
        }
    }

    unsafe impl CrAppProtocol for BrowserApplication {
        #[unsafe(method(isHandlingSendEvent))]
        unsafe fn handling_event(&self) -> Bool { self.ivars().handling_event.get() }
    }
    unsafe impl CrAppControlProtocol for BrowserApplication {
        #[unsafe(method(setHandlingSendEvent:))]
        unsafe fn set_handling_event(&self, value: Bool) { self.ivars().handling_event.set(value); }
    }
    unsafe impl CefAppProtocol for BrowserApplication {}
);

impl BrowserApplication {
    extern_methods! {
        #[unsafe(method(sharedApplication))]
        fn shared_application() -> Retained<Self>;
    }
}

pub fn setup() {
    let _ = BrowserApplication::shared_application();
    assert!(
        NSApp(MainThreadMarker::new().expect("main thread"))
            .isKindOfClass(BrowserApplication::class())
    );
}
