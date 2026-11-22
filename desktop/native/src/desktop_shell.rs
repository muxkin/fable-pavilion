use crate::{ADAPTER_ICON, management::TrayEvent};
use anyhow::{Context, Result};
#[cfg(target_os = "macos")]
use auto_launch::{AutoLaunch, AutoLaunchBuilder};
use tray_icon::{
    Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent,
    menu::{Menu, MenuEvent, MenuItem},
};

pub const APP_ID: &str = "org.agent-space.adapter";
const APP_NAME_EN: &str = "Fable Pavilion Adapter";
const APP_NAME_ZH: &str = "子虚亭适配器";
#[cfg(target_os = "linux")]
mod linux_startup;
#[cfg(target_os = "linux")]
pub use linux_startup::startup;
#[cfg(target_os = "macos")]
mod macos_language;

#[cfg(target_os = "linux")]
fn write_if_changed(path: &std::path::Path, bytes: &[u8]) -> Result<bool> {
    use std::{fs, io::Write, os::unix::fs::PermissionsExt};

    if fs::read(path).is_ok_and(|old| old == bytes) {
        return Ok(false);
    }
    let parent = path.parent().context("桌面入口目录无效")?;
    fs::create_dir_all(parent)?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(bytes)?;
    file.as_file()
        .set_permissions(fs::Permissions::from_mode(0o644))?;
    file.persist(path)?;
    Ok(true)
}

#[cfg(target_os = "linux")]
pub fn register_launcher() -> Result<()> {
    use std::{fs, path::Path};

    let data = dirs::data_dir().context("无法定位桌面应用目录")?;
    let path = std::env::current_exe()?;
    if path == Path::new("/usr/bin/agent-space-native") {
        // The system package provides its own launcher and icon.
        return Ok(());
    }
    let path = path.to_str().context("无法表示适配器路径")?;
    let exec = desktop_exec(path)?;
    use image::ImageEncoder;
    let icon = image::load_from_memory(ADAPTER_ICON)?.into_rgba8();
    let theme = data.join("icons/hicolor");
    let mut icons_changed = write_if_changed(
        &theme.join(format!("192x192/apps/{APP_ID}.png")),
        ADAPTER_ICON,
    )?;
    for size in [32, 48] {
        let resized =
            image::imageops::resize(&icon, size, size, image::imageops::FilterType::Lanczos3);
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png).write_image(
            resized.as_raw(),
            size,
            size,
            image::ExtendedColorType::Rgba8,
        )?;
        icons_changed |= write_if_changed(
            &theme.join(format!("{size}x{size}/apps/{APP_ID}.png")),
            &png,
        )?;
    }
    if icons_changed {
        fs::File::open(&theme)?.set_modified(std::time::SystemTime::now())?;
    }
    let entry = format!(
        "[Desktop Entry]\nType=Application\nName={APP_NAME_EN}\nName[zh]={APP_NAME_ZH}\nExec={exec}\nIcon={APP_ID}\nTerminal=false\nStartupWMClass={APP_ID}\nCategories=Utility;\n"
    );
    let entry_changed = write_if_changed(
        &data.join(format!("applications/{APP_ID}.desktop")),
        entry.as_bytes(),
    )?;
    if (icons_changed || entry_changed)
        && std::env::var("XDG_CURRENT_DESKTOP")
            .is_ok_and(|desktop| desktop.split(':').any(|name| name == "KDE"))
    {
        // Refresh both Plasma's named-icon and desktop-entry caches on installation.
        if let Ok(bus) = zbus::blocking::Connection::session() {
            let _ = bus.emit_signal(
                None::<&str>,
                "/KIconLoader",
                "org.kde.KIconLoader",
                "iconChanged",
                &(0_i32,), // KIconLoader::Desktop
            );
        }
        let _ = std::process::Command::new("kbuildsycoca6")
            .arg("--noincremental")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn desktop_exec(path: &str) -> Result<String> {
    anyhow::ensure!(
        !path.contains('=') && !path.chars().any(char::is_control),
        "桌面入口路径无效"
    );
    let mut exec = String::from("\"");
    for ch in path.chars() {
        match ch {
            '\\' => exec.push_str(r"\\\\"),
            '"' | '$' | '`' => {
                exec.push_str(r"\\");
                exec.push(ch);
            }
            '%' => exec.push_str("%%"),
            _ => exec.push(ch),
        }
    }
    exec.push('"');
    Ok(exec)
}

#[cfg(windows)]
#[path = "startup_windows.rs"]
mod startup_windows;
#[cfg(windows)]
pub use startup_windows::{repair_startup, startup};

#[cfg(target_os = "macos")]
pub fn startup() -> Result<AutoLaunch> {
    let path = std::env::current_exe()?;
    let path = path.to_str().context("无法表示适配器路径")?;
    let mut setup = AutoLaunchBuilder::new();
    setup
        .set_app_name("agent-space-native")
        .set_app_path(path)
        .set_args(&["--background"]);
    Ok(setup.build()?)
}

const STARTUP_PREFERENCE_FILE: &str = "native-startup-settings.json";
const MAX_STARTUP_PREFERENCE: u64 = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
struct StartupPreference {
    enabled: bool,
}

trait StartupControl {
    fn is_enabled(&self) -> Result<bool>;
    fn is_explicitly_disabled(&self) -> Result<bool> {
        Ok(false)
    }
    fn enable(&self) -> Result<()>;
}

#[cfg(target_os = "linux")]
impl StartupControl for linux_startup::Startup {
    fn is_enabled(&self) -> Result<bool> {
        Self::is_enabled(self)
    }

    fn is_explicitly_disabled(&self) -> Result<bool> {
        Self::is_explicitly_disabled(self)
    }

    fn enable(&self) -> Result<()> {
        Self::enable(self)
    }
}

#[cfg(windows)]
impl StartupControl for startup_windows::Startup {
    fn is_enabled(&self) -> Result<bool> {
        Self::is_enabled(self)
    }

    fn enable(&self) -> Result<()> {
        Self::enable(self)
    }
}

#[cfg(target_os = "macos")]
impl StartupControl for AutoLaunch {
    fn is_enabled(&self) -> Result<bool> {
        Ok(Self::is_enabled(self)?)
    }

    fn enable(&self) -> Result<()> {
        Ok(Self::enable(self)?)
    }
}

fn read_startup_preference(directory: &std::path::Path) -> Result<Option<bool>> {
    use std::io::{self, Read};

    let path = directory.join(STARTUP_PREFERENCE_FILE);
    match crate::state::private_file(&path, false) {
        Ok(file) => {
            let preference: StartupPreference =
                serde_json::from_reader(file.take(MAX_STARTUP_PREFERENCE))
                    .context("无法解析登录自启动配置")?;
            Ok(Some(preference.enabled))
        }
        Err(error)
            if error
                .downcast_ref::<io::Error>()
                .is_some_and(|error| error.kind() == io::ErrorKind::NotFound) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

pub fn save_startup_preference(directory: &std::path::Path, enabled: bool) -> Result<()> {
    crate::state::private_directory(directory)?;
    let path = directory.join(STARTUP_PREFERENCE_FILE);
    let temporary = directory.join(format!(
        "{STARTUP_PREFERENCE_FILE}.{}.tmp",
        uuid::Uuid::new_v4()
    ));
    let write = (|| -> Result<()> {
        let file = crate::state::private_file(&temporary, true)?;
        serde_json::to_writer(&file, &StartupPreference { enabled })?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, &path)?;
        Ok(())
    })();
    if write.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    write
}

pub fn initialize_default_startup(directory: &std::path::Path) -> Result<()> {
    if read_startup_preference(directory)?.is_some() {
        return Ok(());
    }
    let entry = startup()?;
    initialize_default_startup_with(directory, &entry)
}

fn initialize_default_startup_with(
    directory: &std::path::Path,
    control: &impl StartupControl,
) -> Result<()> {
    if read_startup_preference(directory)?.is_some() {
        return Ok(());
    }
    if control.is_explicitly_disabled()? {
        save_startup_preference(directory, false)?;
        return Ok(());
    }
    if !control.is_enabled()? {
        control.enable()?;
    }
    save_startup_preference(directory, true)?;
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn localized_display_name(locale: &str) -> &'static str {
    let language = locale
        .trim()
        .split(['_', '-', '.', '@'])
        .next()
        .unwrap_or("");
    if language.eq_ignore_ascii_case("zh") {
        APP_NAME_ZH
    } else {
        APP_NAME_EN
    }
}

#[cfg(windows)]
fn windows_display_name(language: u16) -> &'static str {
    // The low ten bits are the primary language for all Chinese regional variants.
    const LANG_CHINESE: u16 = 0x04;
    if language & 0x03ff == LANG_CHINESE {
        APP_NAME_ZH
    } else {
        APP_NAME_EN
    }
}

pub fn install(events: tokio::sync::mpsc::UnboundedSender<TrayEvent>) -> Result<TrayIcon> {
    let image = image::load_from_memory(ADAPTER_ICON)?.into_rgba8();
    let tray = image::imageops::resize(&image, 32, 32, image::imageops::FilterType::Lanczos3);
    let icon = Icon::from_rgba(tray.into_raw(), 32, 32)?;
    let menu = Menu::new();
    let open = MenuItem::new("打开设置", true, None);
    let check = MenuItem::new("检查更新", true, None);
    let quit = MenuItem::new("退出适配器", true, None);
    menu.append(&open)?;
    menu.append(&check)?;
    menu.append(&quit)?;
    #[cfg(target_os = "linux")]
    let name = localized_display_name(
        &["LC_ALL", "LC_MESSAGES", "LANG"]
            .into_iter()
            .filter_map(|key| std::env::var(key).ok())
            .find(|locale| !locale.trim().is_empty())
            .unwrap_or_default(),
    );
    #[cfg(target_os = "macos")]
    let name = localized_display_name(
        macos_language::preferred_language()
            .as_deref()
            .unwrap_or_default(),
    );
    #[cfg(windows)]
    let name = windows_display_name(unsafe {
        windows_sys::Win32::Globalization::GetUserDefaultUILanguage()
    });
    let tray = TrayIconBuilder::new()
        .with_id(APP_ID)
        .with_title(name)
        .with_tooltip(name)
        .with_menu(Box::new(menu))
        .with_icon(icon)
        .with_menu_on_left_click(false)
        .build()?;
    let click = events.clone();
    TrayIconEvent::set_event_handler(Some(move |event| {
        if matches!(
            event,
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
        ) {
            let _ = click.send(TrayEvent::Open);
        }
    }));
    let (open, check, quit) = (open.id().clone(), check.id().clone(), quit.id().clone());
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let action = if event.id == open {
            TrayEvent::Open
        } else if event.id == check {
            TrayEvent::CheckUpdate
        } else if event.id == quit {
            TrayEvent::Quit
        } else {
            return;
        };
        let _ = events.send(action);
    }));
    Ok(tray)
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
#[test]
fn localizes_tray_display_name() {
    for locale in ["zh", "zh_CN.UTF-8", "zh-TW", "zh_HK.UTF-8", "zh_Hant"] {
        assert_eq!(localized_display_name(locale), "子虚亭适配器");
    }
    for locale in ["", "C.UTF-8", "en_US.UTF-8", "en-GB", "de_DE"] {
        assert_eq!(localized_display_name(locale), "Fable Pavilion Adapter");
    }
}

#[cfg(all(test, windows))]
#[test]
fn localizes_tray_display_name() {
    for language in [0x0404, 0x0804, 0x0c04, 0x1004, 0x1404] {
        assert_eq!(windows_display_name(language), "子虚亭适配器");
    }
    for language in [0x0409, 0x0809, 0x0407] {
        assert_eq!(windows_display_name(language), "Fable Pavilion Adapter");
    }
}

#[cfg(test)]
mod startup_default_tests {
    use super::*;
    use std::cell::Cell;

    struct FakeStartup {
        enabled: Cell<bool>,
        explicitly_disabled: bool,
        enable_calls: Cell<usize>,
    }

    impl FakeStartup {
        fn new(enabled: bool, explicitly_disabled: bool) -> Self {
            Self {
                enabled: Cell::new(enabled),
                explicitly_disabled,
                enable_calls: Cell::new(0),
            }
        }
    }

    impl StartupControl for FakeStartup {
        fn is_enabled(&self) -> Result<bool> {
            Ok(self.enabled.get())
        }

        fn is_explicitly_disabled(&self) -> Result<bool> {
            Ok(self.explicitly_disabled)
        }

        fn enable(&self) -> Result<()> {
            self.enable_calls.set(self.enable_calls.get() + 1);
            self.enabled.set(true);
            Ok(())
        }
    }

    #[test]
    fn enables_startup_once_by_default_and_respects_later_opt_out() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let state = temp.path().join("state");
        let fake = FakeStartup::new(false, false);

        initialize_default_startup_with(&state, &fake)?;
        assert!(fake.enabled.get());
        assert_eq!(fake.enable_calls.get(), 1);
        assert_eq!(read_startup_preference(&state)?, Some(true));

        // Removing the OS entry after initial setup must not forcibly re-enable it.
        fake.enabled.set(false);
        initialize_default_startup_with(&state, &fake)?;
        assert!(!fake.enabled.get());
        assert_eq!(fake.enable_calls.get(), 1);

        // Explicit UI opt-out persists and keeps autostart off.
        save_startup_preference(&state, false)?;
        assert_eq!(read_startup_preference(&state)?, Some(false));
        initialize_default_startup_with(&state, &fake)?;
        assert!(!fake.enabled.get());
        assert_eq!(fake.enable_calls.get(), 1);
        Ok(())
    }

    #[test]
    fn respects_existing_explicit_os_disable_entry() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let state = temp.path().join("state");
        let fake = FakeStartup::new(false, true);

        initialize_default_startup_with(&state, &fake)?;
        assert!(!fake.enabled.get());
        assert_eq!(fake.enable_calls.get(), 0);
        assert_eq!(read_startup_preference(&state)?, Some(false));
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod app_delegate {
    use super::TrayEvent;
    use objc2::{
        DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained,
        runtime::ProtocolObject,
    };
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy, NSApplicationDelegate};
    use objc2_foundation::{NSObject, NSObjectProtocol};
    use tokio::sync::mpsc::UnboundedSender;

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = UnboundedSender<TrayEvent>]
        pub(super) struct AgentSpaceTrayDelegate;

        unsafe impl NSObjectProtocol for AgentSpaceTrayDelegate {}
        unsafe impl NSApplicationDelegate for AgentSpaceTrayDelegate {
            #[unsafe(method(applicationShouldHandleReopen:hasVisibleWindows:))]
            fn reopen(&self, _: &NSApplication, _: bool) -> bool {
                let _ = self.ivars().send(TrayEvent::Open);
                false
            }
        }
    );

    pub(super) fn register(events: UnboundedSender<TrayEvent>) -> Retained<AgentSpaceTrayDelegate> {
        let marker = MainThreadMarker::new().expect("AppKit runs on the main thread");
        let app = NSApplication::sharedApplication(marker);
        app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
        let delegate = AgentSpaceTrayDelegate::alloc(marker).set_ivars(events);
        let delegate: Retained<AgentSpaceTrayDelegate> =
            unsafe { msg_send![super(delegate), init] };
        app.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        delegate
    }
}

#[cfg(target_os = "macos")]
pub fn prepare(events: tokio::sync::mpsc::UnboundedSender<TrayEvent>) -> impl Sized {
    app_delegate::register(events)
}

#[cfg(not(target_os = "macos"))]
pub fn prepare(_events: tokio::sync::mpsc::UnboundedSender<TrayEvent>) {}

#[cfg(windows)]
pub fn drive<T: Send + 'static>(
    runtime: &tokio::runtime::Runtime,
    future: impl Future<Output = T> + Send + 'static,
) -> Result<T> {
    use windows_sys::Win32::{
        System::Threading::GetCurrentThreadId,
        UI::WindowsAndMessaging::{
            DispatchMessageW, GetMessageW, MSG, PM_NOREMOVE, PeekMessageW, PostThreadMessageW,
            TranslateMessage, WM_QUIT,
        },
    };
    let mut message = MSG::default();
    let thread = unsafe {
        // PeekMessage creates the thread's queue before the worker can post to it.
        PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
        GetCurrentThreadId()
    };
    let task = runtime.spawn(async move {
        let result = future.await;
        unsafe { PostThreadMessageW(thread, WM_QUIT, 0, 0) };
        result
    });
    loop {
        let status = unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) };
        anyhow::ensure!(status >= 0, "无法读取托盘消息");
        if status == 0 {
            break;
        }
        unsafe {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    Ok(runtime.block_on(task)?)
}

#[cfg(target_os = "macos")]
pub fn drive<T: Send + 'static>(
    runtime: &tokio::runtime::Runtime,
    future: impl Future<Output = T> + Send + 'static,
) -> Result<T> {
    use dispatch2::DispatchQueue;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType};

    let marker = MainThreadMarker::new().expect("AppKit runs on the main thread");
    let app = NSApplication::sharedApplication(marker);
    let task = runtime.spawn(async move {
        let result = future.await;
        DispatchQueue::main().exec_async(|| {
            let marker = MainThreadMarker::new().expect("main queue runs on the main thread");
            let app = NSApplication::sharedApplication(marker);
            app.stop(None);
            // AppKit finishes stopping after its event loop handles the next event.
            if let Some(event) = NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
                NSEventType::ApplicationDefined,
                Default::default(),
                NSEventModifierFlags::empty(),
                0.0,
                0,
                None,
                0,
                0,
                0,
            ) {
                app.postEvent_atStart(&event, false);
            }
        });
        result
    });
    app.run();
    Ok(runtime.block_on(task)?)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn drive<T>(runtime: &tokio::runtime::Runtime, future: impl Future<Output = T>) -> Result<T> {
    Ok(runtime.block_on(future))
}
