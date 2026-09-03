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
#[derive(Clone, Copy, Debug)]
pub struct GpuRendererParams {
    pub enabled: bool,
    /// 0 = spotlight, 1 = reading, 2 = code
    pub mode: i32,
    pub radius: f32,
    pub feather: f32,
    pub dim: f32,
    pub blur_px: f32,
    pub band_half_px: f32,
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
            band_half_px: 280.0,
            spot_scale_x: 1.0,
            spot_scale_y: 1.0,
            tracking_alpha: 0.14,
        }
    }
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
