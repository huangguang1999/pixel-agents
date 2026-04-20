// Pixel Agents is Unix-only today: ipc.rs uses `std::os::unix::net` (Unix
// Domain Sockets) and reaper.rs shells out to `kill -0` for PID liveness.
// Fail the build up-front on Windows instead of surfacing obscure errors
// deep in those modules — porting requires named pipes + OpenProcess.
#[cfg(not(unix))]
compile_error!(
    "pixel-agents currently targets macOS/Linux only. Windows requires \
     porting ipc.rs to named pipes and reaper.rs to OpenProcess liveness checks."
);

mod adapter;
mod events;
mod installer;
mod ipc;
mod reaper;

use tauri::{
    menu::{CheckMenuItem, Menu, MenuBuilder, SubmenuBuilder},
    AppHandle, Emitter, Manager, Wry,
};

/// All user-visible menu + window strings for one language.
/// Items are the rendered labels (not ids), so they can be swapped at runtime
/// by rebuilding the menu.
struct MenuStrings {
    app_name: &'static str,
    window_title: &'static str,
    edit: &'static str,
    language: &'static str,
    about: &'static str,
    hide: &'static str,
    hide_others: &'static str,
    show_all: &'static str,
    services: &'static str,
    quit: &'static str,
    undo: &'static str,
    redo: &'static str,
    cut: &'static str,
    copy: &'static str,
    paste: &'static str,
    select_all: &'static str,
}

fn strings_for(lang: &str) -> MenuStrings {
    match lang {
        "zh" => MenuStrings {
            app_name: "像素模型",
            window_title: "像素模型 · 办公室",
            edit: "编辑",
            language: "语言",
            about: "关于像素模型",
            hide: "隐藏像素模型",
            hide_others: "隐藏其他",
            show_all: "全部显示",
            services: "服务",
            quit: "退出像素模型",
            undo: "撤销",
            redo: "重做",
            cut: "剪切",
            copy: "拷贝",
            paste: "粘贴",
            select_all: "全选",
        },
        _ => MenuStrings {
            app_name: "Pixel Agents",
            window_title: "Pixel Agents Office",
            edit: "Edit",
            language: "Language",
            about: "About Pixel Agents",
            hide: "Hide Pixel Agents",
            hide_others: "Hide Others",
            show_all: "Show All",
            services: "Services",
            quit: "Quit Pixel Agents",
            undo: "Undo",
            redo: "Redo",
            cut: "Cut",
            copy: "Copy",
            paste: "Paste",
            select_all: "Select All",
        },
    }
}

fn build_menu(app: &AppHandle, lang: &str) -> tauri::Result<Menu<Wry>> {
    let s = strings_for(lang);

    let zh = CheckMenuItem::with_id(app, "lang_zh", "中文", true, lang == "zh", None::<&str>)?;
    let en = CheckMenuItem::with_id(app, "lang_en", "English", true, lang == "en", None::<&str>)?;
    let lang_submenu = SubmenuBuilder::new(app, s.language)
        .item(&zh)
        .item(&en)
        .build()?;

    #[cfg(target_os = "macos")]
    {
        // Replacing the default macOS menu drops the standard App + Edit menus;
        // we re-add them so Cmd+Q / Cmd+C keep working and labels can follow
        // the app's language (not the system locale).
        let app_submenu = SubmenuBuilder::new(app, s.app_name)
            .about_with_text(s.about, None)
            .separator()
            .services_with_text(s.services)
            .separator()
            .hide_with_text(s.hide)
            .hide_others_with_text(s.hide_others)
            .show_all_with_text(s.show_all)
            .separator()
            .quit_with_text(s.quit)
            .build()?;
        let edit_submenu = SubmenuBuilder::new(app, s.edit)
            .undo_with_text(s.undo)
            .redo_with_text(s.redo)
            .separator()
            .cut_with_text(s.cut)
            .copy_with_text(s.copy)
            .paste_with_text(s.paste)
            .select_all_with_text(s.select_all)
            .build()?;
        MenuBuilder::new(app)
            .items(&[&app_submenu, &edit_submenu, &lang_submenu])
            .build()
    }
    #[cfg(not(target_os = "macos"))]
    {
        MenuBuilder::new(app).items(&[&lang_submenu]).build()
    }
}

fn apply_lang(app: &AppHandle, lang: &str) {
    let s = strings_for(lang);
    if let Ok(menu) = build_menu(app, lang) {
        let _ = app.set_menu(menu);
    }
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_title(s.window_title);
    }
}

#[tauri::command]
fn sync_menu_lang(app: AppHandle, lang: String) {
    apply_lang(&app, &lang);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![sync_menu_lang])
        .setup(|app| {
            let handle = app.handle().clone();

            // Build an initial English menu; webview will call `sync_menu_lang`
            // right after mount to correct it if the stored preference is 'zh'.
            apply_lang(&handle, "en");

            handle.on_menu_event(move |app_handle, event| match event.id().0.as_str() {
                "lang_zh" => {
                    let _ = app_handle.emit("lang-change", "zh");
                }
                "lang_en" => {
                    let _ = app_handle.emit("lang-change", "en");
                }
                _ => {}
            });

            installer::ensure_hooks_installed(&handle);
            let tracker = reaper::new_tracker();
            ipc::spawn_listener(handle.clone(), tracker.clone());
            reaper::spawn(handle, tracker);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
