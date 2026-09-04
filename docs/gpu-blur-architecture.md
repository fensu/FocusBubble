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

## 2. Windows 实现（v0.1.x 现行架构）

```text
覆盖层窗口（Tauri WebviewWindow）
  ├─ 无边框 + 原生全屏 + 置顶 + 鼠标穿透 + 空标题 + 不可 resize
  ├─ transparent(true) + background_color(0,0,0,0)
  ├─ WDA_EXCLUDEFROMCAPTURE（自身不出现在捕获里，防镜厅递归）
  └─ 直通运行期间 WebView 隐藏（画面由 DComp 独占，规避 Win10 透明
     WebView 的顶部残留条 artifact）

GPU 渲染线程（platform/windows.rs，全部对象线程内创建/销毁）
  ├─ D3D11 hardware device（BGRA support）
  ├─ WGC：CreateForMonitor capture item → CreateFreeThreaded frame pool(2)
  │   → session（SetIsBorderRequired(false) 尽力关黄框；
  │      光标捕获默认开启——Win10 关闭存在光标混入闪烁缺陷，
  │      FOCUS_BUBBLE_DISABLE_CURSOR_CAPTURE=1 可强制关）
  ├─ 合成目标：DComp device + target(hwnd, topmost) + visual +
  │   composition swapchain（premultiplied alpha, flip sequential）
  └─ 渲染循环（~60fps）：
      共享参数 + GetCursorPos(局部物理坐标)
      → renderer::update_comfort（dt 归一化双重平滑）
      → TryGetNextFrame → CopyResource 到自有纹理（与帧池生命周期解耦）
      → 触发条件（新帧 / 参数变化 / 鼠标移动[仅光标捕获关闭时]）
      → Present(0) 即时提交 + 8ms 自限频

着色器管线（启动时 D3DCompile 编译内嵌 HLSL）
  VS：fullscreen triangle（SV_VertexID）
  PSBlurH：capture → 1/4 降采样 + 横向 9-tap Gaussian
  PSBlurV：quarterA → quarterB 纵向
  PSComposite：光圈 mask（气泡椭圆 / 横带矩形 SDF + 偏移）
      + dim + blur 混合 + 光标透明孔（见下）→ premultiplied 输出
  cbuffer 5 寄存器（80 字节），字段与 Rust #[repr(C)] 结构逐字节对齐

光标透明孔（PSComposite）
  鼠标周围 radius 56px（+速度扩张 48px）alpha=0 羽化孔，
  孔内 DWM 直接透出 overlay 底下的【真实桌面】——实时零延迟真光标，
  捕获画面里的旧光标被完全盖住（消除拖影）。

诊断：状态面板「直通参数/FPS」+ overlay Canvas 帧率上报。
```

性能策略：外围失焦不需要对原始分辨率做 30px Gaussian blur——1/4 降采样模糊再放大，
视觉足够接近，GPU 成本更低。

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

## 5. macOS 实现（v0.1.x 现行架构）

```text
覆盖层窗口
  ├─ 无边框窗口直接铺满显示器（不用原生全屏——会切 Space 接管屏幕）
  ├─ 置顶 + 鼠标穿透 + macos-private-api feature（透明）
  └─ 鼠标：tao cursor_position（修正 Retina Y 单位 bug：y/scale）

模糊层（platform/macos.rs，系统毛玻璃，无需屏幕录制权限）
  window-vibrancy 在 overlay 挂 behindWindow NSVisualEffectView
  ├─ 材质随 blur 滑块分档：1-9 Menu / 10-19 Popover / 20+ Sidebar
  │  （FOCUS_BUBBLE_MATERIAL=<数值> 可强制任意材质探索）
  └─ mask 更新线程 60fps：
      共享参数 + 修正后鼠标 → renderer::update_comfort（与 Windows 同一套）
      → 160x90 RGBA mask（alpha 通道携带 mask 值；气泡椭圆 / 横带矩形 SDF+偏移）
      → 手写 PNG 编码器（mask_png.rs，无图像库依赖）
      → run_on_main_thread：NSImage(initWithData)
         + setSize(view.bounds) + setCapInsets(1,1,1,1)  ← 必需，否则平铺
         + setMaskImage

暗化层（Canvas WebView，与模糊层叠加）
  全屏 dim + 逐圈累积填充挖洞（12 圈同心圆角矩形，
  alpha 由累积公式反解，精确复刻 mask 的 smoothstep 羽化轮廓，
  两层过渡几何对齐——错位会产生亮暗边界线）

诊断：每秒一条 [mac-blur] 日志（鼠标/屏幕/scale/参数/mask 采样）。
```

### 踩坑记录（按发现顺序）：

1. 原生 `fullscreen(true)` 在 macOS 是切 Space 接管屏幕 → 黑屏。改为无边框窗口铺屏。
2. `device_query` 需要辅助功能权限（弹窗还被 overlay 挡住）→ 换 tao `cursor_position`（NSEvent 被动查询，免权限）。
3. objc2-app-kit 新版 `NSScreen::mainScreen` 要求 MainThreadMarker、`Retained` 类转换是 `downcast` 不是 `cast` —— CI 编译炸两次。教训：macOS 专用 API 必须逐个从 crate 源码核对签名。
4. tao `cursor_position` 的 Retina bug：`物理高度 − 逻辑y` 后又乘 scale，y 飞出屏幕 → mask 圆心永远在屏幕外 → 全屏模糊。修正：y 除回 scale。
5. mask 图像不做垂直翻转（实测 maskImage 按图像正立渲染，翻转反而镜像）。
6. **mask 图像默认不平铺拉伸**：SDK 文档要求 "properly set capInsets to stretch"。不设置 capInsets 时小图按原始尺寸平铺——用户看到的"一块块清晰小区域"就是 12x12 平铺；必须 `setCapInsets`。
7. UnderWindowBackground 材质自带灰调（"灰蒙蒙"感）→ 换 Sidebar 材质。
8. maskImage 掩码用的是图像 **alpha 通道**：纯灰度 PNG 处处 alpha=1 等于全糊。
9. Canvas 挖洞若不显式设置全不透明 fillStyle，会复用暗化层的半透明色 → 横带内部残留暗度。

**几何测试模式**：`FOCUS_BUBBLE_MASK_INVERT=1 npm run desktop:dev` 启动时反转 mask（圆内模糊、圆外清晰），直接观察 mask 认为的圆在哪里，用于校准映射。

**固有局限**：vibrancy 模糊半径不可调、材质带色调。若要 Windows 级渐变模糊，候选路线：a) CALayer `backgroundFilters` + CIGaussianBlur（10.14+ 支持不稳）；b) ScreenCaptureKit + Metal（最接近 WGC，工程量大）；c) 维持现状。多显示器目前按主显示器处理。

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

已实现（细节见第 2/5 节）：

- Windows：完整 GPU 管线（WGC→shader→DComp）、光标透明孔、直通期间 WebView 隐藏、合成与捕获帧解耦、即时呈现 + 8ms 限频、启动 probe 全套。
- macOS：vibrancy 毛玻璃 + alpha mask（capInsets 拉伸）、Canvas 暗化层 smoothstep 对齐、免权限鼠标、材质三档。
- 共享：视觉舒适度层（dt 归一化）、参数按平台/按模式分离存储、托盘、应用内手动更新、7 语言、健康提示（首启确认 + 常驻警告）、效果关闭警告。

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
