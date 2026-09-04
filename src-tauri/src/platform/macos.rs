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

use super::mask_png::encode_grayscale_png;
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
                    .cast::<NSVisualEffectView>()
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
    let mut smoothed = [0.0f32; 2];
    let mut has_position = false;

    loop {
        thread::sleep(Duration::from_millis(33));

        let Some(overlay) = handle.get_webview_window("overlay") else {
            continue;
        };
        let (Ok(position), Ok(size), Ok(cursor)) = (
            overlay.outer_position(),
            overlay.outer_size(),
            handle.cursor_position(),
        ) else {
            continue;
        };

        let params = *params
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        // 全局物理坐标 -> overlay 本地物理坐标
        let local_x = cursor.x - position.x as f64;
        let local_y = cursor.y - position.y as f64;

        if !has_position {
            smoothed = [local_x as f32, local_y as f32];
            has_position = true;
        }
        let alpha = params.tracking_alpha.clamp(0.0, 1.0);
        smoothed[0] += (local_x as f32 - smoothed[0]) * alpha;
        smoothed[1] += (local_y as f32 - smoothed[1]) * alpha;

        let pixels = render_mask_pixels(&params, smoothed, size.width as f32, size.height as f32);
        let png = encode_grayscale_png(MASK_WIDTH, MASK_HEIGHT, &pixels);

        let send = handle.clone();
        let result = send.run_on_main_thread(move || unsafe {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let view: &NSVisualEffectView = &*(effect_ptr as *const NSVisualEffectView);
            let data = NSData::with_bytes(png.as_slice());
            let allocated = mtm.alloc::<NSImage>();
            if let Some(image) = NSImage::initWithData(allocated, &data) {
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

    data
}

