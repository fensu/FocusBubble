# Focus Bubble

ADHD 友好的桌面视觉聚焦工具。它把屏幕变成一个"跟随意图移动的视野"：鼠标周围保持清晰，外围轻微降低亮度与干扰，帮助注意力留在当前任务上，而不是被屏幕角落的内容不断拉走。

Focus Bubble 是一个**视觉环境调节器**：降低外围视觉干扰、提供可调节的视觉聚焦环境。

## 功能

### 聚焦模式

| 模式 | 说明 |
| --- | --- |
| 气泡 | 鼠标周围的椭圆清晰区，横向/纵向可独立拉伸（横向长椭圆适合阅读行，纵向适合代码列） |
| 阅读 | 横向清晰带，减少段落上下方的干扰 |
| 代码 | 更窄的行级清晰带，适合跟读代码、日志、表格 |

### GPU 真模糊（Windows）

桌面像素全程留在显卡上，无 CPU 截图拷贝：

```text
Windows Graphics Capture 捕获
  -> D3D11 降采样（1/4）
  -> 双向高斯模糊
  -> 光圈遮罩 + 外围变暗合成
  -> DirectComposition 全屏覆盖层
```

- 覆盖层鼠标穿透、置顶、自身排除在捕获之外（无"镜中镜"递归）
- 外围真实高斯模糊（0–28px），不是斜纹或点阵遮罩
- GPU 不可用时自动回退到 Canvas 渲染

### 视觉舒适度设计

产品目标是"舒服的注意力遮罩"，而不是"在眼前晃动的探照灯"：

- 默认外围暗度温和（约 30%，硬性封顶 70%），宽羽化过渡，无亮暗硬边
- 清晰区低通平滑跟随，不 1:1 贴着鼠标抖动
- 鼠标快速移动时自动变柔和：外围变亮、清晰区临时扩大、过渡加宽、跟随变慢；停止后逐渐收拢
- 阅读带模式纵向跟随减速，接近"按行吸附"
- 内置预设：低动态（弱暗化 + 大羽化 + 慢跟随）/ 强聚焦（短时高强度）
- 不做呼吸、闪烁等周期性亮度变化

### 其他

- 系统托盘：打开主面板 / 开启·关闭效果 / 退出；关闭窗口默认最小化到托盘（可改为直接退出）
- 7 种界面语言：中文、English、日本語、한국어、Deutsch、Français、Español
- 所有参数实时生效并本地持久化

## 已实现

- [x] 三种聚焦模式（GPU + Canvas 双渲染路径）
- [x] Windows GPU 真模糊管线（WGC → D3D11 → DirectComposition）
- [x] macOS 原生模糊（NSVisualEffectView behindWindow + 跟随鼠标的 maskImage，无需屏幕录制权限）
- [x] 视觉舒适度约束层（速度自适应 + 平滑跟随）
- [x] 气泡椭圆双向拉伸
- [x] 系统托盘 + 关闭行为配置
- [x] 应用内手动检查更新 + 后台下载安装
- [x] 多语言界面
- [x] 运行状态面板（FPS、生效参数、错误回显）

## 计划中

- [ ] Linux（Wayland 下仅 Canvas 雾化，X11 实验性 GPU 捕获）
- [ ] 多显示器支持（跟随鼠标所在显示器）
- [ ] 全局快捷键
- [ ] resize / 显卡设备移除的自动恢复
- [ ] 参数 A/B 对比模式（暗度 × 羽化 × 跟随 × 速度曲线）

## 运行与开发

环境要求：

- Node.js 20.19+（建议 22）
- Rust stable（`rustup`）
- Windows 10 1903+（GPU 模糊需要；其他平台走 Canvas 回退）
- macOS（开发可运行，GPU 模糊未实现，走 Canvas 回退）

```bash
npm install          # 安装前端依赖
npm run desktop:dev  # 开发模式（Vite + cargo，热更新）
```

本地打包：

```bash
npm run tauri build            # 按当前平台默认目标打包
npx tauri build --no-bundle    # 只编译可执行文件（Windows 免安装 exe）
npx tauri icon src-tauri/app-icon.png   # 重新生成全套图标
```

## 持续发布（GitHub Actions）

`.github/workflows/release.yml`：

- **触发**：推送 `v*` 标签自动构建并发布 GitHub Release，也可在 Actions 页面手动触发（手动触发只上传 artifact）
- **Windows**：免安装绿色版 zip（单个 exe，不写注册表、不需要安装器；依赖系统 WebView2，Win10/11 一般已内置）
- **macOS**：universal dmg（同时支持 Intel / Apple Silicon；未签名，首次打开需右键 → 打开）

```bash
git tag v0.1.0
git push origin v0.1.0   # 触发打包发布
```

## 项目结构

```text
src/                  React 控制面板 + Canvas 覆盖层
src-tauri/src/
  platform/windows.rs GPU 渲染管线（WGC 捕获、HLSL 着色器、DComp 呈现、舒适度层）
  renderer/mod.rs     渲染参数模型与 OverlayRenderer 抽象
docs/gpu-blur-architecture.md   架构与设计约束文档
```

---

## 友情链接

[LINUX DO](https://linux.do/)
