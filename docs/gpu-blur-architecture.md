# Focus Bubble GPU 真模糊架构

## 0. 视觉舒适度约束层（设计红线）

产品定位是"视觉环境调节器"：降低外围视觉干扰、提供可调节的视觉聚焦环境。不使用任何医疗/护眼疗效表述。

核心设计原则：**降低干扰优先于制造明暗反差**。避免"高对比度探照灯追着鼠标跑"的观感。

实现（Rust `update_comfort` + Canvas 同规则镜像，参数模型为"用户值 + 舒适度变换"双层）：

- 默认外围暗度温和（0.30，建议区间 20–35%），舒适层硬性封顶 0.70。
- 宽羽化：默认 radius 250 / feather 180（建议 feather 为 radius 的 1/3 到 4/5）。
- 低通跟随：清晰区"追着鼠标走"（每帧 alpha = smoothing），不 1:1 贴抖动。
- **稳定性红线：亮度和模糊强度绝不随鼠标速度调制**——亮度闪变最伤眼，速度信号本身噪声大，直接调制会把噪声变成可见闪烁（v0.2.0 修复的教训）。
- 鼠标速度自适应（双重平滑：速度 EMA 0.12/0.045 + ease 低通 0.08，4000 px/s 满速）：
  - radius / band ×(1+0.25·ease)（最多扩 25%，轻微）
  - feather +140·ease
  - 跟随系数 ×(1−0.6·ease)（高速时跟随更慢）
  - dim、blur 恒定不变
  - 鼠标停止后参数逐渐收拢。
- 阅读带模式纵向跟随系数减半（按行吸附的感觉）。
- 不做周期性呼吸、闪烁、快速开关效果；大面积亮度变化必须渐进。
- 预设：默认（舒适）/ 低动态（dim 0.20 + feather 280 + smoothing 0.08）/ 强聚焦（dim 0.55 + feather 120，短时使用）。
- 自动更新：tauri updater 插件 + GitHub Release `latest.json` 清单（NSIS 安装包与 .app.tar.gz 签名产物），应用内顶栏提示安装。

最值得 A/B 测试的四个参数：外围暗度 × 羽化宽度 × 跟随延迟 × 鼠标速度自适应曲线。

## 1. 结论

Focus Bubble 可以做真正的显卡模糊，但不应该用 CPU 截图和 Canvas `ImageData` 做实时 blur。正确方向是尽可能让桌面像素从捕获、降采样、模糊、变暗、mask 混合到最终 overlay 呈现都留在 GPU 上。

真正要解决的问题不是 `How to blur?`，而是：

```text
How do I obtain the pixels behind my transparent overlay
without CPU copies and without capturing Focus Bubble itself?
```

只要稳定拿到 overlay 背后的桌面像素，blur shader 本身是相对简单的部分。

## 2. Windows 高级 pipeline

目标 pipeline：

```text
Desktop
  -> Windows Graphics Capture
  -> GPU capture texture
  -> Direct3D 11/12
  -> downsample 1/2 or 1/4
  -> horizontal blur shader
  -> vertical blur shader
  -> upsample
  -> dim shader
  -> focus mask shader
  -> DirectComposition / swapchain
  -> transparent fullscreen overlay
```

Windows Graphics Capture 可以通过 `Direct3D11CaptureFramePool` 获取 `Direct3D11CaptureFrame`，帧中包含 GPU surface。实现时应避免每帧把像素拷回 CPU。

性能策略：

```text
2560 x 1440
  -> downsample 1/4
640 x 360
  -> blur
640 x 360
  -> upscale
2560 x 1440
```

外围失焦不需要对原始分辨率做 30px Gaussian blur。降采样后模糊再放大，视觉上足够接近，GPU 成本更低。

## 3. 统一 mask shader

Focus Bubble 的三个模式可以共用同一条 GPU pipeline，只替换 distance function。

通用混合：

```glsl
mask = smoothstep(radius, radius + feather, distance);
output = mix(original, blurredAndDarkened, mask);
```

气泡模式：

```glsl
distance = length(pixel - mouse);
```

阅读模式：

```glsl
distance = abs(pixel.y - mouse.y);
```

代码模式：

```glsl
distance = abs(pixel.y - mouse.y);
```

阅读模式和代码模式的差异主要是 clear band 高度、feather 和默认参数，而不是 pipeline 差异。

## 4. 最大风险：递归捕获

如果 pipeline 捕获的是最终合成后的屏幕，而 Focus Bubble overlay 已经显示在屏幕上，就可能出现：

```text
capture desktop
  includes Focus Bubble overlay
render blurred overlay
next frame captures previous overlay
render again
...
```

这会产生类似 OBS 镜厅效果的递归画面。

Windows prototype 必须优先验证：

- overlay 是否能从 Windows Graphics Capture 中排除。
- 排除能力在 Windows 版本、GPU、缩放比例、多显示器下是否稳定。
- capture target 应该是 display、monitor、window，还是 compositor 中 overlay 下面的内容。
- 透明、置顶、鼠标穿透 overlay 是否会影响 capture exclusion。

这项验证比 blur shader 更关键。

## 5. macOS 高级路线

macOS 可能有更自然的系统级路径：

```text
transparent NSWindow
  -> NSVisualEffectView
     -> blendingMode = behindWindow
     -> material = underWindowBackground or similar
     -> maskImage = screen minus Focus Bubble region
```

`NSVisualEffectView` 的 `behindWindow` 模式由系统 compositor 使用窗口后方内容做混合和模糊。相比持续截屏，这条路径更符合 macOS 平台能力，值得优先实验。

### macOS 已实现与踩坑记录（v0.3.x，`platform/macos.rs`）

**当前实现**：

- `window-vibrancy` 在 overlay 挂 behindWindow 的 NSVisualEffectView（material=Sidebar，取其最接近纯毛玻璃的浅色调；变暗由 Canvas 层负责，两层叠加）。
- 更新线程 60fps：tao `cursor_position`（已修正 Retina Y 单位 bug）→ 共享舒适度层 `renderer::update_comfort`（与 Windows shader / Canvas 同一套呼吸参数）→ 160x90 RGBA mask（**alpha 通道携带 mask 值**，SDK 文档明确 alpha 通道作掩码；纯灰度图处处 alpha=1 等于全糊）→ 手写 PNG 编码器（`platform/mask_png.rs`，Node zlib 外部校验过字节）→ `run_on_main_thread` 中 `setSize(view.bounds)` + **`setCapInsets(1,1,1,1)`** + `setMaskImage`。
- 每秒一条 `[mac-blur]` 诊断日志（本地鼠标/屏幕/缩放/生效参数/mask 采样）。

**踩坑记录（按发现顺序）**：

1. 原生 `fullscreen(true)` 在 macOS 是切 Space 接管屏幕 → 黑屏。改为无边框窗口铺屏。
2. `device_query` 需要辅助功能权限（弹窗还被 overlay 挡住）→ 换 tao `cursor_position`（NSEvent 被动查询，免权限）。
3. objc2-app-kit 新版 `NSScreen::mainScreen` 要求 MainThreadMarker、`Retained` 类转换是 `downcast` 不是 `cast` —— CI 编译炸两次。教训：macOS 专用 API 必须逐个从 crate 源码核对签名。
4. tao `cursor_position` 的 Retina bug：`物理高度 − 逻辑y` 后又乘 scale，y 飞出屏幕 → mask 圆心永远在屏幕外 → 全屏模糊。修正：y 除回 scale。
5. mask 图像不做垂直翻转（实测 maskImage 按图像正立渲染，翻转反而镜像）。
6. **mask 图像默认不平铺拉伸**：SDK 文档要求 "properly set capInsets to stretch"。不设置 capInsets 时小图按原始尺寸平铺——用户看到的"一块块清晰小区域"就是 12x12 平铺；必须 `setCapInsets`。
7. UnderWindowBackground 材质自带灰调（"灰蒙蒙"感）→ 换 Sidebar 材质。

**几何测试模式**：`FOCUS_BUBBLE_MASK_INVERT=1 npm run desktop:dev` 启动时反转 mask（圆内模糊、圆外清晰），直接观察 mask 认为的圆在哪里，用于校准映射。

**待验证 / 后续路线**：

- capInsets 拉伸后 mask 几何是否精确对位（用反转模式验收）。
- NSVisualEffectView 的固有局限：模糊强度不可调（material 固定）、带色调。若要 Windows 级的渐变模糊，候选路线：
  - a) CALayer `backgroundFilters` + CIGaussianBlur（半径可调，但 10.14+ 系统对 backgroundFilters 支持不稳，需实测）；
  - b) ScreenCaptureKit（SCStream）捕获排除自身窗口的桌面 + Metal shader 模糊（最接近 Windows WGC 管线，工程量大，macOS 12.3+）；
  - c) 接受 vibrancy 现状，把精力放回 Windows 主线。
- 多显示器目前按主显示器处理（阶段 E）。

## 6. Linux 策略

Linux 不强行承诺统一真模糊：

| 平台 | 策略 |
| --- | --- |
| X11 | 可实验 compositor-dependent blur 或捕获后 GPU blur |
| Wayland | 默认只提供 Canvas 雾化，不承诺真 blur |

Wayland 的安全模型对全局屏幕捕获、全局鼠标和透明 overlay 都更严格。Focus Bubble 在 Linux 上应先保证 fallback 稳定。

## 7. Renderer 抽象

前端仍然负责用户配置：

- `mode`
- `mouseX`
- `mouseY`
- `radius`
- `feather`
- `dim`
- `blur`
- `enabled`

渲染后端抽象为：

```rust
trait OverlayRenderer {
    fn set_enabled(&mut self, enabled: bool);
    fn set_focus_region(&mut self, region: FocusRegion);
    fn set_blur(&mut self, blur: f32);
    fn set_dim(&mut self, dim: f32);
    fn render_frame(&mut self);
}
```

候选实现：

```text
CanvasRenderer
WindowsGpuRenderer
MacVisualEffectRenderer
LinuxCompositorRenderer
```

当前项目的 React Canvas overlay 属于 `CanvasRenderer`。它是稳定 fallback，不是最终高质量真模糊路径。

## 8. Windows prototype 验证顺序

1. 将当前 overlay window 设置为 `WDA_EXCLUDEFROMCAPTURE`。已开始实现。
2. 在控制面板暴露 Windows GPU prototype 状态，确认 overlay 是否完成 capture exclusion。已开始实现。
3. Probe D3D11 device creation with BGRA support。已开始实现。
4. Probe `GraphicsCaptureSession::IsSupported()`。已开始实现。
5. 创建当前 monitor 的 `GraphicsCaptureItem`。已开始实现。
6. 创建 `Direct3D11CaptureFramePool::CreateFreeThreaded`。已开始实现。
7. 创建 capture session 并启动 `StartCapture()`。已开始实现。
8. 通过 `TryGetNextFrame()` 获取第一帧。已开始实现。
9. 验证 `frame.Surface()` 可用。已开始实现。
10. 创建 DirectComposition target 和 composition swapchain。已开始实现。
11. 清空 composition swapchain back buffer、`Present`，并提交 DirectComposition visual tree。已开始实现。
12. 确认 frame 保持在 GPU surface，不拷贝到 CPU。
13. 输出原始 captured texture 到 overlay。
14. 验证 overlay 不被下一帧 capture 捕获。
15. 加入 1/4 downsample。
16. 加入 separable blur：horizontal pass + vertical pass。
17. 加入 dim shader。
18. 加入 focus mask shader。
19. 接入当前控制面板的 radius、feather、dim、blur、mode、mouse position。

如果第 13 步无法稳定解决，Windows 真模糊就不能作为默认功能，只能作为实验功能。

## 9. 当前实现状态

已实现：

- `src-tauri/src/platform/windows.rs`：Windows overlay capture exclusion。
- `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`：启动时应用到 overlay 窗口。
- `D3D11CreateDevice` probe：启动时验证当前机器是否能创建带 BGRA support 的 D3D11 hardware device。
- `GraphicsCaptureSession::IsSupported()` probe：启动时验证系统是否支持 Windows Graphics Capture。
- `IGraphicsCaptureItemInterop::CreateForMonitor` probe：使用 overlay 所在 monitor 创建 capture item。
- `Direct3D11CaptureFramePool::CreateFreeThreaded` probe：用 WinRT `IDirect3DDevice` 创建 frame pool。
- `CreateCaptureSession` + `StartCapture` probe：启动 capture session。
- `TryGetNextFrame` probe：短时间轮询第一帧。
- `Direct3D11CaptureFrame::Surface` probe：验证第一帧提供 GPU surface。
- `DCompositionCreateDevice` probe：验证当前 D3D11 device 可用于 DirectComposition。
- `CreateTargetForHwnd` probe：验证 overlay HWND 可作为 DirectComposition target。
- `CreateSwapChainForComposition` probe：验证可创建带 premultiplied alpha 的 composition swapchain。
- `IDXGISwapChain1::GetBuffer` + `CreateRenderTargetView` probe：验证 composition swapchain back buffer 可作为 D3D11 render target。
- `ClearRenderTargetView` + `Present` probe：清透明 back buffer 并提交一帧。
- `IDCompositionVisual::SetContent` + `IDCompositionTarget::SetRoot` + `Commit` probe：验证 swapchain 可提交到 overlay 的 DirectComposition visual tree。
- `gpu_prototype_status` Tauri command：向前端返回平台、capture exclusion 和 renderer 状态。
- 控制面板 renderer 状态区：显示 capture、frame surface、DirectComposition target、composition swapchain、present 和 commit 状态。
- `src-tauri/src/platform/windows.rs`：`GpuRenderer`（阶段 A 已实现）。
  - `GpuRenderer::start(window)`：spawn 专用 render thread，线程内完成 COM 初始化（`CoInitializeEx`）、D3D11 device、monitor capture item、`CreateFreeThreaded` frame pool、capture session、DComp target/visual、composition swapchain 的创建，初始化结果通过 channel 回传。
  - render thread 持续循环：`TryGetNextFrame -> Surface -> ID3D11Texture2D -> CopyResource 到 swapchain back buffer -> Present(1)`；无新帧时 4ms 轮询；visual 树只在启动时 `Commit` 一次。
  - `CopyResource` 前校验 capture texture 与 back buffer 的尺寸和 format，不匹配立即报错（阶段 B 换 shader copy pass 解决）。
  - `GpuRenderer::stop()`：stop flag + join 线程，对象随线程栈销毁；`Drop` 自动 stop。
  - 运行状态通过原子快照暴露：initialized、running、frames presented、capture size、last error。
- `gpu_renderer_start` / `gpu_renderer_stop` Tauri command：控制直通渲染的启停；renderer 已死亡（device lost 等）时允许重新启动。
- 控制面板 renderer 状态区新增「GPU 原图直通（阶段 A）」开关、直通运行状态、已呈现帧数、捕获尺寸和最近错误；状态每 2 秒轮询。
- 「直通参数」回显：render thread 每帧把实际使用的物理像素参数写入状态，参数链路问题可直接从控制面板读出。
- 系统托盘（`tray-icon` feature）：右键菜单「打开主面板 / 开启·关闭效果 / 退出」，左键点击打开主面板；开关效果会同时翻转 Rust 侧 GPU 参数和前端 settings（`effect-toggled` 事件）。
- 关闭行为：主窗口关闭按钮默认隐藏到托盘（`close_to_tray`），控制面板「关闭时」可选「直接退出」；「退出」菜单 `app.exit(0)` 真正结束进程。此前"关窗后进程残留"的根因是全屏 overlay 窗口永不关闭，进程因此存活。
- 气泡模式椭圆：`spot_scale_x` / `spot_scale_y` 拉伸系数（0.3–3.0），shader 里 `length((pixel - mouse) / scale)` 实现椭圆距离；Canvas fallback 用 translate + scale 实现同样效果；预览图用 `radial-gradient(ellipse ...)`。
- 控制面板改纵向布局：预览图置顶（高度驱动），模式三列排在预览下方，强度滑块按模式动态显示（气泡：半径+双向拉伸；阅读：带高度；代码：行高度；羽化/模糊/暗度/平滑全模式共用），滑块两列排布，「恢复默认」一键重置（保留语言选择）。
- 默认配置（开箱可见效果）：radius 240 / feather 180 / blur 10 / dim 0.55 / reading 260 / code 110 / 拉伸 1.0 / 托盘关闭。
- `src-tauri/src/renderer/mod.rs`：`OverlayRenderer` trait 和 Canvas fallback 骨架。

尚未实现：

- 阶段 E 工程化：多显示器、DPI/resize、device-lost 恢复、设置持久化、快捷键/托盘。
- GPU 侧鼠标 smoothing（当前直接跟随）。
- blur 强度迭代（当前单轮 9-tap；不够强可加多轮迭代）。

## 10. 接下来开发顺序

当前已经实现到（阶段 A 已由用户验收：直通画面正常、无镜厅递归）：

```text
WGC frame
  -> ID3D11Texture2D
  -> pass1 横向模糊 + 1/4 降采样 (PSBlurH)
  -> pass2 纵向模糊 (PSBlurV)
  -> pass3 光圈 mask + 变暗 + 模糊混合 (PSComposite)
  -> composition swapchain
  -> Present
  -> DirectComposition Commit
```

阶段 B/C/D 已合并实现：`windows.rs` 中 HLSL 源码运行时编译（`D3DCompile`），三个 pass 全部在 GPU 上，无 CPU 像素拷贝。前端参数（enabled/mode/radius/feather/dim/blur/bandHeight）经 `gpu_renderer_set_params` 命令写入共享参数，render thread 每帧读取并更新 constant buffer；鼠标位置由 Rust 侧 `GetCursorPos` + monitor rect 换算为捕获局部物理坐标，不走前端。

### 阶段 A：显示捕获原图

状态：已验收（CopyResource 版本已被 shader 管线取代）。

### 阶段 B：最小 shader copy pass

状态：已实现，合并进 blur 管线（fullscreen triangle + SRV/RTV）。

### 阶段 C：dim + focus mask

状态：已实现（PSComposite：spotlight 圆形距离 / reading+code 横带距离，smoothstep feather，外围变暗）。

### 阶段 D：真正 blur

状态：已实现（1/4 降采样 + 9-tap separable Gaussian，blur slider 0-28 CSS px 映射到 quarter 空间步长）。

待用户验收：

- 直通开启 + enabled 开启时，三种模式都有光圈和外围变暗。
- blur slider 从 0 到 28 有明显模糊半径变化；blur=0 时外围只是变暗不模糊。
- 鼠标跟随光圈（GPU 侧暂无 smoothing，直接跟随）。
- 直通 FPS 行显示真实帧率（桌面静止时会下降，这是 WGC 按需产帧，不是掉帧）。

### 阶段 E：工程化

完成视觉效果后再做：

1. 多显示器：每个 monitor 一个 capture item 或选择当前鼠标所在 monitor。
2. DPI/缩放：统一物理像素坐标，不用 CSS 像素参与 shader。
3. resize：窗口或显示器变化时重建 swapchain、RTV、临时 texture。
4. device lost：D3D device 移除时完整重建 renderer。
5. 设置持久化：blur、dim、radius、mode 全部落盘。
6. 快捷键：全局热键开关 overlay/切换模式（托盘已完成）。

## 11. 当前优先级

### 已修复的关键 bug：cbuffer 布局不匹配

现象：直通正常显示桌面、无报错，但光圈/变暗/模糊全部无效，滑块无反应。

根因：HLSL `packoffset(c1)` 按 16 字节寄存器编址（字节 16），而 Rust `ShaderConstants` 的第二个字段在字节 8。所有 shader 参数从错误位置读取，`enabled` 读到 64 字节缓冲之外恒为 0，`PSComposite` 每帧走"返回原图"分支。

修复：packoffset 与 Rust 布局逐字节对齐（两个 float2 共享 c0，标量从 c1.x 依次排布，`enabled` 在 c3.x，共 4 寄存器 64 字节）。**教训：新增 cbuffer 字段时，HLSL packoffset 和 `#[repr(C)]` Rust 结构必须一起改，并保证 `size_of` 等于寄存器数 × 16。**

同时新增了「直通参数」状态回显（render thread 每帧写入实际使用的物理像素参数），参数链路问题以后可以直接从控制面板读出。

最高优先级：

```text
验收 shader 管线：光圈 + 变暗 + 真模糊
```

操作：单实例 `npm run desktop:dev` → 控制面板点「启动直通」→ 确认「运行中」开关是开启状态 → 调整 blur / 清晰半径 / 外围暗度滑块。

验收要点：

- 三种模式（气泡/阅读/代码）光圈由 GPU shader 控制，跟随鼠标。
- blur slider 明显改变外围模糊程度；blur=0 时外围只变暗。
- 「直通 FPS」接近刷新率（画面变化时），桌面静止时下降属正常（WGC 按需产帧）。

如果失败，看状态面板「直通错误」：

- `D3DCompile failed ...`：HLSL 编译错误，错误详情会带 fxc 的行号信息。
- 黑屏但帧数在涨：composite pass 输出有问题，检查 alpha 是否强制为 1、viewport 是否 backbuffer 尺寸。
- 光圈位置不对：多显示器下鼠标坐标换算（GetCursorPos 全局 → monitor 局部）可能出错，或 DPI scale 不符。

验收通过后的下一步是阶段 E（工程化：多显示器、resize、device-lost、设置持久化、快捷键/托盘）。
