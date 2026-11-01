//! Browser-side bridge: no networking, crypto or archive dependencies here.
use cef::*;
use std::{
    cell::RefCell,
    io::{BufRead, BufReader, Read},
    path::PathBuf,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime},
};

thread_local! { static MENU_MODEL: RefCell<Option<MenuModel>> = const { RefCell::new(None) }; }
static CONTEXT: OnceLock<(PathBuf, PathBuf)> = OnceLock::new();
static POSTING: Mutex<bool> = Mutex::new(false);
static BUSY: AtomicBool = AtomicBool::new(false);
static HEALTHY: AtomicBool = AtomicBool::new(false);
static MENU_LABEL: Mutex<&str> = Mutex::new("Проверить обновления ядра");

pub fn runtime_lease() -> std::io::Result<Option<std::fs::File>> {
    if CONTEXT.get().is_none() && std::env::var_os("CHROMINIMUM_LAUNCHER").is_none() {
        return Ok(None);
    }
    let executable = std::env::current_exe()?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(
            executable
                .parent()
                .ok_or_else(|| std::io::Error::other("No core directory"))?
                .join("core-running.lock"),
        )?;
    file.try_lock_shared().map_err(std::io::Error::other)?;
    if let Some(signal) = std::env::var_os("CHROMINIMUM_STARTED") {
        std::fs::write(signal, b"ready")?;
    }
    Ok(Some(file))
}

pub fn configure(directory: PathBuf) {
    // The modular launcher is offline until its own delivery channel is implemented.
    if std::env::var_os("CHROMINIMUM_COMPONENT_ID").is_some() {
        return;
    }
    let directory = std::env::var_os("CHROMINIMUM_CORE_ROOT")
        .map(PathBuf::from)
        .unwrap_or(directory);
    if let Some(launcher) = std::env::var_os("CHROMINIMUM_LAUNCHER") {
        let _ = CONTEXT.set((PathBuf::from(launcher), directory));
    }
}

pub fn initialize(smoke: bool) {
    if CONTEXT.get().is_some() {
        *POSTING.lock().unwrap() = true;
        set_menu_label("Проверить обновления ядра", true);
        if !smoke {
            let mut task = AutomaticCheck::new();
            post_delayed_task(ThreadId::UI, Some(&mut task), 60_000);
        }
    }
}
pub fn menu_model(model: MenuModel) {
    if CONTEXT.get().is_none() {
        let label = if std::env::var_os("CHROMINIMUM_COMPONENT_ID").is_some() {
            "Обновления этой установки пока недоступны"
        } else {
            "Для обновлений запустите браузер через загрузчик ChroMinimum"
        };
        model.set_label(1, Some(&CefString::from(label)));
        model.set_enabled(1, 0);
    } else {
        model.set_enabled(1, i32::from(!BUSY.load(Ordering::Relaxed)));
    }
    MENU_MODEL.with(|slot| *slot.borrow_mut() = Some(model));
}
pub fn shutdown_bridge() {
    *POSTING.lock().unwrap() = false;
    MENU_MODEL.with(|slot| slot.borrow_mut().take());
}
pub fn healthy() {
    if HEALTHY.swap(true, Ordering::Relaxed) {
        return;
    }
    if let (Ok(id), Ok(ready)) = (
        std::env::var("CHROMINIMUM_COMPONENT_ID"),
        std::env::var("CHROMINIMUM_COMPONENT_READY"),
    ) {
        if super::component_ready::send(std::io::stdout(), &id, &ready).is_ok() {
            super::smoke_event("component_readiness_reported");
        }
        return;
    }
    if let (Some((_, directory)), Ok(sequence)) =
        (CONTEXT.get(), std::env::var("CHROMINIMUM_CORE_SEQUENCE"))
        && sequence.parse::<u64>().is_ok()
    {
        let _ = std::fs::write(directory.join("core-health"), sequence);
    }
}
fn status(code: &str) {
    let enabled = POSTING.lock().unwrap();
    if !*enabled {
        return;
    }
    let mut task = UpdateStatus::new(code.to_owned());
    post_task(ThreadId::UI, Some(&mut task));
}
fn set_menu_label(label: &'static str, enabled: bool) {
    *MENU_LABEL.lock().unwrap() = label;
    MENU_MODEL.with(|slot| {
        if let Some(model) = slot.borrow().as_ref() {
            model.set_label(1, Some(&CefString::from(label)));
            model.set_enabled(1, i32::from(enabled));
        }
    });
}
pub fn current_menu_label() -> &'static str {
    *MENU_LABEL.lock().unwrap()
}
pub fn check() {
    if !*POSTING.lock().unwrap() {
        return;
    }
    let Some((launcher, _)) = CONTEXT.get() else {
        return;
    };
    if BUSY.swap(true, Ordering::Relaxed) {
        return;
    }
    status("checking");
    let launcher = launcher.clone();
    if std::thread::Builder::new()
        .name("core-update".into())
        .spawn(move || {
            use std::os::windows::process::CommandExt;
            let result = (|| -> std::io::Result<()> {
                let mut child = std::process::Command::new(launcher)
                    .arg("--check")
                    .creation_flags(0x08004000) // CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::null())
                    .spawn()?;
                if let Some(stdout) = child.stdout.take() {
                    for line in BufReader::new(stdout.take(8192)).lines() {
                        status(&line?);
                    }
                }
                if !child.wait()?.success() {
                    return Err(std::io::Error::other("Updater failed"));
                }
                Ok(())
            })();
            if result.is_err() {
                status("error");
            }
            BUSY.store(false, Ordering::Relaxed);
        })
        .is_err()
    {
        BUSY.store(false, Ordering::Relaxed);
        status("error");
    }
}

wrap_task! {
    struct UpdateStatus { code: String }
    impl Task {
        fn execute(&self) {
            super::smoke_event(&format!("core_update_status={}", self.code));
            let (label, tooltip, busy) = match self.code.as_str() {
                "checking" => ("Проверка ядра…", "Проверяем подписанные сведения об обновлении", true),
                "downloading" => ("Загрузка ядра…", "Браузером можно продолжать пользоваться", true),
                "verifying" => ("Проверка подписи…", "Проверяем и устанавливаем отдельную копию ядра", true),
                "ready" => ("Ядро готово ↻", "Обновление готово. Закройте все окна ChroMinimum и запустите его снова", false),
                "current" => ("Ядро актуально", "Совместимых обновлений в канале ChroMinimum нет. Нажмите для повторной проверки", false),
                "error" => ("Проверить ещё раз", "Не удалось проверить обновления. Возможно, нет сети, канал недоступен или проверка подписи не пройдена. Текущее ядро не заменено", false),
                _ => return,
            };
            let _ = tooltip;
            set_menu_label(label, !busy);
        }
    }
}
wrap_task! {
    struct AutomaticCheck {}
    impl Task {
        fn execute(&self) {
            let Some((_, root)) = CONTEXT.get() else { return; };
            let due = std::fs::metadata(root.join("core-last-check")).and_then(|m| m.modified())
                .ok().and_then(|last| SystemTime::now().duration_since(last).ok())
                .is_none_or(|age| age >= Duration::from_secs(86400));
            if due && HEALTHY.load(Ordering::Relaxed) { check(); }
            let mut next = AutomaticCheck::new();
            post_delayed_task(ThreadId::UI, Some(&mut next), 86_400_000);
        }
    }
}
