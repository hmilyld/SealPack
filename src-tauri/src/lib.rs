mod commands;
mod defaults;
mod download;
mod hash;
mod model;
mod pipeline;
mod runtime;
mod settings;
mod store;
mod template;
mod tools;

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::Manager;

pub use store::AppState;

/// 窗口材质（Windows Mica Alt）是否已启用。
/// 启用后前端才把标题栏切成半透明材质，未启用（旧系统 / 设置失败）时保持实色。
static MATERIAL_ACTIVE: AtomicBool = AtomicBool::new(false);

/// 应用窗口材质：Windows 用 `tabbed`（Mica Alt，微软推荐给「含导航与命令区的应用」）。
/// 失败不报错——前端按 `window_material()` 的返回值决定用材质还是实色，两种形态都可读。
fn apply_window_effects(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "windows")]
    {
        use tauri::window::{Effect, EffectsBuilder};
        let effects = EffectsBuilder::new().effect(Effect::Tabbed).build();
        match window.set_effects(effects) {
            Ok(()) => MATERIAL_ACTIVE.store(true, Ordering::Relaxed),
            Err(_) => MATERIAL_ACTIVE.store(false, Ordering::Relaxed),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
    }
}

/// 窗口材质是否启用（供前端决定标题栏用半透明还是实色）。
#[tauri::command]
fn window_material() -> bool {
    MATERIAL_ACTIVE.load(Ordering::Relaxed)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // 只记忆窗口尺寸与最大化状态；位置每次启动都居中，不记忆——
        // 免得用户上次把窗口拖到已拔掉的显示器上，下次启动找不着。
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::POSITION,
                )
                .build(),
        )
        .setup(|app| {
            let state = AppState::resolve(app.handle())?;
            app.manage(state);

            if let Some(window) = app.get_webview_window("main") {
                // 窗口以 visible: false 创建，等前端把皮肤写进根元素、首帧绘制完成后
                // 再由 JS 调用 show()。这样启动过程不会闪一下原生白底。
                apply_window_effects(&window);

                // 窗口居中：配置里的 `center: true` 只在创建瞬间生效，
                // 无边框窗口（decorations: false）下偶发因尺寸未定而偏移，这里再兜底居中一次。
                let _ = window.center();

                // 兜底：万一前端脚本出错没能调用 show()，1.5s 后强制显示，避免窗口永不出现。
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(1500));
                    if let Some(win) = handle.get_webview_window("main") {
                        if !win.is_visible().unwrap_or(true) {
                            let _ = win.show();
                        }
                    }
                });
            }

            Ok(())
        })
        // 最大化状态变化时前端通过 `onResized` 事件自行同步，无需 Rust 侧再转发
        .invoke_handler(tauri::generate_handler![
            commands::list_projects,
            commands::load_project,
            commands::create_project,
            commands::save_project,
            commands::delete_project,
            commands::run_stage,
            commands::scan_tree,
            commands::exe_version,
            commands::exe_app_id,
            commands::tool_status,
            commands::download_tool,
            commands::get_settings,
            commands::save_settings,
            commands::environment_status,
            commands::render_encrypt_config,
            commands::render_package_script,
            commands::project_ignores,
            commands::placeholders,
            window_material,
        ])
        .run(tauri::generate_context!())
        .expect("SealPack 启动失败");
}
