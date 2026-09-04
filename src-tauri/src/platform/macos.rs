//! macOS 原生模糊：NSVisualEffectView (behindWindow) + 跟随鼠标的 maskImage。
//!
//! 路线来自 docs/gpu-blur-architecture.md 第 5 节：
//! - `window-vibrancy` 在 overlay 窗口内挂一个 behindWindow 的 effect view，
//!   系统合成器负责模糊窗口后方内容（无需屏幕录制权限）；
//! - maskImage 控制"哪里有模糊"：小尺寸灰度图被拉伸到整个视图，
//!   黑色 = 无模糊（清晰区），白色 = 模糊（外围）；
//! - 更新线程按 30fps 重算 mask（低通跟随鼠标），经 run_on_main_thread
//!   生成 NSImage 并 setMaskImage。

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use objc2_app_kit::{
    NSImage, NSView, NSVisualEffectMaterial as NSVisualEffectMaterialRaw, NSVisualEffectView,
};
use objc2_foundation::{MainThreadMarker, NSData, NSEdgeInsets};
use tauri::Manager;

use super::mask_png::encode_mask_png;
use crate::renderer::GpuRendererParams;

/// window-vibrancy 给 effect view 打的 tag（其源码 NS_VIEW_TAG_BLUR_VIEW）。
const BLUR_VIEW_TAG: isize = 91376254;

/// mask 分辨率。maskImage 会被拉伸到视图尺寸，小图足够且重建便宜。
const MASK_WIDTH: usize = 160;
const MASK_HEIGHT: usize = 90;

static MAC_BLUR_RUNNING: AtomicBool = AtomicBool::new(false);

pub fn mac_blur_running() -> bool {
    MAC_BLUR_RUNNING.load(Ordering::Relaxed)
}

/// 修正 tao 0.35 cursor_position 在缩放显示器上的 Y 单位混用 bug：
/// tao 计算 `物理高度 - 逻辑y` 后又整体乘 scale，Retina 下 y 超出屏幕
/// 范围（光圈被画到屏幕外，表现为全屏模糊）。把 y 除回 scale 恰好还原
/// 为正确的 top-left 物理 y；scale=1 时是 no-op。
pub fn corrected_cursor_position(handle: &tauri::AppHandle) -> Option<(f64, f64)> {
    let position = handle.cursor_position().ok()?;
    let scale = handle
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(1.0)
        .max(0.1);
    Some((position.x, position.y / scale))
}

/// 在主线程调用（Tauri setup 即主线程）。
pub fn start_mac_blur(app: &tauri::AppHandle, params: Arc<Mutex<GpuRendererParams>>) {
    if MAC_BLUR_RUNNING.swap(true, Ordering::Relaxed) {
        return;
    }

    let Some(overlay) = app.get_webview_window("overlay") else {
        return;
    };

    // UnderWindowBackground 自带灰调底色（"灰蒙蒙"的来源之一）；
    // Sidebar 是最接近"纯毛玻璃"的浅色材质，变暗仍由 Canvas 层负责。
    let applied = window_vibrancy::apply_vibrancy(
        &overlay,
        window_vibrancy::NSVisualEffectMaterial::Sidebar,
        Some(window_vibrancy::NSVisualEffectState::Active),
        None,
    );
    if let Err(error) = applied {
        eprintln!("apply_vibrancy failed: {error:?}");
        MAC_BLUR_RUNNING.store(false, Ordering::Relaxed);
        return;
    }

    // 找回 effect view 的原始指针；view 由窗口层级持有，应用存活期间有效。
    // 之后只在主线程（run_on_main_thread 回调内）解引用。
    let ns_view = match overlay.ns_view() {
        Ok(view) => view,
        Err(error) => {
            eprintln!("failed to obtain overlay ns_view: {error}");
            MAC_BLUR_RUNNING.store(false, Ordering::Relaxed);
            return;
        }
    };

    let effect_ptr = unsafe {
        let view: &NSView = &*(ns_view as *mut NSView);
        match view.viewWithTag(BLUR_VIEW_TAG) {
            Some(found) => {
                let effect = found
                    .downcast::<NSVisualEffectView>()
                    .expect("tagged view is an NSVisualEffectView");
                effect.as_ref() as *const NSVisualEffectView as usize
            }
            None => {
                eprintln!("vibrancy effect view not found by tag");
                MAC_BLUR_RUNNING.store(false, Ordering::Relaxed);
                return;
            }
        }
    };

    let handle = app.clone();
    thread::spawn(move || mask_update_loop(handle, params, effect_ptr));
}

/// blur 滑块在 macOS 上映射为三档材质（vibrancy 的模糊半径系统固定，
/// 用材质的通透度近似强弱）：低=Menu（最通透的毛玻璃）、中=Popover、
/// 高=Sidebar（最实）。返回 NSVisualEffectMaterial 原始值；0 表示关闭。
fn material_tier_for(blur_px: f32) -> isize {
    if blur_px < 1.0 {
        0 // 关闭：mask 全黑，材质无意义
    } else if blur_px < 10.0 {
        5 // Menu
    } else if blur_px < 20.0 {
        6 // Popover
    } else {
        7 // Sidebar
    }
}

fn mask_update_loop(
    handle: tauri::AppHandle,
    params: Arc<Mutex<GpuRendererParams>>,
    effect_ptr: usize,
) {
    // 与 Windows shader / Canvas 同一套舒适度层：mask 的清晰区必须与
    // Canvas 光圈一起"呼吸"，否则鼠标移动时模糊会吃进视觉清晰区。
    let mut comfort = crate::renderer::ComfortState::new();
    let mut comfort_tick = std::time::Instant::now();
    let mut diagnostic_tick = std::time::Instant::now();
    // 几何测试模式：FOCUS_BUBBLE_MASK_INVERT=1 时反转 mask（圆内模糊、圆外清晰），
    // 用于直接观察 mask 认为的"圆"到底在哪。正常模式恒为 false。
    let invert_mask = std::env::var("FOCUS_BUBBLE_MASK_INVERT").ok().as_deref() == Some("1");
    // 材质探索：FOCUS_BUBBLE_MATERIAL=<NSVisualEffectMaterial 数值> 强制指定材质
    // （如 5=Menu 6=Popover 7=Sidebar 3=Titlebar 12=WindowBackground 21=UnderWindowBackground），
    // 便于一次构建逐个试效果。
    let material_override = std::env::var("FOCUS_BUBBLE_MATERIAL")
        .ok()
        .and_then(|value| value.parse::<isize>().ok());
    let mut current_material: isize = 7;

    loop {
        thread::sleep(Duration::from_millis(16));

        let Some(overlay) = handle.get_webview_window("overlay") else {
            continue;
        };
        let (Ok(position), Ok(size)) = (overlay.outer_position(), overlay.outer_size()) else {
            continue;
        };
        let Some((cursor_x, cursor_y)) = corrected_cursor_position(&handle) else {
            continue;
        };

        let raw_params = *params
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        // 全局物理坐标 -> overlay 本地物理坐标
        let raw_mouse = [
            (cursor_x - position.x as f64) as f32,
            (cursor_y - position.y as f64) as f32,
        ];

        let dt = comfort_tick.elapsed().as_secs_f32();
        comfort_tick = std::time::Instant::now();
        let (smoothed_mouse, effective_params) =
            crate::renderer::update_comfort(&raw_params, raw_mouse, &mut comfort, dt);

        let mut pixels = render_mask_pixels(
            &effective_params,
            smoothed_mouse,
            size.width as f32,
            size.height as f32,
        );
        if invert_mask {
            for value in pixels.iter_mut() {
                *value = 255 - *value;
            }
        }

        // 每秒一条诊断：本地鼠标、屏幕物理尺寸、缩放比、生效参数与 mask 采样，
        // 排查坐标/参数链路问题直接看这行。
        if diagnostic_tick.elapsed() >= Duration::from_secs(1) {
            diagnostic_tick = std::time::Instant::now();
            let center = pixels[(MASK_HEIGHT / 2) * MASK_WIDTH + MASK_WIDTH / 2];
            let corner = pixels[0];
            let scale = overlay.scale_factor().unwrap_or(1.0);
            eprintln!(
                "[mac-blur] local_mouse={:.0},{:.0} screen={}x{} scale={} mode={} radius={:.0} feather={:.0} blur={:.0} band={:.0} enabled={} mask_center={} mask_corner={}",
                smoothed_mouse[0],
                smoothed_mouse[1],
                size.width,
                size.height,
                scale,
                effective_params.mode,
                effective_params.radius,
                effective_params.feather,
                effective_params.blur_px,
                effective_params.band_half_px,
                effective_params.enabled,
                center,
                corner
            );
        }

        let png = encode_mask_png(MASK_WIDTH, MASK_HEIGHT, &pixels);

        // 材质随 blur 档位切换（或被环境变量锁定）。
        let target_material = material_override
            .unwrap_or_else(|| material_tier_for(effective_params.blur_px));
        let material_to_set = (target_material != 0 && target_material != current_material)
            .then_some(target_material);
        if let Some(material) = material_to_set {
            current_material = material;
        }

        let send = handle.clone();
        let result = send.run_on_main_thread(move || unsafe {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let view: &NSVisualEffectView = &*(effect_ptr as *const NSVisualEffectView);
            if let Some(material) = material_to_set {
                view.setMaterial(NSVisualEffectMaterialRaw(material));
            }
            let data = NSData::with_bytes(png.as_slice());
            let allocated = mtm.alloc::<NSImage>();
            if let Some(image) = NSImage::initWithData(allocated, &data) {
                image.setSize(view.bounds().size);
                // SDK 文档要求用 capInsets 声明拉伸；不设置时小图会按原始
                // 尺寸平铺（表现为屏幕上出现一块块重复的清晰区域）。
                image.setCapInsets(NSEdgeInsets {
                    top: 1.0,
                    left: 1.0,
                    bottom: 1.0,
                    right: 1.0,
                });
                view.setMaskImage(Some(&image));
            }
        });
        if let Err(error) = result {
            eprintln!("run_on_main_thread for mask update failed: {error}");
        }
    }
}

/// 与 Windows shader 相同的距离模型：黑色（0）= 清晰区，白色（255）= 模糊。
/// mask 绘制中心的额外偏移（top-left 原点，屏幕宽高比例）。capInsets 拉伸
/// 修复映射后应保持 0；仅在实际仍存在固定偏移时用于校准。
const MASK_OFFSET_X: f32 = 0.0;
const MASK_OFFSET_Y: f32 = 0.0;

fn render_mask_pixels(
    params: &GpuRendererParams,
    mouse: [f32; 2],
    screen_width: f32,
    screen_height: f32,
) -> Vec<u8> {
    let mut data = vec![0u8; MASK_WIDTH * MASK_HEIGHT];
    // 未启用或 blur=0：全黑 mask = 完全无模糊（等同关闭）。
    if !params.enabled || params.blur_px < 1.0 {
        return data;
    }

    let is_spotlight = params.mode == 0;
    let edge = if is_spotlight {
        params.radius
    } else {
        params.band_half_px
    };
    let feather = params.feather.max(1.0);
    let scale_x = params.spot_scale_x.max(0.1);
    let scale_y = params.spot_scale_y.max(0.1);

    let center = [
        mouse[0] + screen_width * MASK_OFFSET_X,
        mouse[1] + screen_height * MASK_OFFSET_Y,
    ];

    for y in 0..MASK_HEIGHT {
        let py = (y as f32 + 0.5) / MASK_HEIGHT as f32 * screen_height;
        for x in 0..MASK_WIDTH {
            let px = (x as f32 + 0.5) / MASK_WIDTH as f32 * screen_width;
            let dist = if is_spotlight {
                let dx = (px - center[0]) / scale_x;
                let dy = (py - center[1]) / scale_y;
                (dx * dx + dy * dy).sqrt()
            } else {
                (py - center[1]).abs()
            };
            let t = ((dist - edge) / feather).clamp(0.0, 1.0);
            let mask = t * t * (3.0 - 2.0 * t);
            data[y * MASK_WIDTH + x] = (mask * 255.0).round() as u8;
        }
    }

    // 实测确认：maskImage 按图像正立渲染（顶行在屏幕顶部），top-left 原点
    // 直出即可；不要做垂直翻转（Y 会镜像到鼠标另一侧）。
    data
}

