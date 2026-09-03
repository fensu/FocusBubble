import {
  BookOpen,
  Code2,
  Crosshair,
  Eye,
  Gauge,
  Globe2,
  MousePointer2,
  Power,
  Settings2,
  SlidersHorizontal,
} from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import './App.css'

type FocusMode = 'spotlight' | 'reading' | 'code'
type Language = 'zh-CN' | 'en-US'

type FocusSettings = {
  enabled: boolean
  mode: FocusMode
  language: Language
  radius: number
  feather: number
  blur: number
  opacity: number
  smoothing: number
  readingHeight: number
  codeHeight: number
  spotlightScaleX: number
  spotlightScaleY: number
  closeToTray: boolean
}

type CursorPoint = {
  x: number
  y: number
}

type GpuPrototypeStatus = {
  platform: string
  overlayExcludedFromCapture: boolean
  d3d11DeviceAvailable: boolean
  d3d11FeatureLevel: string | null
  windowsGraphicsCaptureSupported: boolean
  captureItemCreated: boolean
  framePoolCreated: boolean
  firstFrameReceived: boolean
  frameSurfaceAvailable: boolean
  capturedFrameSize: string | null
  compositionSwapchainCreated: boolean
  directCompositionTargetCreated: boolean
  swapchainBackbufferPresented: boolean
  directCompositionCommitted: boolean
  captureTextureAvailable: boolean
  captureTextureSize: string | null
  capturedFrameCopiedToSwapchain: boolean
  gpuRendererInitialized: boolean
  gpuRendererRunning: boolean
  gpuRendererFramesPresented: number
  gpuRendererFps: number
  gpuRendererCaptureSize: string | null
  gpuRendererLastError: string | null
  gpuRendererParams: string | null
  gpuCapturePipeline: string
  rendererBackend: string
}

const defaultSettings: FocusSettings = {
  enabled: true,
  mode: 'spotlight',
  language: 'zh-CN',
  radius: 240,
  feather: 180,
  blur: 10,
  opacity: 0.55,
  smoothing: 0.18,
  readingHeight: 260,
  codeHeight: 110,
  spotlightScaleX: 1,
  spotlightScaleY: 1,
  closeToTray: true,
}

const storageKey = 'focus-bubble-settings'
const channelName = 'focus-bubble-settings'

const copy = {
  'zh-CN': {
    running: '运行中',
    paused: '已暂停',
    language: '语言',
    closeBehavior: '关闭时',
    minimizeToTray: '最小化到托盘',
    exitOnClose: '直接退出',
    modes: '模式',
    intensity: '强度',
    resetDefaults: '恢复默认',
    preview: '遮罩预览',
    settings: '设置',
    spotlight: '气泡',
    spotlightDescription: '以鼠标为中心保留椭圆清晰区域，适合浏览和整理资料。',
    reading: '阅读',
    readingDescription: '把清晰区域拉成横向长条，减少段落上下方的干扰。',
    code: '代码',
    codeDescription: '保留更窄的行级区域，适合跟读代码、日志和表格。',
    radius: '清晰半径',
    feather: '边缘羽化',
    spotlightScaleX: '横向拉伸',
    spotlightScaleY: '纵向拉伸',
    blur: 'GPU 模糊',
    opacity: '外围暗度',
    smoothing: '跟随平滑',
    readingHeight: '阅读带高度',
    codeHeight: '代码行高度',
    renderer: '渲染器',
    platform: '平台',
    captureExclusion: '排除自身捕获',
    d3d11Device: 'D3D11 设备',
    d3d11FeatureLevel: 'D3D 特性级别',
    windowsGraphicsCapture: 'WGC 捕获',
    captureItem: 'Capture item',
    framePool: 'Frame pool',
    firstFrame: 'First frame',
    frameSurface: 'Frame surface',
    frameSize: 'Frame size',
    compositionSwapchain: 'Composition swapchain',
    directCompositionTarget: 'Composition target',
    swapchainPresent: 'Swapchain present',
    directCompositionCommit: 'DComp commit',
    captureTexture: 'Capture texture',
    captureTextureSize: 'Texture size',
    frameCopy: 'Frame copy',
    gpuPassthrough: '直通时，光圈/变暗/模糊跟随「运行中」开关和强度滑块',
    gpuPassthroughStart: '启动直通',
    gpuPassthroughStop: '停止直通',
    passthroughBusy: '切换中…',
    passthroughStatus: '直通运行',
    passthroughFps: '直通 FPS',
    passthroughFrames: '累计帧数',
    passthroughParams: '直通参数',
    passthroughSize: '直通尺寸',
    passthroughError: '直通错误',
    enabledStatus: '已启用',
    disabledStatus: '未启用',
    browserPreview: '浏览器预览',
    browserPipeline: 'Web 预览不连接原生 GPU 管线',
    canvasFallback: '当前：CanvasRenderer fallback',
  },
  'en-US': {
    running: 'Running',
    paused: 'Paused',
    language: 'Language',
    closeBehavior: 'On close',
    minimizeToTray: 'Minimize to tray',
    exitOnClose: 'Quit',
    modes: 'Modes',
    intensity: 'Intensity',
    resetDefaults: 'Reset defaults',
    preview: 'Mask preview',
    settings: 'Settings',
    spotlight: 'Bubble',
    spotlightDescription: 'Keeps a clear elliptical area around the pointer for browsing and sorting.',
    reading: 'Reading',
    readingDescription: 'Uses a horizontal clear band to reduce distractions above and below text.',
    code: 'Code',
    codeDescription: 'Keeps a tighter line-level band for code, logs, tables, and terminals.',
    radius: 'Clear radius',
    feather: 'Edge feather',
    spotlightScaleX: 'Horizontal stretch',
    spotlightScaleY: 'Vertical stretch',
    blur: 'GPU blur',
    opacity: 'Outer dim',
    smoothing: 'Follow smoothing',
    readingHeight: 'Reading band',
    codeHeight: 'Code band',
    renderer: 'Renderer',
    platform: 'Platform',
    captureExclusion: 'Capture exclusion',
    d3d11Device: 'D3D11 device',
    d3d11FeatureLevel: 'D3D feature level',
    windowsGraphicsCapture: 'WGC capture',
    captureItem: 'Capture item',
    framePool: 'Frame pool',
    firstFrame: 'First frame',
    frameSurface: 'Frame surface',
    frameSize: 'Frame size',
    compositionSwapchain: 'Composition swapchain',
    directCompositionTarget: 'Composition target',
    swapchainPresent: 'Swapchain present',
    directCompositionCommit: 'DComp commit',
    captureTexture: 'Capture texture',
    captureTextureSize: 'Texture size',
    frameCopy: 'Frame copy',
    gpuPassthrough: 'During passthrough the mask follows the Running toggle and intensity sliders',
    gpuPassthroughStart: 'Start passthrough',
    gpuPassthroughStop: 'Stop passthrough',
    passthroughBusy: 'Switching…',
    passthroughStatus: 'Passthrough',
    passthroughFps: 'Passthrough FPS',
    passthroughFrames: 'Frames total',
    passthroughParams: 'Applied params',
    passthroughSize: 'Capture size',
    passthroughError: 'Last error',
    enabledStatus: 'Enabled',
    disabledStatus: 'Disabled',
    browserPreview: 'Browser preview',
    browserPipeline: 'Web preview is not connected to the native GPU pipeline',
    canvasFallback: 'current: CanvasRenderer fallback',
  },
} satisfies Record<Language, Record<string, string>>

function loadSettings(): FocusSettings {
  try {
    const saved = localStorage.getItem(storageKey)
    return saved ? { ...defaultSettings, ...JSON.parse(saved) } : defaultSettings
  } catch {
    return defaultSettings
  }
}

function saveSettings(settings: FocusSettings) {
  localStorage.setItem(storageKey, JSON.stringify(settings))
  new BroadcastChannel(channelName).postMessage(settings)
}

function App() {
  const isOverlay = location.hash === '#overlay'

  if (isOverlay) {
    return <FocusOverlay />
  }

  return <ControlPanel />
}

function ControlPanel() {
  const [settings, setSettings] = useState<FocusSettings>(loadSettings)
  const [screenLimits, setScreenLimits] = useState(getScreenLimits)
  const [gpuStatus, setGpuStatus] = useState<GpuPrototypeStatus | null>(null)
  const [passthroughBusy, setPassthroughBusy] = useState(false)
  const t = copy[settings.language]

  useEffect(() => {
    saveSettings(settings)
  }, [settings])

  // 设置变化时同步给 GPU renderer（直通模式下 shader 参数实时生效）。
  useEffect(() => {
    invoke('gpu_renderer_set_params', {
      params: {
        enabled: settings.enabled,
        mode: settings.mode,
        radius: settings.radius,
        feather: settings.feather,
        dim: settings.opacity,
        blur: settings.blur,
        bandHeight:
          settings.mode === 'reading' ? settings.readingHeight : settings.codeHeight,
        spotlightScaleX: settings.spotlightScaleX,
        spotlightScaleY: settings.spotlightScaleY,
      },
    }).catch((error) => console.error('gpu_renderer_set_params failed:', error))
  }, [settings])

  // 托盘「开启/关闭效果」菜单回推的开关状态。
  useEffect(() => {
    let unlisten: undefined | (() => void)
    let cancelled = false

    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<boolean>('effect-toggled', (event) => {
          setSettings((current) => ({ ...current, enabled: event.payload }))
        }),
      )
      .then((cleanup) => {
        if (cancelled) {
          cleanup()
        } else {
          unlisten = cleanup
        }
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  // 关闭按钮行为同步给 Rust 侧窗口事件处理。
  useEffect(() => {
    invoke('set_close_behavior', { toTray: settings.closeToTray }).catch((error) =>
      console.error('set_close_behavior failed:', error),
    )
  }, [settings.closeToTray])

  useEffect(() => {
    const updateLimits = () => setScreenLimits(getScreenLimits())

    updateLimits()
    window.addEventListener('resize', updateLimits)
    return () => window.removeEventListener('resize', updateLimits)
  }, [])

  useEffect(() => {
    let cancelled = false

    const fetchStatus = () => {
      invoke<GpuPrototypeStatus>('gpu_prototype_status')
        .then((status) => {
          if (!cancelled) setGpuStatus(status)
        })
        .catch(() => {
          if (!cancelled) {
            setGpuStatus({
              platform: t.browserPreview,
              overlayExcludedFromCapture: false,
              d3d11DeviceAvailable: false,
              d3d11FeatureLevel: null,
              windowsGraphicsCaptureSupported: false,
              captureItemCreated: false,
              framePoolCreated: false,
              firstFrameReceived: false,
              frameSurfaceAvailable: false,
              capturedFrameSize: null,
              compositionSwapchainCreated: false,
              directCompositionTargetCreated: false,
              swapchainBackbufferPresented: false,
              directCompositionCommitted: false,
              captureTextureAvailable: false,
              captureTextureSize: null,
              capturedFrameCopiedToSwapchain: false,
              gpuRendererInitialized: false,
              gpuRendererRunning: false,
              gpuRendererFramesPresented: 0,
              gpuRendererFps: 0,
              gpuRendererCaptureSize: null,
              gpuRendererLastError: null,
              gpuRendererParams: null,
              gpuCapturePipeline: t.browserPipeline,
              rendererBackend: t.canvasFallback,
            })
          }
        })
    }

    fetchStatus()
    const timer = window.setInterval(fetchStatus, 2000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [t])

  const togglePassthrough = async () => {
    if (!gpuStatus || passthroughBusy || gpuStatus.platform !== 'windows') return

    setPassthroughBusy(true)

    try {
      if (gpuStatus.gpuRendererRunning) {
        await invoke('gpu_renderer_stop')
      } else {
        await invoke('gpu_renderer_start')
      }
    } catch (error) {
      console.error('failed to toggle GPU passthrough renderer:', error)
    } finally {
      try {
        const status = await invoke<GpuPrototypeStatus>('gpu_prototype_status')
        setGpuStatus(status)
      } catch {
        // 轮询会补上下一次状态
      }
      setPassthroughBusy(false)
    }
  }

  const update = <K extends keyof FocusSettings>(key: K, value: FocusSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }))
  }

  const resetDefaults = () => {
    setSettings((current) => ({ ...defaultSettings, language: current.language }))
  }

  const modeDetails = useMemo(
    () => ({
      spotlight: {
        icon: Crosshair,
        title: t.spotlight,
        description: t.spotlightDescription,
      },
      reading: {
        icon: BookOpen,
        title: t.reading,
        description: t.readingDescription,
      },
      code: {
        icon: Code2,
        title: t.code,
        description: t.codeDescription,
      },
    }),
    [t],
  )

  return (
    <main className="shell">
      <section className="workbench" aria-label="Focus Bubble">
        <header className="topbar">
          <p className="eyebrow">Focus Bubble</p>
          <div className="topActions">
            <label className="languageSelect">
              <Globe2 size={17} />
              <span>{t.language}</span>
              <select
                value={settings.language}
                onChange={(event) => update('language', event.target.value as Language)}
              >
                <option value="zh-CN">中文</option>
                <option value="en-US">English</option>
              </select>
            </label>
            <label className="languageSelect">
              <Power size={17} />
              <span>{t.closeBehavior}</span>
              <select
                value={settings.closeToTray ? 'tray' : 'exit'}
                onChange={(event) => update('closeToTray', event.target.value === 'tray')}
              >
                <option value="tray">{t.minimizeToTray}</option>
                <option value="exit">{t.exitOnClose}</option>
              </select>
            </label>
            <button
              className={settings.enabled ? 'power is-on' : 'power'}
              type="button"
              onClick={() => update('enabled', !settings.enabled)}
              aria-pressed={settings.enabled}
            >
              <Power size={18} />
              {settings.enabled ? t.running : t.paused}
            </button>
          </div>
        </header>

        <div className="layout">
          <section className="previewPane" aria-label={t.preview}>
            <FocusPreview settings={settings} />
          </section>

          <aside className="controlPane" aria-label={t.settings}>
            <div className="groupHeader">
              <Settings2 size={18} />
              <span>{t.modes}</span>
            </div>

            <div className="modeGrid" role="radiogroup" aria-label={t.modes}>
              {(Object.keys(modeDetails) as FocusMode[]).map((mode) => {
                const detail = modeDetails[mode]
                const Icon = detail.icon

                return (
                  <button
                    className={settings.mode === mode ? 'mode is-active' : 'mode'}
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={settings.mode === mode}
                    onClick={() => update('mode', mode)}
                  >
                    <Icon size={18} />
                    <strong>{detail.title}</strong>
                    <span>{detail.description}</span>
                  </button>
                )
              })}
            </div>

            <div className="groupHeader">
              <SlidersHorizontal size={18} />
              <span>{t.intensity}</span>
              <button type="button" className="headerAction" onClick={resetDefaults}>
                {t.resetDefaults}
              </button>
            </div>

            <div className="sliderGrid">
              {settings.mode === 'spotlight' && (
                <>
                  <RangeControl
                    icon={<Crosshair size={17} />}
                    label={t.radius}
                    min={40}
                    max={screenLimits.radiusMax}
                    step={10}
                    value={settings.radius}
                    suffix="px"
                    onChange={(value) => update('radius', value)}
                  />
                  <RangeControl
                    icon={<Crosshair size={17} />}
                    label={t.spotlightScaleX}
                    min={0.3}
                    max={3}
                    step={0.05}
                    value={settings.spotlightScaleX}
                    suffix=""
                    onChange={(value) => update('spotlightScaleX', value)}
                  />
                  <RangeControl
                    icon={<Crosshair size={17} />}
                    label={t.spotlightScaleY}
                    min={0.3}
                    max={3}
                    step={0.05}
                    value={settings.spotlightScaleY}
                    suffix=""
                    onChange={(value) => update('spotlightScaleY', value)}
                  />
                </>
              )}

              {settings.mode === 'reading' && (
                <RangeControl
                  icon={<BookOpen size={17} />}
                  label={t.readingHeight}
                  min={40}
                  max={screenLimits.heightMax}
                  step={10}
                  value={settings.readingHeight}
                  suffix="px"
                  onChange={(value) => update('readingHeight', value)}
                />
              )}

              {settings.mode === 'code' && (
                <RangeControl
                  icon={<Code2 size={17} />}
                  label={t.codeHeight}
                  min={24}
                  max={screenLimits.heightMax}
                  step={4}
                  value={settings.codeHeight}
                  suffix="px"
                  onChange={(value) => update('codeHeight', value)}
                />
              )}

              <RangeControl
                icon={<Eye size={17} />}
                label={t.feather}
                min={0}
                max={screenLimits.radiusMax}
                step={10}
                value={settings.feather}
                suffix="px"
                onChange={(value) => update('feather', value)}
              />
              <RangeControl
                icon={<Eye size={17} />}
                label={t.blur}
                min={0}
                max={28}
                step={1}
                value={settings.blur}
                suffix="px"
                onChange={(value) => update('blur', value)}
              />
              <RangeControl
                icon={<Gauge size={17} />}
                label={t.opacity}
                min={0.18}
                max={0.82}
                step={0.02}
                value={settings.opacity}
                suffix=""
                onChange={(value) => update('opacity', value)}
              />
              <RangeControl
                icon={<MousePointer2 size={17} />}
                label={t.smoothing}
                min={0.04}
                max={0.36}
                step={0.02}
                value={settings.smoothing}
                suffix=""
                onChange={(value) => update('smoothing', value)}
              />
            </div>

            {gpuStatus && (
              <GpuStatusPanel
                status={gpuStatus}
                labels={t}
                passthroughBusy={passthroughBusy}
                onTogglePassthrough={togglePassthrough}
              />
            )}
          </aside>
        </div>
      </section>
    </main>
  )
}

function GpuStatusPanel({
  status,
  labels,
  passthroughBusy,
  onTogglePassthrough,
}: {
  status: GpuPrototypeStatus
  labels: (typeof copy)[Language]
  passthroughBusy: boolean
  onTogglePassthrough: () => void
}) {
  const isWindows = status.platform === 'windows'

  return (
    <section className="statusPanel" aria-label={labels.renderer}>
      <div className="groupHeader">
        <Gauge size={18} />
        <span>{labels.renderer}</span>
        {isWindows && (
          <button
            type="button"
            className={status.gpuRendererRunning ? 'power is-on' : 'power'}
            disabled={passthroughBusy}
            aria-pressed={status.gpuRendererRunning}
            onClick={onTogglePassthrough}
          >
            {passthroughBusy
              ? labels.passthroughBusy
              : status.gpuRendererRunning
                ? labels.gpuPassthroughStop
                : labels.gpuPassthroughStart}
          </button>
        )}
      </div>
      <p className="passthroughHint">{labels.gpuPassthrough}</p>
      <dl>
        <div>
          <dt>{labels.platform}</dt>
          <dd>{status.platform}</dd>
        </div>
        <div>
          <dt>{labels.captureExclusion}</dt>
          <dd className={status.overlayExcludedFromCapture ? 'good' : 'muted'}>
            {status.overlayExcludedFromCapture ? labels.enabledStatus : labels.disabledStatus}
          </dd>
        </div>
        <div>
          <dt>{labels.d3d11Device}</dt>
          <dd className={status.d3d11DeviceAvailable ? 'good' : 'muted'}>
            {status.d3d11DeviceAvailable ? labels.enabledStatus : labels.disabledStatus}
          </dd>
        </div>
        <div>
          <dt>{labels.d3d11FeatureLevel}</dt>
          <dd>{status.d3d11FeatureLevel ?? '-'}</dd>
        </div>
        <div>
          <dt>{labels.windowsGraphicsCapture}</dt>
          <dd className={status.windowsGraphicsCaptureSupported ? 'good' : 'muted'}>
            {status.windowsGraphicsCaptureSupported ? labels.enabledStatus : labels.disabledStatus}
          </dd>
        </div>
        <div>
          <dt>{labels.captureItem}</dt>
          <dd className={status.captureItemCreated ? 'good' : 'muted'}>
            {status.captureItemCreated ? labels.enabledStatus : labels.disabledStatus}
          </dd>
        </div>
        <div>
          <dt>{labels.framePool}</dt>
          <dd className={status.framePoolCreated ? 'good' : 'muted'}>
            {status.framePoolCreated ? labels.enabledStatus : labels.disabledStatus}
          </dd>
        </div>
        <div>
          <dt>{labels.firstFrame}</dt>
          <dd className={status.firstFrameReceived ? 'good' : 'muted'}>
            {status.firstFrameReceived ? labels.enabledStatus : labels.disabledStatus}
          </dd>
        </div>
        <div>
          <dt>{labels.frameSurface}</dt>
          <dd className={status.frameSurfaceAvailable ? 'good' : 'muted'}>
            {status.frameSurfaceAvailable ? labels.enabledStatus : labels.disabledStatus}
          </dd>
        </div>
        <div>
          <dt>{labels.frameSize}</dt>
          <dd>{status.capturedFrameSize ?? '-'}</dd>
        </div>
        <div>
          <dt>{labels.compositionSwapchain}</dt>
          <dd className={status.compositionSwapchainCreated ? 'good' : 'muted'}>
            {status.compositionSwapchainCreated ? labels.enabledStatus : labels.disabledStatus}
          </dd>
        </div>
        <div>
          <dt>{labels.directCompositionTarget}</dt>
          <dd className={status.directCompositionTargetCreated ? 'good' : 'muted'}>
            {status.directCompositionTargetCreated ? labels.enabledStatus : labels.disabledStatus}
          </dd>
        </div>
        <div>
          <dt>{labels.swapchainPresent}</dt>
          <dd className={status.swapchainBackbufferPresented ? 'good' : 'muted'}>
            {status.swapchainBackbufferPresented ? labels.enabledStatus : labels.disabledStatus}
          </dd>
        </div>
        <div>
          <dt>{labels.directCompositionCommit}</dt>
          <dd className={status.directCompositionCommitted ? 'good' : 'muted'}>
            {status.directCompositionCommitted ? labels.enabledStatus : labels.disabledStatus}
          </dd>
        </div>
        <div>
          <dt>{labels.captureTexture}</dt>
          <dd className={status.captureTextureAvailable ? 'good' : 'muted'}>
            {status.captureTextureAvailable ? labels.enabledStatus : labels.disabledStatus}
          </dd>
        </div>
        <div>
          <dt>{labels.captureTextureSize}</dt>
          <dd>{status.captureTextureSize ?? '-'}</dd>
        </div>
        <div>
          <dt>{labels.frameCopy}</dt>
          <dd className={status.capturedFrameCopiedToSwapchain ? 'good' : 'muted'}>
            {status.capturedFrameCopiedToSwapchain ? labels.enabledStatus : labels.disabledStatus}
          </dd>
        </div>
        <div>
          <dt>{labels.passthroughStatus}</dt>
          <dd className={status.gpuRendererRunning ? 'good' : 'muted'}>
            {status.gpuRendererRunning ? labels.running : labels.paused}
          </dd>
        </div>
        <div>
          <dt>{labels.passthroughFps}</dt>
          <dd>{status.gpuRendererRunning ? status.gpuRendererFps : '-'}</dd>
        </div>
        <div>
          <dt>{labels.passthroughFrames}</dt>
          <dd>{status.gpuRendererFramesPresented}</dd>
        </div>
        <div>
          <dt>{labels.passthroughSize}</dt>
          <dd>{status.gpuRendererCaptureSize ?? '-'}</dd>
        </div>
        <div>
          <dt>{labels.passthroughError}</dt>
          <dd className="muted">{status.gpuRendererLastError ?? '-'}</dd>
        </div>
        <div>
          <dt>{labels.passthroughParams}</dt>
          <dd>{status.gpuRendererParams ?? '-'}</dd>
        </div>
        <div>
          <dt>Pipeline</dt>
          <dd>{status.gpuCapturePipeline}</dd>
        </div>
        <div>
          <dt>Backend</dt>
          <dd>{status.rendererBackend}</dd>
        </div>
      </dl>
    </section>
  )
}

function getScreenLimits() {
  const width = Math.max(window.screen?.availWidth ?? 0, window.innerWidth)
  const height = Math.max(window.screen?.availHeight ?? 0, window.innerHeight)

  return {
    radiusMax: Math.max(800, Math.ceil(Math.hypot(width, height))),
    heightMax: Math.max(480, height),
  }
}

function RangeControl({
  icon,
  label,
  min,
  max,
  step,
  value,
  suffix,
  onChange,
}: {
  icon: ReactNode
  label: string
  min: number
  max: number
  step: number
  value: number
  suffix: string
  onChange: (value: number) => void
}) {
  const display = suffix ? `${Math.round(value)}${suffix}` : value.toFixed(2)

  return (
    <label className="rangeRow">
      <span className="rangeLabel">
        {icon}
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{display}</output>
    </label>
  )
}

function FocusPreview({ settings }: { settings: FocusSettings }) {
  return (
    <div className="previewStage">
      <div className="mockWindow">
        <div className="mockToolbar">
          <span />
          <span />
          <span />
        </div>
        <div className="mockContent">
          {Array.from({ length: 14 }).map((_, index) => (
            <i key={index} style={{ width: `${44 + ((index * 17) % 45)}%` }} />
          ))}
        </div>
      </div>
      <div
        className={`previewMask ${settings.enabled ? '' : 'is-disabled'} ${settings.mode}`}
        style={
          {
            '--preview-opacity': settings.opacity,
            '--preview-radius': `${settings.radius / 5}px`,
            '--preview-feather': `${settings.feather / 5}px`,
            '--preview-rx': `${((settings.radius + settings.feather) / 5) * settings.spotlightScaleX}px`,
            '--preview-ry': `${((settings.radius + settings.feather) / 5) * settings.spotlightScaleY}px`,
            '--preview-inner': `${(settings.radius / Math.max(1, settings.radius + settings.feather)) * 100}%`,
            '--preview-blur': `${settings.blur}px`,
            '--preview-reading': `${settings.readingHeight / 4}px`,
            '--preview-code': `${settings.codeHeight / 2}px`,
          } as CSSProperties
        }
      />
      <div className="cursorMark" />
    </div>
  )
}

function FocusOverlay() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [settings, setSettings] = useState<FocusSettings>(loadSettings)
  const cursor = useRef<CursorPoint>({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
  const smooth = useRef<CursorPoint>({ x: window.innerWidth / 2, y: window.innerHeight / 2 })

  useEffect(() => {
    const channel = new BroadcastChannel(channelName)
    channel.onmessage = (event) => setSettings({ ...defaultSettings, ...event.data })

    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey) {
        setSettings(loadSettings())
      }
    }

    window.addEventListener('storage', onStorage)
    return () => {
      channel.close()
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      cursor.current = { x: event.clientX, y: event.clientY }
    }

    window.addEventListener('pointermove', onPointerMove)
    return () => window.removeEventListener('pointermove', onPointerMove)
  }, [])

  useEffect(() => {
    let unlisten: undefined | (() => void)
    let cancelled = false

    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<CursorPoint>('cursor-position', (event) => {
          cursor.current = event.payload
        }),
      )
      .then((cleanup) => {
        if (cancelled) {
          cleanup()
        } else {
          unlisten = cleanup
        }
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const context = canvas.getContext('2d')
    if (!context) return

    let frame = 0

    const resize = () => {
      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.floor(window.innerWidth * ratio)
      canvas.height = Math.floor(window.innerHeight * ratio)
      canvas.style.width = `${window.innerWidth}px`
      canvas.style.height = `${window.innerHeight}px`
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
    }

    const draw = () => {
      const { width, height } = canvas.getBoundingClientRect()
      const target = cursor.current
      const current = smooth.current
      current.x += (target.x - current.x) * settings.smoothing
      current.y += (target.y - current.y) * settings.smoothing

      context.clearRect(0, 0, width, height)

      if (settings.enabled) {
        context.save()
        context.fillStyle = `rgba(12, 16, 20, ${settings.opacity})`
        context.fillRect(0, 0, width, height)
        context.globalCompositeOperation = 'destination-out'

        if (settings.mode === 'spotlight') {
          // 圆形渐变配 scale 变换得到椭圆：半轴 = radius * scale。
          context.save()
          context.translate(current.x, current.y)
          context.scale(settings.spotlightScaleX, settings.spotlightScaleY)
          const gradient = context.createRadialGradient(
            0,
            0,
            Math.max(1, settings.radius * 0.62),
            0,
            0,
            settings.radius + settings.feather,
          )
          gradient.addColorStop(0, 'rgba(0, 0, 0, 1)')
          gradient.addColorStop(0.58, 'rgba(0, 0, 0, 0.92)')
          gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
          context.fillStyle = gradient
          const span = 4000
          context.fillRect(-span, -span, span * 2, span * 2)
          context.restore()
        }

        if (settings.mode === 'reading' || settings.mode === 'code') {
          const bandHeight = settings.mode === 'reading' ? settings.readingHeight : settings.codeHeight
          const gradient = context.createLinearGradient(0, current.y - bandHeight, 0, current.y + bandHeight)
          gradient.addColorStop(0, 'rgba(0, 0, 0, 0)')
          gradient.addColorStop(0.28, 'rgba(0, 0, 0, 1)')
          gradient.addColorStop(0.72, 'rgba(0, 0, 0, 1)')
          gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
          context.fillStyle = gradient
          context.fillRect(0, current.y - bandHeight, width, bandHeight * 2)
        }

        context.restore()
      }

      frame = requestAnimationFrame(draw)
    }

    resize()
    window.addEventListener('resize', resize)
    frame = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
    }
  }, [settings])

  return <canvas ref={canvasRef} className="overlayCanvas" aria-hidden="true" />
}

export default App
