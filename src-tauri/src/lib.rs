use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder,
};

mod platform;
mod renderer;

#[derive(Clone, Serialize)]
struct CursorPosition {
    x: i32,
    y: i32,
}

struct AppState {
    overlay_excluded_from_capture: AtomicBool,
    d3d11_device_available: AtomicBool,
    d3d11_feature_level: Mutex<Option<String>>,
    windows_graphics_capture_supported: AtomicBool,
    capture_item_created: AtomicBool,
    frame_pool_created: AtomicBool,
    first_frame_received: AtomicBool,
    frame_surface_available: AtomicBool,
    captured_frame_size: Mutex<Option<String>>,
    composition_swapchain_created: AtomicBool,
    direct_composition_target_created: AtomicBool,
    swapchain_backbuffer_presented: AtomicBool,
    direct_composition_committed: AtomicBool,
    capture_texture_available: AtomicBool,
    capture_texture_size: Mutex<Option<String>>,
    captured_frame_copied_to_swapchain: AtomicBool,
    gpu_renderer_params: Arc<Mutex<renderer::GpuRendererParams>>,
    #[cfg(target_os = "windows")]
    gpu_renderer: Mutex<Option<platform::windows::GpuRenderer>>,
    /// 关闭主窗口时：true = 隐藏到托盘，false = 直接退出进程。
    close_to_tray: AtomicBool,
    /// 托盘「开关效果」菜单项，文案随当前 enabled 状态刷新。
    tray_toggle_item: Mutex<Option<MenuItem<tauri::Wry>>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GpuPrototypeStatus {
    platform: &'static str,
    overlay_excluded_from_capture: bool,
    d3d11_device_available: bool,
    d3d11_feature_level: Option<String>,
    windows_graphics_capture_supported: bool,
    capture_item_created: bool,
    frame_pool_created: bool,
    first_frame_received: bool,
    frame_surface_available: bool,
    captured_frame_size: Option<String>,
    composition_swapchain_created: bool,
    direct_composition_target_created: bool,
    swapchain_backbuffer_presented: bool,
    direct_composition_committed: bool,
    capture_texture_available: bool,
    capture_texture_size: Option<String>,
    captured_frame_copied_to_swapchain: bool,
    gpu_renderer_initialized: bool,
    gpu_renderer_running: bool,
    gpu_renderer_frames_presented: u64,
    gpu_renderer_fps: u64,
    gpu_renderer_capture_size: Option<String>,
    gpu_renderer_last_error: Option<String>,
    gpu_renderer_params: Option<String>,
    /// 效果总开关当前值（来自共享参数，直通/原生模糊运行时若为 false
    /// 前端显示"遮罩未生效"警告）。
    effects_enabled: bool,
    native_blur_running: bool,
    gpu_capture_pipeline: &'static str,
    renderer_backend: &'static str,
}

#[tauri::command]
fn gpu_prototype_status(state: State<'_, AppState>) -> GpuPrototypeStatus {
    let overlay_excluded_from_capture = state.overlay_excluded_from_capture.load(Ordering::Relaxed);
    let d3d11_device_available = state.d3d11_device_available.load(Ordering::Relaxed);
    let d3d11_feature_level = state
        .d3d11_feature_level
        .lock()
        .ok()
        .and_then(|feature_level| feature_level.clone());
    let windows_graphics_capture_supported = state
        .windows_graphics_capture_supported
        .load(Ordering::Relaxed);
    let capture_item_created = state.capture_item_created.load(Ordering::Relaxed);
    let frame_pool_created = state.frame_pool_created.load(Ordering::Relaxed);
    let first_frame_received = state.first_frame_received.load(Ordering::Relaxed);
    let frame_surface_available = state.frame_surface_available.load(Ordering::Relaxed);
    let captured_frame_size = state
        .captured_frame_size
        .lock()
        .ok()
        .and_then(|captured_frame_size| captured_frame_size.clone());
    let composition_swapchain_created = state.composition_swapchain_created.load(Ordering::Relaxed);
    let direct_composition_target_created = state
        .direct_composition_target_created
        .load(Ordering::Relaxed);
    let swapchain_backbuffer_presented =
        state.swapchain_backbuffer_presented.load(Ordering::Relaxed);
    let direct_composition_committed = state.direct_composition_committed.load(Ordering::Relaxed);
    let capture_texture_available = state.capture_texture_available.load(Ordering::Relaxed);
    let capture_texture_size = state
        .capture_texture_size
        .lock()
        .ok()
        .and_then(|capture_texture_size| capture_texture_size.clone());
    let captured_frame_copied_to_swapchain = state
        .captured_frame_copied_to_swapchain
        .load(Ordering::Relaxed);
    let effects_enabled = state
        .gpu_renderer_params
        .lock()
        .map(|params| params.enabled)
        .unwrap_or(false);

    #[cfg(target_os = "windows")]
    let renderer_snapshot = state
        .gpu_renderer
        .lock()
        .ok()
        .and_then(|gpu_renderer| gpu_renderer.as_ref().map(|r| r.snapshot()));
    #[cfg(target_os = "windows")]
    let renderer_snapshot =
        renderer_snapshot.unwrap_or_else(platform::windows::GpuRendererSnapshot::default);

    #[cfg(target_os = "windows")]
    {
        let status = platform::windows::gpu_prototype_status(
            overlay_excluded_from_capture,
            d3d11_device_available,
            d3d11_feature_level,
            windows_graphics_capture_supported,
            capture_item_created,
            frame_pool_created,
            first_frame_received,
            frame_surface_available,
            captured_frame_size,
            composition_swapchain_created,
            direct_composition_target_created,
            swapchain_backbuffer_presented,
            direct_composition_committed,
            capture_texture_available,
            capture_texture_size,
            captured_frame_copied_to_swapchain,
            renderer_snapshot,
        );
        GpuPrototypeStatus {
            platform: status.platform,
            overlay_excluded_from_capture: status.overlay_excluded_from_capture,
            d3d11_device_available: status.d3d11_device_available,
            d3d11_feature_level: status.d3d11_feature_level,
            windows_graphics_capture_supported: status.windows_graphics_capture_supported,
            capture_item_created: status.capture_item_created,
            frame_pool_created: status.frame_pool_created,
            first_frame_received: status.first_frame_received,
            frame_surface_available: status.frame_surface_available,
            captured_frame_size: status.captured_frame_size,
            composition_swapchain_created: status.composition_swapchain_created,
            direct_composition_target_created: status.direct_composition_target_created,
            swapchain_backbuffer_presented: status.swapchain_backbuffer_presented,
            direct_composition_committed: status.direct_composition_committed,
            capture_texture_available: status.capture_texture_available,
            capture_texture_size: status.capture_texture_size,
            captured_frame_copied_to_swapchain: status.captured_frame_copied_to_swapchain,
            gpu_renderer_initialized: status.gpu_renderer_initialized,
            gpu_renderer_running: status.gpu_renderer_running,
            gpu_renderer_frames_presented: status.gpu_renderer_frames_presented,
            gpu_renderer_fps: status.gpu_renderer_fps,
            gpu_renderer_capture_size: status.gpu_renderer_capture_size,
            gpu_renderer_last_error: status.gpu_renderer_last_error,
            gpu_renderer_params: status.gpu_renderer_params,
            effects_enabled,
            native_blur_running: false,
            gpu_capture_pipeline: status.gpu_capture_pipeline,
            renderer_backend: status.renderer_backend,
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let native_blur_running = {
            #[cfg(target_os = "macos")]
            {
                platform::macos::mac_blur_running()
            }
            #[cfg(not(target_os = "macos"))]
            {
                false
            }
        };

        let backend = if native_blur_running {
            "macOS native blur (NSVisualEffectView mask) + Canvas dim"
        } else {
            "Canvas fallback"
        };

        GpuPrototypeStatus {
            platform: std::env::consts::OS,
            overlay_excluded_from_capture,
            d3d11_device_available,
            d3d11_feature_level,
            windows_graphics_capture_supported,
            capture_item_created,
            frame_pool_created,
            first_frame_received,
            frame_surface_available,
            captured_frame_size,
            composition_swapchain_created,
            direct_composition_target_created,
            swapchain_backbuffer_presented,
            direct_composition_committed,
            capture_texture_available,
            capture_texture_size,
            captured_frame_copied_to_swapchain,
            gpu_renderer_initialized: false,
            gpu_renderer_running: false,
            gpu_renderer_frames_presented: 0,
            gpu_renderer_fps: 0,
            gpu_renderer_capture_size: None,
            gpu_renderer_last_error: None,
            gpu_renderer_params: None,
            effects_enabled,
            native_blur_running,
            gpu_capture_pipeline: "native per-platform renderer",
            renderer_backend: backend,
        }
    }
}

#[tauri::command]
fn gpu_renderer_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let overlay = app
            .get_webview_window("overlay")
            .ok_or_else(|| "overlay window not found".to_string())?;

        let mut gpu_renderer = state
            .gpu_renderer
            .lock()
            .map_err(|_| "GPU renderer state lock poisoned".to_string())?;

        if gpu_renderer
            .as_ref()
            .map(|renderer| renderer.is_alive())
            .unwrap_or(false)
        {
            return Ok(());
        }

        let renderer = platform::windows::GpuRenderer::start(
            &overlay,
            Arc::clone(&state.gpu_renderer_params),
        )?;
        *gpu_renderer = Some(renderer);
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, state);
        Err("GPU renderer is only available on Windows".to_string())
    }
}

#[tauri::command]
fn gpu_renderer_stop(state: State<'_, AppState>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut gpu_renderer = state
            .gpu_renderer
            .lock()
            .map_err(|_| "GPU renderer state lock poisoned".to_string())?;

        if let Some(mut renderer) = gpu_renderer.take() {
            renderer.stop();
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = state;
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GpuRendererParamsPayload {
    enabled: bool,
    mode: String,
    radius: f32,
    feather: f32,
    dim: f32,
    blur: f32,
    /// 横带全高（前端 CSS 像素）。
    band_height: f32,
    /// 横带全宽；CSS 像素。
    band_width: f32,
    /// 横带中心相对鼠标的偏移（CSS 像素，top-left 原点）。
    /// 字段名必须与前端 payload key（offsetX/offsetY）经 camelCase 对齐。
    offset_x: f32,
    offset_y: f32,
    spotlight_scale_x: f32,
    spotlight_scale_y: f32,
    smoothing: f32,
}

#[tauri::command]
fn gpu_renderer_set_params(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    params: GpuRendererParamsPayload,
) -> Result<(), String> {
    // 阅读/代码模式已合并为 band；旧值兼容映射。
    let mode = match params.mode.as_str() {
        "spotlight" => 0,
        "band" | "reading" | "code" => 1,
        other => {
            return Err(format!("unknown focus mode: {other}"));
        }
    };

    // 前端长度都是 CSS 像素；shader 需要显示器物理像素。
    let scale = app
        .get_webview_window("overlay")
        .and_then(|overlay| overlay.scale_factor().ok())
        .unwrap_or(1.0) as f32;

    let next = renderer::GpuRendererParams {
        enabled: params.enabled,
        mode,
        radius: params.radius * scale,
        feather: params.feather * scale,
        dim: params.dim,
        blur_px: params.blur * scale,
        band_half_h: params.band_height * 0.5 * scale,
        band_half_w: params.band_width * 0.5 * scale,
        band_offset_x: params.offset_x * scale,
        band_offset_y: params.offset_y * scale,
        spot_scale_x: params.spotlight_scale_x,
        spot_scale_y: params.spotlight_scale_y,
        tracking_alpha: params.smoothing.clamp(0.01, 1.0),
    };

    let mut stored = state
        .gpu_renderer_params
        .lock()
        .map_err(|_| "GPU renderer params lock poisoned".to_string())?;
    *stored = next;
    drop(stored);

    refresh_tray_toggle_label(&state);

    Ok(())
}

#[tauri::command]
fn set_close_behavior(state: State<'_, AppState>, to_tray: bool) -> Result<(), String> {
    state.close_to_tray.store(to_tray, Ordering::Relaxed);
    Ok(())
}

/// 手动调试通道：物理像素直接写入 shader 参数，绕过前端设置和 DPI 换算。
/// 只给 devtools console 用；面板里动任意滑块会恢复前端参数。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GpuRendererDebugParams {
    enabled: Option<bool>,
    mode: Option<i32>,
    radius: Option<f32>,
    feather: Option<f32>,
    dim: Option<f32>,
    blur: Option<f32>,
    band_half_h: Option<f32>,
    band_half_w: Option<f32>,
    band_offset_x: Option<f32>,
    band_offset_y: Option<f32>,
}

#[tauri::command]
fn gpu_renderer_debug_params(
    state: State<'_, AppState>,
    params: GpuRendererDebugParams,
) -> Result<(), String> {
    let mut stored = state
        .gpu_renderer_params
        .lock()
        .map_err(|_| "GPU renderer params lock poisoned".to_string())?;

    if let Some(enabled) = params.enabled {
        stored.enabled = enabled;
    }
    if let Some(mode) = params.mode {
        stored.mode = mode;
    }
    if let Some(radius) = params.radius {
        stored.radius = radius;
    }
    if let Some(feather) = params.feather {
        stored.feather = feather;
    }
    if let Some(dim) = params.dim {
        stored.dim = dim;
    }
    if let Some(blur) = params.blur {
        stored.blur_px = blur;
    }
    if let Some(band_half_h) = params.band_half_h {
        stored.band_half_h = band_half_h;
    }
    if let Some(band_half_w) = params.band_half_w {
        stored.band_half_w = band_half_w;
    }
    if let Some(band_offset_x) = params.band_offset_x {
        stored.band_offset_x = band_offset_x;
    }
    if let Some(band_offset_y) = params.band_offset_y {
        stored.band_offset_y = band_offset_y;
    }
    drop(stored);

    refresh_tray_toggle_label(&state);

    Ok(())
}

fn store_captured_frame_size(state: State<'_, AppState>, captured_frame_size: Option<String>) {
    if let Ok(mut stored_captured_frame_size) = state.captured_frame_size.lock() {
        *stored_captured_frame_size = captured_frame_size;
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

fn tray_toggle_label(enabled: bool) -> &'static str {
    if enabled {
        "关闭效果"
    } else {
        "开启效果"
    }
}

fn refresh_tray_toggle_label(state: &AppState) {
    if let Ok(tray_toggle_item) = state.tray_toggle_item.lock() {
        if let Some(item) = tray_toggle_item.as_ref() {
            let enabled = state
                .gpu_renderer_params
                .lock()
                .map(|params| params.enabled)
                .unwrap_or(false);
            let _ = item.set_text(tray_toggle_label(enabled));
        }
    }
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let open_item = MenuItem::with_id(app, "open-main", "打开主面板", true, None::<&str>)?;
    let toggle_item = MenuItem::with_id(
        app,
        "toggle-effect",
        tray_toggle_label(
            app.state::<AppState>()
                .gpu_renderer_params
                .lock()
                .map(|params| params.enabled)
                .unwrap_or(false),
        ),
        true,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_item, &toggle_item, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id("focus-bubble-tray")
        .tooltip("Focus Bubble")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open-main" => show_main_window(app),
            "toggle-effect" => {
                let state = app.state::<AppState>();
                let now_enabled = state
                    .gpu_renderer_params
                    .lock()
                    .map(|mut params| {
                        params.enabled = !params.enabled;
                        params.enabled
                    })
                    .unwrap_or(false);
                refresh_tray_toggle_label(&state);
                // 通知前端同步 settings（隐藏的主面板 webview 也会收到）。
                let _ = app.emit_to("main", "effect-toggled", now_enabled);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    match app.default_window_icon() {
        Some(icon) => {
            builder = builder.icon(icon.clone());
        }
        None => eprintln!("no default window icon available; tray icon may not display"),
    }

    builder.build(app)?;

    if let Ok(mut stored) = app.state::<AppState>().tray_toggle_item.lock() {
        *stored = Some(toggle_item);
    }

    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            overlay_excluded_from_capture: AtomicBool::new(false),
            d3d11_device_available: AtomicBool::new(false),
            d3d11_feature_level: Mutex::new(None),
            windows_graphics_capture_supported: AtomicBool::new(false),
            capture_item_created: AtomicBool::new(false),
            frame_pool_created: AtomicBool::new(false),
            first_frame_received: AtomicBool::new(false),
            frame_surface_available: AtomicBool::new(false),
            captured_frame_size: Mutex::new(None),
            composition_swapchain_created: AtomicBool::new(false),
            direct_composition_target_created: AtomicBool::new(false),
            swapchain_backbuffer_presented: AtomicBool::new(false),
            direct_composition_committed: AtomicBool::new(false),
            capture_texture_available: AtomicBool::new(false),
            capture_texture_size: Mutex::new(None),
            captured_frame_copied_to_swapchain: AtomicBool::new(false),
            gpu_renderer_params: Arc::new(Mutex::new(renderer::GpuRendererParams::default())),
            #[cfg(target_os = "windows")]
            gpu_renderer: Mutex::new(None),
            close_to_tray: AtomicBool::new(true),
            tray_toggle_item: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            gpu_prototype_status,
            gpu_renderer_start,
            gpu_renderer_stop,
            gpu_renderer_set_params,
            set_close_behavior,
            gpu_renderer_debug_params
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let app = window.app_handle();
                    let to_tray = app
                        .state::<AppState>()
                        .close_to_tray
                        .load(Ordering::Relaxed);

                    if to_tray {
                        // 隐藏到托盘；overlay 和效果继续运行，托盘菜单可退出。
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        app.exit(0);
                    }
                }
            }
        })
        .setup(|app| {
            let overlay = {
                let builder = WebviewWindowBuilder::new(
                    app,
                    "overlay",
                    WebviewUrl::App("index.html#overlay".into()),
                )
                // 标题置空：无边框全屏窗口在某些 Windows 组合下可能渲染出
                // 顶部标题条，空标题至少不显示文字。
                .title("")
                // 显式透明背景色：修复 Win10 上 WebView2 透明窗口在窗口
                // 移动/DWM 重合成后顶部出现渲染残留条的问题。
                .background_color(tauri::webview::Color(0, 0, 0, 0))
                .decorations(false)
                // 覆盖层不可调整大小：Win10 会给可调整的无边框窗口在顶部
                // 保留 DWM 调整框架带（视觉遮挡的嫌疑来源）。
                .resizable(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .shadow(false);

                // Windows：GPU 直通画面依赖原生全屏状态合成（改成普通
                // 无边框窗口会导致 DComp 画面不显示，已实测回退）。
                #[cfg(not(target_os = "macos"))]
                let builder = builder.fullscreen(true);

                builder.build()?
            };

            // macOS 不用全屏状态（会切 Space 接管屏幕），无边框窗口铺满显示器。
            #[cfg(target_os = "macos")]
            if let Ok(Some(monitor)) = overlay.current_monitor() {
                let _ = overlay.set_position(tauri::PhysicalPosition::new(
                    monitor.position().x,
                    monitor.position().y,
                ));
                let _ = overlay.set_size(tauri::PhysicalSize::new(
                    monitor.size().width,
                    monitor.size().height,
                ));
            }

            overlay.set_ignore_cursor_events(true)?;

            if let Err(error) = build_tray(app.handle()) {
                eprintln!("failed to build tray icon: {error}");
            }

            #[cfg(target_os = "macos")]
            platform::macos::start_mac_blur(
                app.handle(),
                Arc::clone(&app.state::<AppState>().gpu_renderer_params),
            );

            #[cfg(target_os = "windows")]
            {
                match platform::windows::probe_d3d11_device() {
                    Ok(feature_level) => {
                        app.state::<AppState>()
                            .d3d11_device_available
                            .store(true, Ordering::Relaxed);

                        if let Ok(mut stored_feature_level) =
                            app.state::<AppState>().d3d11_feature_level.lock()
                        {
                            *stored_feature_level = Some(feature_level);
                        }
                    }
                    Err(error) => {
                        eprintln!("{error}");
                    }
                }

                match platform::windows::probe_windows_graphics_capture() {
                    Ok(is_supported) => {
                        app.state::<AppState>()
                            .windows_graphics_capture_supported
                            .store(is_supported, Ordering::Relaxed);
                    }
                    Err(error) => {
                        eprintln!("{error}");
                    }
                }

                match platform::windows::exclude_overlay_from_capture(&overlay) {
                    Ok(()) => {
                        app.state::<AppState>()
                            .overlay_excluded_from_capture
                            .store(true, Ordering::Relaxed);
                    }
                    Err(error) => {
                        eprintln!("{error}");
                    }
                }

                match platform::windows::probe_capture_frame_pool(&overlay) {
                    Ok((capture_item_created, frame_pool_created)) => {
                        let state = app.state::<AppState>();
                        state
                            .capture_item_created
                            .store(capture_item_created, Ordering::Relaxed);
                        state
                            .frame_pool_created
                            .store(frame_pool_created, Ordering::Relaxed);
                    }
                    Err(error) => {
                        eprintln!("{error}");
                    }
                }

                match platform::windows::probe_first_capture_frame(&overlay) {
                    Ok((first_frame_received, frame_surface_available, captured_frame_size)) => {
                        let state = app.state::<AppState>();
                        state
                            .first_frame_received
                            .store(first_frame_received, Ordering::Relaxed);
                        state
                            .frame_surface_available
                            .store(frame_surface_available, Ordering::Relaxed);

                        store_captured_frame_size(state, captured_frame_size);
                    }
                    Err(error) => {
                        eprintln!("{error}");
                    }
                }

                match platform::windows::probe_composition_output(&overlay) {
                    Ok((
                        composition_swapchain_created,
                        direct_composition_target_created,
                        swapchain_backbuffer_presented,
                        direct_composition_committed,
                    )) => {
                        let state = app.state::<AppState>();
                        state
                            .composition_swapchain_created
                            .store(composition_swapchain_created, Ordering::Relaxed);
                        state
                            .direct_composition_target_created
                            .store(direct_composition_target_created, Ordering::Relaxed);
                        state
                            .swapchain_backbuffer_presented
                            .store(swapchain_backbuffer_presented, Ordering::Relaxed);
                        state
                            .direct_composition_committed
                            .store(direct_composition_committed, Ordering::Relaxed);
                    }
                    Err(error) => {
                        eprintln!("{error}");
                    }
                }

                match platform::windows::probe_capture_texture_to_composition(&overlay) {
                    Ok((
                        capture_texture_available,
                        capture_texture_size,
                        captured_frame_copied_to_swapchain,
                    )) => {
                        let state = app.state::<AppState>();
                        state
                            .capture_texture_available
                            .store(capture_texture_available, Ordering::Relaxed);
                        if let Ok(mut stored_capture_texture_size) =
                            state.capture_texture_size.lock()
                        {
                            *stored_capture_texture_size = capture_texture_size;
                        }
                        state
                            .captured_frame_copied_to_swapchain
                            .store(captured_frame_copied_to_swapchain, Ordering::Relaxed);
                    }
                    Err(error) => {
                        eprintln!("{error}");
                    }
                }
            }

            let handle = app.handle().clone();
            thread::spawn(move || {
                // Tauri cursor_position 跨平台且免权限：
                // Windows=GetCursorPos，macOS=NSEvent.mouseLocation，Linux=X11。
                // 返回物理像素，前端按 devicePixelRatio 换算回 CSS 像素。
                loop {
                    #[cfg(target_os = "macos")]
                    let cursor = platform::macos::corrected_cursor_position(&handle);
                    #[cfg(not(target_os = "macos"))]
                    let cursor = handle
                        .cursor_position()
                        .ok()
                        .map(|position| (position.x, position.y));

                    if let Some((x, y)) = cursor {
                        let _ = handle.emit_to(
                            "overlay",
                            "cursor-position",
                            CursorPosition {
                                x: x.round() as i32,
                                y: y.round() as i32,
                            },
                        );
                    }
                    thread::sleep(Duration::from_millis(16));
                }
            });

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("Focus Bubble");
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Focus Bubble");
}
