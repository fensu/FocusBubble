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

use objc2_app_kit::{NSImage, NSView, NSVisualEffectView};
use objc2_foundation::{MainThreadMarker, NSData};
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

    // UnderWindowBackground：中性模糊，专为窗口后方内容设计；
    // 外围变暗仍由 Canvas overlay 负责，这里只贡献模糊。
    let applied = window_vibrancy::apply_vibrancy(
        &overlay,
        window_vibrancy::NSVisualEffectMaterial::UnderWindowBackground,
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

        let pixels = render_mask_pixels(
            &effective_params,
            smoothed_mouse,
            size.width as f32,
            size.height as f32,
        );

        // 每秒一条诊断：本地鼠标、屏幕物理尺寸、生效参数与 mask 采样，
        // 排查坐标/参数链路问题直接看这行。
        if diagnostic_tick.elapsed() >= Duration::from_secs(1) {
            diagnostic_tick = std::time::Instant::now();
            let center = pixels[(MASK_HEIGHT / 2) * MASK_WIDTH + MASK_WIDTH / 2];
            let corner = pixels[0];
            eprintln!(
                "[mac-blur] local_mouse={:.0},{:.0} screen={}x{} mode={} radius={:.0} feather={:.0} blur={:.0} band={:.0} enabled={} mask_center={} mask_corner={}",
                smoothed_mouse[0],
                smoothed_mouse[1],
                size.width,
                size.height,
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

        let send = handle.clone();
        let result = send.run_on_main_thread(move || unsafe {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let view: &NSVisualEffectView = &*(effect_ptr as *const NSVisualEffectView);
            let data = NSData::with_bytes(png.as_slice());
            let allocated = mtm.alloc::<NSImage>();
            if let Some(image) = NSImage::initWithData(allocated, &data) {
                // 图像 point 尺寸与视图 bounds 对齐，消除缩放映射歧义。
                image.setSize(view.bounds().size);
                view.setMaskImage(Some(&image));
            }
        });
        if let Err(error) = result {
            eprintln!("run_on_main_thread for mask update failed: {error}");
        }
    }
}

/// 与 Windows shader 相同的距离模型：黑色（0）= 清晰区，白色（255）= 模糊。
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

    for y in 0..MASK_HEIGHT {
        let py = (y as f32 + 0.5) / MASK_HEIGHT as f32 * screen_height;
        for x in 0..MASK_WIDTH {
            let px = (x as f32 + 0.5) / MASK_WIDTH as f32 * screen_width;
            let dist = if is_spotlight {
                let dx = (px - mouse[0]) / scale_x;
                let dy = (py - mouse[1]) / scale_y;
                (dx * dx + dy * dy).sqrt()
            } else {
                (py - mouse[1]).abs()
            };
            let t = ((dist - edge) / feather).clamp(0.0, 1.0);
            let mask = t * t * (3.0 - 2.0 * t);
            data[y * MASK_WIDTH + x] = (mask * 255.0).round() as u8;
        }
    }

    // AppKit 非翻转坐标系：图像 y=0 在视图底部，本函数按顶部原点计算，
    // 输出前垂直翻转，否则清晰区出现在鼠标的镜像位置。
    let mut flipped = vec![0u8; MASK_WIDTH * MASK_HEIGHT];
    for y in 0..MASK_HEIGHT {
        let source_row = MASK_HEIGHT - 1 - y;
        flipped[y * MASK_WIDTH..][..MASK_WIDTH]
            .copy_from_slice(&data[source_row * MASK_WIDTH..][..MASK_WIDTH]);
    }

    flipped
}

