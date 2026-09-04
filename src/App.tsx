import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Crosshair,
  Eye,
  Gauge,
  Globe2,
  MousePointer2,
  Power,
  RectangleHorizontal,
  RefreshCw,
  RotateCcw,
  Settings2,
  SlidersHorizontal,
} from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import './App.css'

type FocusMode = 'spotlight' | 'band'
type Language = 'zh-CN' | 'en-US' | 'ja-JP' | 'ko-KR' | 'de-DE' | 'fr-FR' | 'es-ES'

// 参数按模式分离：气泡/横带各自的羽化、模糊、暗度、平滑互不影响，
// 只有效果开关、语言、关闭行为等全局项共享。
type FocusSettings = {
  enabled: boolean
  mode: FocusMode
  language: Language
  closeToTray: boolean
  warningAcknowledged: boolean
  spotRadius: number
  spotFeather: number
  spotBlur: number
  spotOpacity: number
  spotSmoothing: number
  spotScaleX: number
  spotScaleY: number
  bandHeight: number
  bandWidth: number
  bandOffsetX: number
  bandOffsetY: number
  bandFeather: number
  bandBlur: number
  bandOpacity: number
  bandSmoothing: number
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
  effectsEnabled: boolean
  canvasFps: number
  nativeBlurRunning: boolean
  gpuCapturePipeline: string
  rendererBackend: string
}

// 参数按平台分离存储与同步：Windows 调好的数值在 macOS 上的观感不同，
// 两侧互不污染。
const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)
const platformSuffix = IS_MAC ? 'macos' : 'windows'
const storageKey = `focus-bubble-settings-${platformSuffix}`
const channelName = `focus-bubble-settings-${platformSuffix}`

// 视觉舒适度默认值：外围暗度温和（20–35% 区间）、宽羽化、慢跟随。
// 首次使用不默认开启效果：确认健康提示后由用户手动开启。
const defaultSettings: FocusSettings = {
  enabled: false,
  warningAcknowledged: false,
  mode: 'spotlight',
  language: 'zh-CN',
  closeToTray: true,
  spotRadius: 250,
  spotFeather: 180,
  spotBlur: 10,
  spotOpacity: 0.3,
  spotSmoothing: 0.14,
  spotScaleX: 1,
  spotScaleY: 1,
  bandHeight: 400,
  bandWidth: 1920,
  bandOffsetX: 0,
  bandOffsetY: 0,
  bandFeather: 240,
  bandBlur: 10,
  bandOpacity: 0.3,
  bandSmoothing: 0.14,
}

// 预设按模式分离：只作用于当前模式的参数。
const lowMotionPreset: Record<FocusMode, Partial<FocusSettings>> = {
  spotlight: { spotRadius: 300, spotFeather: 280, spotBlur: 12, spotOpacity: 0.2, spotSmoothing: 0.08 },
  band: { bandFeather: 300, bandBlur: 12, bandOpacity: 0.2, bandSmoothing: 0.08 },
}

// 强聚焦模式：更明显的遮罩对比，适合高干扰环境短时使用。
// macOS 模糊强度由系统 material 决定，过强的暗度+模糊叠加会不可用，单独给温和值。
const strongFocusPreset: Record<FocusMode, Partial<FocusSettings>> = IS_MAC
  ? {
      spotlight: { spotRadius: 240, spotFeather: 220, spotBlur: 14, spotOpacity: 0.45, spotSmoothing: 0.2 },
      band: { bandFeather: 220, bandBlur: 14, bandOpacity: 0.4, bandSmoothing: 0.2 },
    }
  : {
      spotlight: { spotRadius: 220, spotFeather: 120, spotBlur: 16, spotOpacity: 0.55, spotSmoothing: 0.22 },
      band: { bandFeather: 140, bandBlur: 16, bandOpacity: 0.55, bandSmoothing: 0.22 },
    }

const copy = {
  'zh-CN': {
    running: '运行中',
    healthTitle: '健康与安全提示',
    healthBody: '本软件会持续改变屏幕的亮度与清晰度分布。使用过程中如出现频闪、眼痛、头痛、眩晕或视觉异常，请立即关闭本软件并休息。有光敏性癫痫、偏头痛病史或眼部疾病者，请在使用前咨询医生。',
    healthAck: '我已了解，开始使用',
    maskOn: '效果开启',
    maskOff: '效果关闭',
    paused: '已暂停',
    language: '语言',
    closeBehavior: '关闭时',
    minimizeToTray: '最小化到托盘',
    exitOnClose: '直接退出',
    modes: '模式',
    intensity: '强度',
    resetDefaults: '恢复默认',
    lowMotion: '低动态',
    strongFocus: '强聚焦',
    checkUpdates: '检查更新',
    upToDate: '已是最新',
    installUpdate: '安装更新',
    healthReminder: '健康提示：使用中如出现频闪或任何不适，请立即关闭效果并休息',
    effectsOffWarning: '效果已关闭：遮罩未生效，点击右侧按钮开启',
    enableEffects: '开启效果',
    updateDownloading: '下载中',
    updateInstalling: '正在更新…',
    preview: '遮罩预览',
    settings: '设置',
    spotlight: '气泡',
    spotlightDescription: '以鼠标为中心保留椭圆清晰区域，适合浏览和整理资料。',
    band: '横带',
    bandDescription: '宽度和高度都可调的清晰矩形区域，中心可相对鼠标偏移，适合阅读行、代码行和字幕。',
    radius: '清晰半径',
    feather: '边缘羽化',
    spotlightScaleX: '横向拉伸',
    spotlightScaleY: '纵向拉伸',
    blur: 'GPU 模糊',
    opacity: '外围暗度',
    smoothing: '跟随平滑',
    bandHeight: '横带高度',
    bandWidth: '横带宽度',
    offset: '位置偏移',
    resetOffset: '回中',
        renderer: '渲染器',
    nativeBlur: '原生模糊',
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
    canvasFps: 'Canvas 帧率',
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
    healthTitle: 'Health & Safety Notice',
    healthBody: 'This app continuously changes screen brightness and clarity. If you experience flickering, eye pain, headache, dizziness, or visual disturbances while using it, close the app immediately and rest. Consult a doctor before use if you have a history of photosensitive epilepsy, migraine, or eye conditions.',
    healthAck: 'I understand, start',
    maskOn: 'Effects on',
    maskOff: 'Effects off',
    paused: 'Paused',
    language: 'Language',
    closeBehavior: 'On close',
    minimizeToTray: 'Minimize to tray',
    exitOnClose: 'Quit',
    modes: 'Modes',
    intensity: 'Intensity',
    resetDefaults: 'Reset defaults',
    lowMotion: 'Low motion',
    strongFocus: 'Strong focus',
    checkUpdates: 'Check for updates',
    upToDate: 'Up to date',
    installUpdate: 'Install update',
    healthReminder: 'Health note: if you notice any flickering or discomfort, turn the effects off immediately and rest',
    effectsOffWarning: 'Effects are off: the mask is inactive. Use the button to turn them on',
    enableEffects: 'Turn on effects',
    updateDownloading: 'Downloading',
    updateInstalling: 'Updating…',
    preview: 'Mask preview',
    settings: 'Settings',
    spotlight: 'Bubble',
    spotlightDescription: 'Keeps a clear elliptical area around the pointer for browsing and sorting.',
    band: 'Band',
    bandDescription: 'A clear rectangular area with adjustable width and height; its center can offset from the pointer for reading lines, code, or subtitles.',
    radius: 'Clear radius',
    feather: 'Edge feather',
    spotlightScaleX: 'Horizontal stretch',
    spotlightScaleY: 'Vertical stretch',
    blur: 'GPU blur',
    opacity: 'Outer dim',
    smoothing: 'Follow smoothing',
    bandHeight: 'Band height',
    bandWidth: 'Band width',
    offset: 'Offset',
    resetOffset: 'Recenter',
        renderer: 'Renderer',
    nativeBlur: 'Native blur',
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
    canvasFps: 'Canvas FPS',
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
  'ja-JP': {
    running: '実行中',
    healthTitle: '健康と安全に関するお知らせ',
    healthBody: '本ソフトは画面の明るさと明瞭さの分布を継続的に変化させます。使用中にちらつき、目の痛み、頭痛、めまい、視覚異常が生じた場合はすぐに使用を中止し休憩してください。光感受性てんかん・偏頭痛・目の疾患の既往がある方は使用前に医師へ相談してください。',
    healthAck: '了解しました',
    maskOn: '効果オン',
    maskOff: '効果オフ',
    paused: '一時停止',
    language: '言語',
    closeBehavior: '閉じる時',
    minimizeToTray: 'トレイに最小化',
    exitOnClose: '直接終了',
    modes: 'モード',
    intensity: '強度',
    resetDefaults: 'デフォルトに戻す',
    lowMotion: '低ダイナミック',
    strongFocus: '強フォーカス',
    checkUpdates: '更新を確認',
    upToDate: '最新です',
    installUpdate: '更新をインストール',
    healthReminder: '健康に関する注意：ちらつきや不快感を感じたら、すぐに効果をオフにして休憩してください',
    effectsOffWarning: '効果がオフ：マスクが無効です。右のボタンでオンにできます',
    enableEffects: '効果をオン',
    updateDownloading: 'ダウンロード中',
    updateInstalling: '更新中…',
    preview: 'マスクプレビュー',
    settings: '設定',
    spotlight: 'バブル',
    spotlightDescription: 'マウスを中心とした楕円形のクリア領域を保持し、閲覧や資料整理に適しています。',
    band: 'バンド',
    bandDescription: '幅と高さを調整できるクリアな矩形領域。中心はマウスからオフセット可能で、読み行・コード行・字幕に適しています。',
    radius: 'クリア半径',
    feather: 'エッジのフェザー',
    spotlightScaleX: '横方向のストレッチ',
    spotlightScaleY: '縦方向のストレッチ',
    blur: 'GPU ぼかし',
    opacity: '周辺の暗さ',
    smoothing: '追従の滑らかさ',
    bandHeight: 'バンド高さ',
    bandWidth: 'バンド幅',
    offset: 'オフセット',
    resetOffset: '中心へ',
        renderer: 'レンダラー',
    nativeBlur: 'ネイティブぼかし',
    platform: 'プラットフォーム',
    captureExclusion: '自己キャプチャの除外',
    d3d11Device: 'D3D11 デバイス',
    d3d11FeatureLevel: 'D3D 機能レベル',
    windowsGraphicsCapture: 'WGC キャプチャ',
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
    gpuPassthrough: 'パススルー中、マスク・暗化・ぼかしは「実行中」スイッチと強度スライダーに追従します',
    gpuPassthroughStart: 'パススルー開始',
    gpuPassthroughStop: 'パススルー停止',
    passthroughBusy: '切替中…',
    passthroughStatus: 'パススルー状態',
    canvasFps: 'Canvas FPS',
    passthroughFps: 'パススルー FPS',
    passthroughFrames: '累計フレーム数',
    passthroughSize: 'キャプチャサイズ',
    passthroughError: 'パススルーエラー',
    passthroughParams: '適用パラメータ',
    enabledStatus: '有効',
    disabledStatus: '無効',
    browserPreview: 'ブラウザプレビュー',
    browserPipeline: 'Web プレビューはネイティブ GPU パイプラインに接続されません',
    canvasFallback: '現在：CanvasRenderer フォールバック',
  },
  'ko-KR': {
    running: '실행 중',
    healthTitle: '건강 및 안전 알림',
    healthBody: '이 앱은 화면 밝기와 선명도 분포를 지속적으로 변화시킵니다. 사용 중 깜빡임, 눈의 통증, 두통, 어지러움, 시각 이상이 나타나면 즉시 앱을 종료하고 휴식하십시오. 광과민성 간질, 편두통, 안과 질환 병력이 있다면 사용 전 의사와 상담하십시오.',
    healthAck: '확인했습니다',
    maskOn: '효과 켬',
    maskOff: '효과 끔',
    paused: '일시정지',
    language: '언어',
    closeBehavior: '닫을 때',
    minimizeToTray: '트레이로 최소화',
    exitOnClose: '바로 종료',
    modes: '모드',
    intensity: '강도',
    resetDefaults: '기본값 복원',
    lowMotion: '저 다이내믹',
    strongFocus: '강한 포커스',
    checkUpdates: '업데이트 확인',
    upToDate: '최신 버전입니다',
    installUpdate: '업데이트 설치',
    healthReminder: '건강 알림: 깜빡임이나 불편함을 느끼면 즉시 효과를 끄고 휴식하세요',
    effectsOffWarning: '효과 꺼짐: 마스크가 비활성입니다. 오른쪽 버튼으로 켤 수 있습니다',
    enableEffects: '효과 켜기',
    updateDownloading: '다운로드 중',
    updateInstalling: '업데이트 중…',
    preview: '마스크 미리보기',
    settings: '설정',
    spotlight: '버블',
    spotlightDescription: '마우스를 중심으로 타원형 선명 영역을 유지하여 탐색과 자료 정리에 적합합니다.',
    band: '밴드',
    bandDescription: '너비와 높이를 조절할 수 있는 선명한 사각 영역입니다. 중심을 마우스에서 오프셋할 수 있어 읽기 행, 코드 행, 자막에 적합합니다.',
    radius: '선명 반경',
    feather: '가장자리 페더',
    spotlightScaleX: '가로 늘리기',
    spotlightScaleY: '세로 늘리기',
    blur: 'GPU 블러',
    opacity: '주변 어둡기',
    smoothing: '부드러운 따라가기',
    bandHeight: '밴드 높이',
    bandWidth: '밴드 너비',
    offset: '오프셋',
    resetOffset: '중앙으로',
        renderer: '렌더러',
    nativeBlur: '네이티브 블러',
    platform: '플랫폼',
    captureExclusion: '자체 캡처 제외',
    d3d11Device: 'D3D11 디바이스',
    d3d11FeatureLevel: 'D3D 기능 수준',
    windowsGraphicsCapture: 'WGC 캡처',
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
    gpuPassthrough: '패스스루 중 마스크·어둡기·블러는 「실행 중」 스위치와 강도 슬라이더를 따릅니다',
    gpuPassthroughStart: '패스스루 시작',
    gpuPassthroughStop: '패스스루 중지',
    passthroughBusy: '전환 중…',
    passthroughStatus: '패스스루 상태',
    canvasFps: 'Canvas FPS',
    passthroughFps: '패스스루 FPS',
    passthroughFrames: '누적 프레임 수',
    passthroughSize: '캡처 크기',
    passthroughError: '패스스루 오류',
    passthroughParams: '적용된 파라미터',
    enabledStatus: '활성',
    disabledStatus: '비활성',
    browserPreview: '브라우저 미리보기',
    browserPipeline: '웹 미리보기는 네이티브 GPU 파이프라인에 연결되지 않습니다',
    canvasFallback: '현재: CanvasRenderer 폴백',
  },
  'de-DE': {
    running: 'Aktiv',
    healthTitle: 'Hinweis zu Gesundheit und Sicherheit',
    healthBody: 'Diese App verändert die Helligkeits- und Schärfeverteilung des Bildschirms laufend. Treten bei der Nutzung Flackern, Augenschmerzen, Kopfschmerzen, Schwindel oder Sehstörungen auf, beenden Sie die App sofort und pausieren Sie. Bei bekannter photosensitiver Epilepsie, Migräne oder Augenerkrankungen vorher ärztlichen Rat einholen.',
    healthAck: 'Verstanden',
    maskOn: 'Effekte an',
    maskOff: 'Effekte aus',
    paused: 'Pausiert',
    language: 'Sprache',
    closeBehavior: 'Beim Schließen',
    minimizeToTray: 'In Tray minimieren',
    exitOnClose: 'Direkt beenden',
    modes: 'Modi',
    intensity: 'Intensität',
    resetDefaults: 'Standardwerte',
    lowMotion: 'Ruhig',
    strongFocus: 'Starker Fokus',
    checkUpdates: 'Nach Updates suchen',
    upToDate: 'Aktuell',
    installUpdate: 'Update installieren',
    healthReminder: 'Hinweis: Bei Flackern oder Unwohlsein sofort die Effekte deaktivieren und pausieren',
    effectsOffWarning: 'Effekte aus: Die Maske ist inaktiv. Über die Schaltfläche einschalten',
    enableEffects: 'Effekte einschalten',
    updateDownloading: 'Wird geladen',
    updateInstalling: 'Aktualisiere…',
    preview: 'Masken-Vorschau',
    settings: 'Einstellungen',
    spotlight: 'Blase',
    spotlightDescription: 'Hält einen klaren Ellipsenbereich um den Zeiger – ideal zum Stöbern und Sortieren.',
    band: 'Bande',
    bandDescription: 'Ein klarer rechteckiger Bereich mit einstellbarer Breite und Höhe; das Zentrum lässt sich vom Zeiger verschieben – ideal für Lesezeilen, Code und Untertitel.',
    radius: 'Klarer Radius',
    feather: 'Kantenverlauf',
    spotlightScaleX: 'Horizontal strecken',
    spotlightScaleY: 'Vertikal strecken',
    blur: 'GPU-Blur',
    opacity: 'Abdunklung',
    smoothing: 'Folgeglättung',
    bandHeight: 'Bandhöhe',
    bandWidth: 'Bandbreite',
    offset: 'Versatz',
    resetOffset: 'Zentrieren',
    renderer: 'Renderer',
    nativeBlur: 'Natives Blur',
    platform: 'Plattform',
    captureExclusion: 'Eigenaufnahme ausschließen',
    d3d11Device: 'D3D11-Gerät',
    d3d11FeatureLevel: 'D3D-Featurelevel',
    windowsGraphicsCapture: 'WGC-Aufnahme',
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
    gpuPassthrough: 'Im Durchlaufmodus folgen Maske, Abdunklung und Blur dem „Aktiv“-Schalter und den Reglern',
    gpuPassthroughStart: 'Durchlauf starten',
    gpuPassthroughStop: 'Durchlauf stoppen',
    passthroughBusy: 'Wechseln…',
    passthroughStatus: 'Durchlauf',
    canvasFps: 'Canvas-FPS',
    passthroughFps: 'Durchlauf-FPS',
    passthroughFrames: 'Frames gesamt',
    passthroughSize: 'Aufnahmegröße',
    passthroughError: 'Letzter Fehler',
    passthroughParams: 'Aktive Parameter',
    enabledStatus: 'Aktiv',
    disabledStatus: 'Inaktiv',
    browserPreview: 'Browser-Vorschau',
    browserPipeline: 'Die Web-Vorschau ist nicht mit der nativen GPU-Pipeline verbunden',
    canvasFallback: 'Aktuell: CanvasRenderer-Fallback',
  },
  'fr-FR': {
    running: 'Actif',
    healthTitle: 'Avis santé et sécurité',
    healthBody: 'Cette application modifie en continu la répartition de la luminosité et de la netteté de l’écran. En cas de scintillement, de douleur oculaire, de maux de tête, de vertiges ou de troubles visuels, fermez immédiatement l’application et reposez-vous. En cas d’épilepsie photosensible, de migraines ou de troubles oculaires connus, consultez un médecin avant utilisation.',
    healthAck: 'J’ai compris',
    maskOn: 'Effets activés',
    maskOff: 'Effets désactivés',
    paused: 'En pause',
    language: 'Langue',
    closeBehavior: 'À la fermeture',
    minimizeToTray: 'Réduire dans la barre',
    exitOnClose: 'Quitter directement',
    modes: 'Modes',
    intensity: 'Intensité',
    resetDefaults: 'Valeurs par défaut',
    lowMotion: 'Faible mouvement',
    strongFocus: 'Focus intense',
    checkUpdates: 'Rechercher des mises à jour',
    upToDate: 'À jour',
    installUpdate: 'Installer la mise à jour',
    healthReminder: 'Note santé : en cas de scintillement ou de gêne, désactivez immédiatement les effets et reposez-vous',
    effectsOffWarning: 'Effets désactivés : le masque est inactif. Activez-les via le bouton',
    enableEffects: 'Activer les effets',
    updateDownloading: 'Téléchargement',
    updateInstalling: 'Mise à jour…',
    preview: 'Aperçu du masque',
    settings: 'Réglages',
    spotlight: 'Bulle',
    spotlightDescription: 'Garde une zone claire elliptique autour du curseur, idéale pour parcourir et trier.',
    band: 'Bande',
    bandDescription: 'Une zone claire rectangulaire de largeur et hauteur réglables ; son centre peut être décalé par rapport au curseur — idéal pour lignes de lecture, code et sous-titres.',
    radius: 'Rayon net',
    feather: 'Adoucissement',
    spotlightScaleX: 'Étirement horizontal',
    spotlightScaleY: 'Étirement vertical',
    blur: 'Flou GPU',
    opacity: 'Assombrissement',
    smoothing: 'Suivi lissé',
    bandHeight: 'Hauteur de bande',
    bandWidth: 'Largeur de bande',
    offset: 'Décalage',
    resetOffset: 'Recentrer',
        renderer: 'Rendu',
    nativeBlur: 'Flou natif',
    platform: 'Plateforme',
    captureExclusion: 'Exclusion de capture',
    d3d11Device: 'Périphérique D3D11',
    d3d11FeatureLevel: 'Niveau D3D',
    windowsGraphicsCapture: 'Capture WGC',
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
    gpuPassthrough: 'En transparence, le masque suit le bouton « Actif » et les curseurs d’intensité',
    gpuPassthroughStart: 'Démarrer la transparence',
    gpuPassthroughStop: 'Arrêter la transparence',
    passthroughBusy: 'Basculer…',
    passthroughStatus: 'Transparence',
    canvasFps: 'FPS Canvas',
    passthroughFps: 'FPS transparence',
    passthroughFrames: 'Images cumulées',
    passthroughSize: 'Taille de capture',
    passthroughError: 'Dernière erreur',
    passthroughParams: 'Paramètres appliqués',
    enabledStatus: 'Activé',
    disabledStatus: 'Désactivé',
    browserPreview: 'Aperçu navigateur',
    browserPipeline: 'L’aperçu web n’est pas connecté au pipeline GPU natif',
    canvasFallback: 'Actuel : CanvasRenderer (repli)',
  },
  'es-ES': {
    running: 'Activo',
    healthTitle: 'Aviso de salud y seguridad',
    healthBody: 'Esta aplicación modifica de forma continua el brillo y la nitidez de la pantalla. Si percibes parpadeos, dolor ocular, dolor de cabeza, mareos o alteraciones visuales, cierra la aplicación de inmediato y descansa. Si tienes antecedentes de epilepsia fotosensible, migraña o afecciones oculares, consulta a un médico antes de usarla.',
    healthAck: 'Entendido',
    maskOn: 'Efectos activados',
    maskOff: 'Efectos desactivados',
    paused: 'En pausa',
    language: 'Idioma',
    closeBehavior: 'Al cerrar',
    minimizeToTray: 'Minimizar a la bandeja',
    exitOnClose: 'Salir directamente',
    modes: 'Modos',
    intensity: 'Intensidad',
    resetDefaults: 'Valores predeterminados',
    lowMotion: 'Movimiento bajo',
    strongFocus: 'Enfoque fuerte',
    checkUpdates: 'Buscar actualizaciones',
    upToDate: 'Actualizado',
    installUpdate: 'Instalar actualización',
    healthReminder: 'Aviso de salud: ante parpadeos o molestias, desactive los efectos de inmediato y descanse',
    effectsOffWarning: 'Efectos desactivados: la máscara está inactiva. Actívelos con el botón',
    enableEffects: 'Activar efectos',
    updateDownloading: 'Descargando',
    updateInstalling: 'Actualizando…',
    preview: 'Vista previa de máscara',
    settings: 'Ajustes',
    spotlight: 'Burbuja',
    spotlightDescription: 'Mantiene una zona clara elíptica alrededor del puntero, ideal para explorar y organizar.',
    band: 'Banda',
    bandDescription: 'Un área clara rectangular con ancho y alto ajustables; su centro puede desplazarse respecto al puntero, ideal para líneas de lectura, código y subtítulos.',
    radius: 'Radio claro',
    feather: 'Suavizado de borde',
    spotlightScaleX: 'Estiramiento horizontal',
    spotlightScaleY: 'Estiramiento vertical',
    blur: 'Desenfoque GPU',
    opacity: 'Oscurecimiento',
    smoothing: 'Suavidad de seguimiento',
    bandHeight: 'Alto de banda',
    bandWidth: 'Ancho de banda',
    offset: 'Desplazamiento',
    resetOffset: 'Centrar',
        renderer: 'Renderizador',
    nativeBlur: 'Desenfoque nativo',
    platform: 'Plataforma',
    captureExclusion: 'Exclusión de captura',
    d3d11Device: 'Dispositivo D3D11',
    d3d11FeatureLevel: 'Nivel D3D',
    windowsGraphicsCapture: 'Captura WGC',
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
    gpuPassthrough: 'En modo directo, máscara, oscurecimiento y desenfoque siguen el interruptor «Activo» y los controles',
    gpuPassthroughStart: 'Iniciar modo directo',
    gpuPassthroughStop: 'Detener modo directo',
    passthroughBusy: 'Cambiando…',
    passthroughStatus: 'Modo directo',
    canvasFps: 'FPS Canvas',
    passthroughFps: 'FPS modo directo',
    passthroughFrames: 'Fotogramas totales',
    passthroughSize: 'Tamaño de captura',
    passthroughError: 'Último error',
    passthroughParams: 'Parámetros aplicados',
    enabledStatus: 'Activado',
    disabledStatus: 'Desactivado',
    browserPreview: 'Vista previa del navegador',
    browserPipeline: 'La vista previa web no está conectada al pipeline GPU nativo',
    canvasFallback: 'Actual: CanvasRenderer (alternativo)',
  },
} satisfies Record<Language, Record<string, string>>

function loadSettings(): FocusSettings {
  try {
    const saved = localStorage.getItem(storageKey)
    if (!saved) return defaultSettings
    const parsed = JSON.parse(saved) as Record<string, unknown>
    // v0.1 之前为扁平字段：迁移到按模式分离的结构（共享值复制到两个模式）。
    const legacy = parsed as Record<string, number | string | boolean>
    if (typeof legacy.feather === 'number') {
      const feather = legacy.feather
      const blur = typeof legacy.blur === 'number' ? legacy.blur : defaultSettings.spotBlur
      const opacity = typeof legacy.opacity === 'number' ? legacy.opacity : defaultSettings.spotOpacity
      const smoothing = typeof legacy.smoothing === 'number' ? legacy.smoothing : defaultSettings.spotSmoothing
      parsed.spotFeather ??= feather
      parsed.bandFeather ??= feather
      parsed.spotBlur ??= blur
      parsed.bandBlur ??= blur
      parsed.spotOpacity ??= opacity
      parsed.bandOpacity ??= opacity
      parsed.spotSmoothing ??= smoothing
      parsed.bandSmoothing ??= smoothing
    }
    if (typeof legacy.radius === 'number') parsed.spotRadius ??= legacy.radius
    if (typeof legacy.spotlightScaleX === 'number') parsed.spotScaleX ??= legacy.spotlightScaleX
    if (typeof legacy.spotlightScaleY === 'number') parsed.spotScaleY ??= legacy.spotlightScaleY
    if (typeof legacy.offsetX === 'number') parsed.bandOffsetX ??= legacy.offsetX
    if (typeof legacy.offsetY === 'number') parsed.bandOffsetY ??= legacy.offsetY
    if (legacy.mode === 'reading' || legacy.mode === 'code') {
      parsed.mode = 'band'
      if (typeof parsed.bandHeight !== 'number' && typeof legacy.readingHeight === 'number') {
        parsed.bandHeight = (legacy.readingHeight as number) * 2
      }
    }
    delete parsed.radius
    delete parsed.feather
    delete parsed.blur
    delete parsed.opacity
    delete parsed.smoothing
    delete parsed.spotlightScaleX
    delete parsed.spotlightScaleY
    delete parsed.offsetX
    delete parsed.offsetY
    delete parsed.readingHeight
    delete parsed.codeHeight
    return { ...defaultSettings, ...(parsed as Partial<FocusSettings>) }
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
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [checkState, setCheckState] = useState<'checking' | 'idle' | 'up-to-date'>('idle')
  const [downloadProgress, setDownloadProgress] = useState<string | null>(null)
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
        radius: settings.mode === 'spotlight' ? settings.spotRadius : settings.bandWidth / 2,
        feather: settings.mode === 'spotlight' ? settings.spotFeather : settings.bandFeather,
        dim: settings.mode === 'spotlight' ? settings.spotOpacity : settings.bandOpacity,
        blur: settings.mode === 'spotlight' ? settings.spotBlur : settings.bandBlur,
        bandHeight: settings.bandHeight,
        bandWidth: settings.bandWidth,
        offsetX: settings.bandOffsetX,
        offsetY: settings.bandOffsetY,
        spotlightScaleX: settings.spotScaleX,
        spotlightScaleY: settings.spotScaleY,
        smoothing:
          settings.mode === 'spotlight' ? settings.spotSmoothing : settings.bandSmoothing,
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

  // 手动检查更新：发现新版本后出现安装按钮；无更新时按钮短暂显示"已是最新"。
  const checkForUpdates = async () => {
    if (checkState === 'checking' || updateBusy) return

    setCheckState('checking')
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()
      if (update?.available) {
        setUpdateVersion(update.version)
        setCheckState('idle')
      } else {
        setUpdateVersion(null)
        setCheckState('up-to-date')
        window.setTimeout(() => setCheckState('idle'), 2500)
      }
    } catch (error) {
      console.error('update check failed:', error)
      setCheckState('idle')
    }
  }

  // 后台下载 + 自动安装 + 重启；按钮上实时显示下载进度。
  const installUpdate = async () => {
    if (!updateVersion || updateBusy) return

    setUpdateBusy(true)
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()
      if (update?.available) {
        let total = 0
        let downloaded = 0
        await update.downloadAndInstall((event) => {
          if (event.event === 'Started' && event.data.contentLength) {
            total = event.data.contentLength
          } else if (event.event === 'Progress') {
            downloaded += event.data.chunkLength
            if (total > 0) {
              setDownloadProgress(
                `${(downloaded / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB`,
              )
            }
          }
        })
        const { relaunch } = await import('@tauri-apps/plugin-process')
        await relaunch()
      }
    } catch (error) {
      console.error('update install failed:', error)
    } finally {
      setUpdateBusy(false)
      setDownloadProgress(null)
    }
  }

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
              effectsEnabled: false,
              canvasFps: 0,
              nativeBlurRunning: false,
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

  const applyPreset = (preset: Partial<FocusSettings>) => {
    setSettings((current) => ({ ...current, ...preset }))
  }

  const nudgeOffset = (key: 'bandOffsetX' | 'bandOffsetY', delta: number) => {
    setSettings((current) => ({
      ...current,
      [key]: Math.max(-600, Math.min(600, current[key] + delta)),
    }))
  }

  const modeDetails = useMemo(
    () => ({
      spotlight: {
        icon: Crosshair,
        title: t.spotlight,
        description: t.spotlightDescription,
      },
      band: {
        icon: RectangleHorizontal,
        title: t.band,
        description: t.bandDescription,
      },
    }),
    [t],
  )

  return (
    <main className="shell">
      {!settings.warningAcknowledged && (
        <div className="healthNotice">
          <div className="healthCard">
            <h2>{t.healthTitle}</h2>
            <p>{t.healthBody}</p>
            <button
              type="button"
              onClick={() =>
                setSettings((current) => ({ ...current, warningAcknowledged: true }))
              }
            >
              {t.healthAck}
            </button>
          </div>
        </div>
      )}
      <section className="workbench" aria-label="Focus Bubble">
        <header className="topbar">
          <p className="eyebrow">Focus Bubble</p>
          <div className="topActions">
            <button
              type="button"
              className="power"
              onClick={checkForUpdates}
              disabled={checkState === 'checking' || updateBusy}
            >
              <RefreshCw size={16} />
              {checkState === 'checking'
                ? `${t.checkUpdates}…`
                : checkState === 'up-to-date'
                  ? t.upToDate
                  : t.checkUpdates}
            </button>
            {updateVersion && (
              <button
                type="button"
                className="power is-on"
                onClick={installUpdate}
                disabled={updateBusy}
              >
                <RefreshCw size={16} />
                {updateBusy
                  ? downloadProgress
                    ? `${t.updateDownloading} ${downloadProgress}`
                    : t.updateInstalling
                  : `${t.installUpdate} v${updateVersion}`}
              </button>
            )}
            <label className="languageSelect">
              <Globe2 size={17} />
              <span>{t.language}</span>
              <select
                value={settings.language}
                onChange={(event) => update('language', event.target.value as Language)}
              >
                <option value="zh-CN">中文</option>
                <option value="en-US">English</option>
                <option value="ja-JP">日本語</option>
                <option value="ko-KR">한국어</option>
                <option value="de-DE">Deutsch</option>
                <option value="fr-FR">Français</option>
                <option value="es-ES">Español</option>
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
              {settings.enabled ? t.maskOn : t.maskOff}
            </button>
          </div>
        </header>

        <div className="statusWarning health topReminder">
          <span>{t.healthReminder}</span>
        </div>

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
              <button
                type="button"
                className="headerAction"
                onClick={() => applyPreset(lowMotionPreset[settings.mode])}
              >
                {t.lowMotion}
              </button>
              <button
                type="button"
                className="headerAction"
                onClick={() => applyPreset(strongFocusPreset[settings.mode])}
              >
                {t.strongFocus}
              </button>
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
                    value={settings.spotRadius}
                    suffix="px"
                    onChange={(value) => update('spotRadius', value)}
                  />
                  <RangeControl
                    icon={<Crosshair size={17} />}
                    label={t.spotlightScaleX}
                    min={0.3}
                    max={3}
                    step={0.05}
                    value={settings.spotScaleX}
                    suffix=""
                    onChange={(value) => update('spotScaleX', value)}
                  />
                  <RangeControl
                    icon={<Crosshair size={17} />}
                    label={t.spotlightScaleY}
                    min={0.3}
                    max={3}
                    step={0.05}
                    value={settings.spotScaleY}
                    suffix=""
                    onChange={(value) => update('spotScaleY', value)}
                  />
                  <RangeControl
                    icon={<Eye size={17} />}
                    label={t.feather}
                    min={0}
                    max={screenLimits.radiusMax}
                    step={10}
                    value={settings.spotFeather}
                    suffix="px"
                    onChange={(value) => update('spotFeather', value)}
                  />
                  <RangeControl
                    icon={<Eye size={17} />}
                    label={t.blur}
                    min={0}
                    max={28}
                    step={1}
                    value={settings.spotBlur}
                    suffix="px"
                    onChange={(value) => update('spotBlur', value)}
                  />
                  <RangeControl
                    icon={<Gauge size={17} />}
                    label={t.opacity}
                    min={0.18}
                    max={0.82}
                    step={0.02}
                    value={settings.spotOpacity}
                    suffix=""
                    onChange={(value) => update('spotOpacity', value)}
                  />
                  <RangeControl
                    icon={<MousePointer2 size={17} />}
                    label={t.smoothing}
                    min={0.04}
                    max={0.36}
                    step={0.02}
                    value={settings.spotSmoothing}
                    suffix=""
                    onChange={(value) => update('spotSmoothing', value)}
                  />
                </>
              )}

              {settings.mode === 'band' && (
                <>
                  <RangeControl
                    icon={<RectangleHorizontal size={17} />}
                    label={t.bandHeight}
                    min={60}
                    max={screenLimits.heightMax}
                    step={10}
                    value={settings.bandHeight}
                    suffix="px"
                    onChange={(value) => update('bandHeight', value)}
                  />
                  <RangeControl
                    icon={<RectangleHorizontal size={17} />}
                    label={t.bandWidth}
                    min={200}
                    max={screenLimits.widthMax}
                    step={20}
                    value={settings.bandWidth}
                    suffix="px"
                    onChange={(value) => update('bandWidth', value)}
                  />
                  <div className="offsetRemote">
                    <span className="rangeLabel">
                      <MousePointer2 size={17} />
                      {t.offset}
                    </span>
                    <div className="remotePad">
                      <span />
                      <button type="button" onClick={() => nudgeOffset('bandOffsetY', -20)}>
                        <ChevronUp size={15} />
                      </button>
                      <span />
                      <button type="button" onClick={() => nudgeOffset('bandOffsetX', -20)}>
                        <ChevronLeft size={15} />
                      </button>
                      <button
                        type="button"
                        className="remoteReset"
                        title={t.resetOffset}
                        onClick={() => {
                          update('bandOffsetX', 0)
                          update('bandOffsetY', 0)
                        }}
                      >
                        <RotateCcw size={14} />
                      </button>
                      <button type="button" onClick={() => nudgeOffset('bandOffsetX', 20)}>
                        <ChevronRight size={15} />
                      </button>
                      <span />
                      <button type="button" onClick={() => nudgeOffset('bandOffsetY', 20)}>
                        <ChevronDown size={15} />
                      </button>
                      <span />
                    </div>
                    <output>
                      {settings.bandOffsetX >= 0 ? '+' : ''}
                      {Math.round(settings.bandOffsetX)},{' '}
                      {settings.bandOffsetY >= 0 ? '+' : ''}
                      {Math.round(settings.bandOffsetY)}
                    </output>
                  </div>
                  <RangeControl
                    icon={<Eye size={17} />}
                    label={t.feather}
                    min={0}
                    max={screenLimits.radiusMax}
                    step={10}
                    value={settings.bandFeather}
                    suffix="px"
                    onChange={(value) => update('bandFeather', value)}
                  />
                  <RangeControl
                    icon={<Eye size={17} />}
                    label={t.blur}
                    min={0}
                    max={28}
                    step={1}
                    value={settings.bandBlur}
                    suffix="px"
                    onChange={(value) => update('bandBlur', value)}
                  />
                  <RangeControl
                    icon={<Gauge size={17} />}
                    label={t.opacity}
                    min={0.18}
                    max={0.82}
                    step={0.02}
                    value={settings.bandOpacity}
                    suffix=""
                    onChange={(value) => update('bandOpacity', value)}
                  />
                  <RangeControl
                    icon={<MousePointer2 size={17} />}
                    label={t.smoothing}
                    min={0.04}
                    max={0.36}
                    step={0.02}
                    value={settings.bandSmoothing}
                    suffix=""
                    onChange={(value) => update('bandSmoothing', value)}
                  />
                </>
              )}

            </div>

            {gpuStatus && (
              <GpuStatusPanel
                status={gpuStatus}
                labels={t}
                passthroughBusy={passthroughBusy}
                onTogglePassthrough={togglePassthrough}
                onEnableEffects={() => update('enabled', true)}
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
  onEnableEffects,
}: {
  status: GpuPrototypeStatus
  labels: (typeof copy)[Language]
  passthroughBusy: boolean
  onTogglePassthrough: () => void
  onEnableEffects: () => void
}) {
  // 渲染器在跑但效果总开关关闭：给出显眼警告 + 一键开启。
  const effectsInactive =
    (status.gpuRendererRunning || status.nativeBlurRunning) && !status.effectsEnabled
  const healthReminder = (
    <div className='statusWarning health'>
      <span>{labels.healthReminder}</span>
    </div>
  )

  const warning = effectsInactive ? (
    <div className="statusWarning">
      <span>{labels.effectsOffWarning}</span>
      <button type="button" onClick={onEnableEffects}>
        {labels.enableEffects}
      </button>
    </div>
  ) : null
  // 非 Windows 只显示平台与原生渲染器状态；WGC/D3D 探测行仅对 Windows 有意义。
  if (status.platform !== 'windows') {
    return (
      <section className="statusPanel" aria-label={labels.renderer}>
        <div className="groupHeader">
          <Gauge size={18} />
          <span>{labels.renderer}</span>
        </div>
        {healthReminder}
        {warning}
        <dl>
          <div>
            <dt>{labels.platform}</dt>
            <dd>{status.platform}</dd>
          </div>
          {status.platform === 'macos' && (
            <div>
              <dt>{labels.nativeBlur}</dt>
              <dd className={status.nativeBlurRunning ? 'good' : 'muted'}>
                {status.nativeBlurRunning ? labels.enabledStatus : labels.disabledStatus}
              </dd>
            </div>
          )}
          <div>
            <dt>Backend</dt>
            <dd>{status.rendererBackend}</dd>
          </div>
        </dl>
      </section>
    )
  }

  return (
    <section className="statusPanel" aria-label={labels.renderer}>
      <div className="groupHeader">
        <Gauge size={18} />
        <span>{labels.renderer}</span>
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
      </div>
      <p className="passthroughHint">{labels.gpuPassthrough}</p>
      {warning}
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
          <dt>{labels.canvasFps}</dt>
          <dd>{status.canvasFps > 0 ? status.canvasFps : '-'}</dd>
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
    widthMax: Math.max(1600, width * 2),
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
            '--preview-opacity':
              settings.mode === 'spotlight' ? settings.spotOpacity : settings.bandOpacity,
            '--preview-radius': `${settings.spotRadius / 5}px`,
            '--preview-feather': `${(settings.mode === 'spotlight' ? settings.spotFeather : settings.bandFeather) / 5}px`,
            '--preview-rx': `${((settings.spotRadius + settings.spotFeather) / 5) * settings.spotScaleX}px`,
            '--preview-ry': `${((settings.spotRadius + settings.spotFeather) / 5) * settings.spotScaleY}px`,
            '--preview-inner': `${(settings.spotRadius / Math.max(1, settings.spotRadius + settings.spotFeather)) * 100}%`,
            '--preview-blur': `${settings.mode === 'spotlight' ? settings.spotBlur : settings.bandBlur}px`,
            '--band-w': `${settings.bandWidth / 5}px`,
            '--band-h': `${settings.bandHeight / 3}px`,
            '--band-off-x': `${settings.bandOffsetX / 5}px`,
            '--band-off-y': `${settings.bandOffsetY / 5}px`,
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
          // Rust 侧发的是物理像素；Canvas 绘制用 CSS 像素，需除以缩放比。
          const ratio = window.devicePixelRatio || 1
          cursor.current = {
            x: event.payload.x / ratio,
            y: event.payload.y / ratio,
          }
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

    // 视觉舒适度层状态（与 Rust 侧 update_comfort 同一套规则）。
    // 亮度和模糊不随速度调制；几何调制轻微且双重平滑，防止清晰区忽大忽小。
    const comfort = {
      speed: 0,
      ease: 0,
      lastRaw: { ...cursor.current },
      lastTime: performance.now(),
    }
    // Canvas 层 rAF 帧率统计：每秒上报一次给状态面板（对比直通 FPS 用）。
    let fps_frames = 0
    let fps_window = performance.now()

    const draw = () => {
      const { width, height } = canvas.getBoundingClientRect()
      const target = cursor.current
      const current = smooth.current

      // 第一层平滑：速度 EMA（抬升/回落都温和）。
      const now = performance.now()
      const dt = Math.max((now - comfort.lastTime) / 1000, 1 / 240)
      const speed =
        Math.hypot(target.x - comfort.lastRaw.x, target.y - comfort.lastRaw.y) / dt
      const speedAlpha = speed > comfort.speed ? 0.12 : 0.045
      comfort.speed += (speed - comfort.speed) * speedAlpha
      comfort.lastRaw = { ...target }
      comfort.lastTime = now

      // 第二层平滑：ease 因子低通。
      const t = Math.min(comfort.speed / 4000, 1)
      const targetEase = t * t * (3 - 2 * t)
      comfort.ease += (targetEase - comfort.ease) * 0.08
      const ease = comfort.ease

      // 高速时跟随更慢；带状模式纵向减半（按行吸附的感觉）。
      const modeSmoothing =
        settings.mode === 'spotlight' ? settings.spotSmoothing : settings.bandSmoothing
      const tracking = modeSmoothing * (1 - 0.6 * ease)
      current.x += (target.x - current.x) * tracking
      current.y +=
        (target.y - current.y) * (settings.mode === 'spotlight' ? tracking : tracking * 0.5)

      // 速度自适应只作用于几何（轻微）：清晰区最多扩 25%，羽化最多 +140px。
      const modeOpacity = settings.mode === 'spotlight' ? settings.spotOpacity : settings.bandOpacity
      const modeFeather = settings.mode === 'spotlight' ? settings.spotFeather : settings.bandFeather
      const effectiveOpacity = Math.min(modeOpacity, 0.7)
      const effectiveRadius = settings.spotRadius * (1 + 0.25 * ease)
      const effectiveFeather = modeFeather + 140 * ease

      context.clearRect(0, 0, width, height)

      if (settings.enabled) {
        context.save()
        context.fillStyle = `rgba(12, 16, 20, ${effectiveOpacity})`
        context.fillRect(0, 0, width, height)
        context.globalCompositeOperation = 'destination-out'

        if (settings.mode === 'spotlight') {
          // 圆形渐变配 scale 变换得到椭圆：半轴 = radius * scale。
          context.save()
          context.translate(current.x, current.y)
          context.scale(settings.spotScaleX, settings.spotScaleY)
          const gradient = context.createRadialGradient(
            0,
            0,
            Math.max(1, effectiveRadius * 0.62),
            0,
            0,
            effectiveRadius + effectiveFeather,
          )
          gradient.addColorStop(0, 'rgba(0, 0, 0, 1)')
          gradient.addColorStop(0.58, 'rgba(0, 0, 0, 0.92)')
          gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
          context.fillStyle = gradient
          const span = 4000
          context.fillRect(-span, -span, span * 2, span * 2)
          context.restore()
        }

        if (settings.mode === 'band') {
          const comfortScale = 1 + 0.25 * ease
          const bandWidth = settings.bandWidth * comfortScale
          const bandHeight = settings.bandHeight * comfortScale
          const cx = current.x + settings.bandOffsetX
          const cy = current.y + settings.bandOffsetY
          context.save()
          // 与 macOS mask / Windows shader 完全一致的矩形 smoothstep 羽化：
          // 逐圈累积挖洞（destination-out 累积 = 1-Π(1-α)），过渡几何与
          // 模糊层对齐——之前用 blur 滤镜近似导致两层轮廓错位，出现
          // 明显的亮暗边界线。
          const rings = 12
          const targetAt = (j: number) => {
            const t = j / rings
            const s = t * t * (3 - 2 * t)
            return 0.995 * (1 - s) + 0.02 * s
          }
          const alphas: number[] = new Array(rings + 1).fill(0)
          let survivalBelow = 1
          for (let j = rings; j >= 1; j--) {
            const survivalAtJ = 1 - targetAt(j)
            alphas[j] = Math.min(0.9, Math.max(0, 1 - survivalAtJ / survivalBelow))
            survivalBelow *= 1 - alphas[j]
          }
          const traceRoundRect = (grow: number) => {
            const w = bandWidth + grow * 2
            const h = bandHeight + grow * 2
            context.beginPath()
            if (typeof context.roundRect === 'function') {
              context.roundRect(cx - w / 2, cy - h / 2, w, h, h / 2)
            } else {
              context.rect(cx - w / 2, cy - h / 2, w, h)
            }
          }
          for (let j = 1; j <= rings; j++) {
            if (alphas[j] <= 0) continue
            context.fillStyle = `rgba(0, 0, 0, ${alphas[j]})`
            traceRoundRect((effectiveFeather * j) / rings)
            context.fill()
          }
          // 清晰区内部补一次全量挖洞（残留 <1.5%，补齐到 100%）。
          context.fillStyle = 'rgba(0, 0, 0, 1)'
          traceRoundRect(0)
          context.fill()
          context.restore()
        }

        context.restore()
      }

      fps_frames += 1
      if (now - fps_window >= 1000) {
        invoke('report_canvas_fps', { fps: fps_frames }).catch(() => undefined)
        fps_frames = 0
        fps_window = now
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
