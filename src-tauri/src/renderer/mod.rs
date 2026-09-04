#![allow(dead_code)]

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FocusMode {
    Spotlight,
    Reading,
    Code,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusRegion {
    pub mode: FocusMode,
    pub mouse_x: f32,
    pub mouse_y: f32,
    pub radius: f32,
    pub feather: f32,
    pub reading_height: f32,
    pub code_height: f32,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayRenderSettings {
    pub enabled: bool,
    pub focus_region: FocusRegion,
    pub blur: f32,
    pub dim: f32,
}

/// GPU renderer 的 shader 参数。长度是物理像素（拉伸系数除外），
/// 由命令层把前端 CSS 像素乘以 scale factor 换算好。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GpuRendererParams {
    pub enabled: bool,
    /// 0 = spotlight, 1 = band（阅读/代码已合并）
    pub mode: i32,
    pub radius: f32,
    pub feather: f32,
    pub dim: f32,
    pub blur_px: f32,
    /// 横带半高（物理像素）。
    pub band_half_h: f32,
    /// 横带半宽（物理像素）；等于半屏宽即整幅横带。
    pub band_half_w: f32,
    /// 横带中心相对鼠标的偏移（物理像素，top-left 原点）。
    pub band_offset_x: f32,
    pub band_offset_y: f32,
    /// 气泡椭圆横向/纵向拉伸系数（无量纲，1.0 = 正圆）。
    pub spot_scale_x: f32,
    pub spot_scale_y: f32,
    /// 每帧低通跟随系数（0-1），由前端 smoothing 直接映射。
    /// 舒适度参数：让清晰区"追着鼠标走"而不是 1:1 抖动。
    pub tracking_alpha: f32,
}

impl Default for GpuRendererParams {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: 0,
            radius: 250.0,
            feather: 180.0,
            dim: 0.30,
            blur_px: 10.0,
            band_half_h: 130.0,
            band_half_w: 960.0,
            band_offset_x: 0.0,
            band_offset_y: 0.0,
            spot_scale_x: 1.0,
            spot_scale_y: 1.0,
            tracking_alpha: 0.14,
        }
    }
}

// ---------------------------------------------------------------------------
// 视觉舒适度约束层（平台无关，Windows shader 与 macOS maskImage 共享）
//
// 设计约束（docs/gpu-blur-architecture.md 第 0 节）：
//   - 稳定性优先：亮度和模糊强度绝不随速度调制（亮度闪变最伤眼）
//   - 鼠标高速时只轻微扩大清晰区/羽化、放慢跟随，参数变化必须平滑
//   - 速度信号噪声大，需双重平滑（速度 EMA + ease 低通）
//   - 阅读带模式纵向跟随更慢（按行吸附的感觉）
//   - 外围暗度硬性封顶 0.70
// ---------------------------------------------------------------------------

pub struct ComfortState {
    smoothed_mouse: [f32; 2],
    smoothed_speed: f32,
    /// 双重平滑后的速度因子（0-1），所有参数调制都基于它。
    ease: f32,
    last_raw_mouse: [f32; 2],
    has_frame: bool,
}

impl ComfortState {
    pub fn new() -> Self {
        Self {
            smoothed_mouse: [0.0; 2],
            smoothed_speed: 0.0,
            ease: 0.0,
            last_raw_mouse: [0.0; 2],
            has_frame: false,
        }
    }

    /// 平滑后的鼠标速度（物理 px/s），用于状态回显。
    pub fn smoothed_speed(&self) -> f32 {
        self.smoothed_speed
    }
}

/// 输入用户原始参数和原始鼠标位置，输出平滑后的鼠标位置和当帧生效参数。
/// `dt` 为距上一次调用的实际间隔（秒）。
pub fn update_comfort(
    raw_params: &GpuRendererParams,
    raw_mouse: [f32; 2],
    comfort: &mut ComfortState,
    dt: f32,
) -> ([f32; 2], GpuRendererParams) {
    let mut effective = *raw_params;

    // 暗度封顶独立于速度，任何时候不允许接近全黑。
    effective.dim = raw_params.dim.min(0.7);

    if !comfort.has_frame {
        comfort.smoothed_mouse = raw_mouse;
        comfort.last_raw_mouse = raw_mouse;
        comfort.has_frame = true;
        return (raw_mouse, effective);
    }

    let dt = dt.clamp(1.0 / 240.0, 0.25);
    let dx = raw_mouse[0] - comfort.last_raw_mouse[0];
    let dy = raw_mouse[1] - comfort.last_raw_mouse[1];
    let speed = (dx * dx + dy * dy).sqrt() / dt;

    // 帧率无关化：调用频率随渲染节奏变化（忙时 ~60Hz、闲时 4ms 轮询），
    // 所有指数平滑按 dt 换算到 60fps 基准，否则遮罩收敛速度忽快忽慢，
    // 表现为顿挫。
    let frames = (dt * 60.0).clamp(0.25, 4.0);
    let ease_alpha = 1.0 - (1.0f32 - 0.08).powf(frames);

    // 第一层平滑：速度 EMA，抬升/回落都温和，避免单帧噪声直通。
    let speed_alpha = if speed > comfort.smoothed_speed {
        1.0 - (1.0f32 - 0.12).powf(frames)
    } else {
        1.0 - (1.0f32 - 0.045).powf(frames)
    };
    comfort.smoothed_speed += (speed - comfort.smoothed_speed) * speed_alpha;
    comfort.last_raw_mouse = raw_mouse;

    // 第二层平滑：ease 因子低通，半径/羽化的变化本身也要缓。
    let t = (comfort.smoothed_speed / 4000.0).clamp(0.0, 1.0);
    let target_ease = t * t * (3.0 - 2.0 * t);
    comfort.ease += (target_ease - comfort.ease) * ease_alpha;
    let ease = comfort.ease;

    // 低通跟随：速度越高跟随越慢（清晰区追着鼠标走）。
    let tracking = raw_params.tracking_alpha * (1.0 - 0.6 * ease);
    let (alpha_x, alpha_y) = if raw_params.mode >= 1 {
        (
            1.0 - (1.0f32 - tracking).powf(frames),
            1.0 - (1.0f32 - tracking * 0.5).powf(frames),
        )
    } else {
        (
            1.0 - (1.0f32 - tracking).powf(frames),
            1.0 - (1.0f32 - tracking).powf(frames),
        )
    };
    comfort.smoothed_mouse[0] +=
        (raw_mouse[0] - comfort.smoothed_mouse[0]) * alpha_x.clamp(0.0, 1.0);
    comfort.smoothed_mouse[1] +=
        (raw_mouse[1] - comfort.smoothed_mouse[1]) * alpha_y.clamp(0.0, 1.0);

    // 速度自适应只作用于几何（轻微、平缓）：清晰区最多扩 25%，羽化最多 +140px。
    // 暗度与模糊保持恒定。
    effective.radius = raw_params.radius * (1.0 + 0.25 * ease);
    effective.band_half_h = raw_params.band_half_h * (1.0 + 0.25 * ease);
    effective.band_half_w = raw_params.band_half_w * (1.0 + 0.25 * ease);
    effective.feather = raw_params.feather + 140.0 * ease;

    (comfort.smoothed_mouse, effective)
}

pub trait OverlayRenderer {
    fn set_enabled(&mut self, enabled: bool);
    fn set_focus_region(&mut self, region: FocusRegion);
    fn set_blur(&mut self, blur: f32);
    fn set_dim(&mut self, dim: f32);
    fn render_frame(&mut self);
}

#[derive(Debug)]
pub struct CanvasRendererFallback {
    settings: OverlayRenderSettings,
}

impl CanvasRendererFallback {
    pub fn new(settings: OverlayRenderSettings) -> Self {
        Self { settings }
    }

    pub fn settings(&self) -> OverlayRenderSettings {
        self.settings
    }
}

impl OverlayRenderer for CanvasRendererFallback {
    fn set_enabled(&mut self, enabled: bool) {
        self.settings.enabled = enabled;
    }

    fn set_focus_region(&mut self, region: FocusRegion) {
        self.settings.focus_region = region;
    }

    fn set_blur(&mut self, blur: f32) {
        self.settings.blur = blur;
    }

    fn set_dim(&mut self, dim: f32) {
        self.settings.dim = dim;
    }

    fn render_frame(&mut self) {}
}
