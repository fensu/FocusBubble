import {
  BookOpen,
  Code2,
  Crosshair,
  Eye,
  Gauge,
  Globe2,
  MousePointer2,
  Power,
  RefreshCw,
  Settings2,
  SlidersHorizontal,
} from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import './App.css'

type FocusMode = 'spotlight' | 'reading' | 'code'
type Language = 'zh-CN' | 'en-US' | 'ja-JP' | 'ko-KR' | 'de-DE' | 'fr-FR' | 'es-ES'

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

// 视觉舒适度默认值：外围暗度温和（20–35% 区间）、宽羽化、慢跟随。
const defaultSettings: FocusSettings = {
  enabled: true,
  mode: 'spotlight',
  language: 'zh-CN',
  radius: 250,
  feather: 180,
  blur: 10,
  opacity: 0.3,
  smoothing: 0.14,
  readingHeight: 260,
  codeHeight: 110,
  spotlightScaleX: 1,
  spotlightScaleY: 1,
  closeToTray: true,
}

// 低动态模式：弱暗化 + 大羽化 + 慢跟随。
const lowMotionPreset: Partial<FocusSettings> = {
  radius: 300,
  feather: 280,
  blur: 12,
  opacity: 0.2,
  smoothing: 0.08,
}

// 强聚焦模式：更明显的遮罩对比，适合高干扰环境短时使用。
const strongFocusPreset: Partial<FocusSettings> = {
  radius: 220,
  feather: 120,
  blur: 16,
  opacity: 0.55,
  smoothing: 0.22,
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
    lowMotion: '低动态',
    strongFocus: '强聚焦',
    checkUpdates: '检查更新',
    upToDate: '已是最新',
    installUpdate: '安装更新',
    updateDownloading: '下载中',
    updateInstalling: '正在更新…',
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
    lowMotion: 'Low motion',
    strongFocus: 'Strong focus',
    checkUpdates: 'Check for updates',
    upToDate: 'Up to date',
    installUpdate: 'Install update',
    updateDownloading: 'Downloading',
    updateInstalling: 'Updating…',
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
  'ja-JP': {
    running: '実行中',
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
    updateDownloading: 'ダウンロード中',
    updateInstalling: '更新中…',
    preview: 'マスクプレビュー',
    settings: '設定',
    spotlight: 'バブル',
    spotlightDescription: 'マウスを中心とした楕円形のクリア領域を保持し、閲覧や資料整理に適しています。',
    reading: 'リーディング',
    readingDescription: 'クリア領域を横長の帯にして、段落の上下の干渉を減らします。',
    code: 'コード',
    codeDescription: 'より狭い行レベルの領域を保持し、コード・ログ・表の追読みに適しています。',
    radius: 'クリア半径',
    feather: 'エッジのフェザー',
    spotlightScaleX: '横方向のストレッチ',
    spotlightScaleY: '縦方向のストレッチ',
    blur: 'GPU ぼかし',
    opacity: '周辺の暗さ',
    smoothing: '追従の滑らかさ',
    readingHeight: 'リーディング帯の高さ',
    codeHeight: 'コード行の高さ',
    renderer: 'レンダラー',
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
    updateDownloading: '다운로드 중',
    updateInstalling: '업데이트 중…',
    preview: '마스크 미리보기',
    settings: '설정',
    spotlight: '버블',
    spotlightDescription: '마우스를 중심으로 타원형 선명 영역을 유지하여 탐색과 자료 정리에 적합합니다.',
    reading: '리딩',
    readingDescription: '선명 영역을 가로로 길게 늘여 단락 위아래의 방해를 줄입니다.',
    code: '코드',
    codeDescription: '더 좁은 행 단위 영역을 유지하여 코드, 로그, 표를 따라 읽기에 적합합니다.',
    radius: '선명 반경',
    feather: '가장자리 페더',
    spotlightScaleX: '가로 늘리기',
    spotlightScaleY: '세로 늘리기',
    blur: 'GPU 블러',
    opacity: '주변 어둡기',
    smoothing: '부드러운 따라가기',
    readingHeight: '리딩 밴드 높이',
    codeHeight: '코드 행 높이',
    renderer: '렌더러',
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
    updateDownloading: 'Wird geladen',
    updateInstalling: 'Aktualisiere…',
    preview: 'Masken-Vorschau',
    settings: 'Einstellungen',
    spotlight: 'Blase',
    spotlightDescription: 'Hält einen klaren Ellipsenbereich um den Zeiger – ideal zum Stöbern und Sortieren.',
    reading: 'Lesen',
    readingDescription: 'Zieht den klaren Bereich in ein horizontales Band und reduziert Ablenkungen über und unter dem Text.',
    code: 'Code',
    codeDescription: 'Hält ein schmales zeilenweises Band für Code, Logs und Tabellen.',
    radius: 'Klarer Radius',
    feather: 'Kantenverlauf',
    spotlightScaleX: 'Horizontal strecken',
    spotlightScaleY: 'Vertikal strecken',
    blur: 'GPU-Blur',
    opacity: 'Abdunklung',
    smoothing: 'Folgeglättung',
    readingHeight: 'Leseband',
    codeHeight: 'Codezeile',
    renderer: 'Renderer',
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
    updateDownloading: 'Téléchargement',
    updateInstalling: 'Mise à jour…',
    preview: 'Aperçu du masque',
    settings: 'Réglages',
    spotlight: 'Bulle',
    spotlightDescription: 'Garde une zone claire elliptique autour du curseur, idéale pour parcourir et trier.',
    reading: 'Lecture',
    readingDescription: 'Étire la zone claire en bandeau horizontal pour réduire les distractions autour du texte.',
    code: 'Code',
    codeDescription: 'Garde un bandeau étroit au niveau de la ligne pour le code, les logs et les tableaux.',
    radius: 'Rayon net',
    feather: 'Adoucissement',
    spotlightScaleX: 'Étirement horizontal',
    spotlightScaleY: 'Étirement vertical',
    blur: 'Flou GPU',
    opacity: 'Assombrissement',
    smoothing: 'Suivi lissé',
    readingHeight: 'Bandeau de lecture',
    codeHeight: 'Ligne de code',
    renderer: 'Rendu',
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
    updateDownloading: 'Descargando',
    updateInstalling: 'Actualizando…',
    preview: 'Vista previa de máscara',
    settings: 'Ajustes',
    spotlight: 'Burbuja',
    spotlightDescription: 'Mantiene una zona clara elíptica alrededor del puntero, ideal para explorar y organizar.',
    reading: 'Lectura',
    readingDescription: 'Convierte la zona clara en una banda horizontal para reducir distracciones arriba y abajo del texto.',
    code: 'Código',
    codeDescription: 'Mantiene una banda estrecha a nivel de línea para código, registros y tablas.',
    radius: 'Radio claro',
    feather: 'Suavizado de borde',
    spotlightScaleX: 'Estiramiento horizontal',
    spotlightScaleY: 'Estiramiento vertical',
    blur: 'Desenfoque GPU',
    opacity: 'Oscurecimiento',
    smoothing: 'Suavidad de seguimiento',
    readingHeight: 'Banda de lectura',
    codeHeight: 'Línea de código',
    renderer: 'Renderizador',
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
        radius: settings.radius,
        feather: settings.feather,
        dim: settings.opacity,
        blur: settings.blur,
        bandHeight:
          settings.mode === 'reading' ? settings.readingHeight : settings.codeHeight,
        spotlightScaleX: settings.spotlightScaleX,
        spotlightScaleY: settings.spotlightScaleY,
        smoothing: settings.smoothing,
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
              <button
                type="button"
                className="headerAction"
                onClick={() => applyPreset(lowMotionPreset)}
              >
                {t.lowMotion}
              </button>
              <button
                type="button"
                className="headerAction"
                onClick={() => applyPreset(strongFocusPreset)}
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
      const tracking = settings.smoothing * (1 - 0.6 * ease)
      current.x += (target.x - current.x) * tracking
      current.y +=
        (target.y - current.y) * (settings.mode === 'spotlight' ? tracking : tracking * 0.5)

      // 速度自适应只作用于几何（轻微）：清晰区最多扩 25%，羽化最多 +140px。
      const effectiveOpacity = Math.min(settings.opacity, 0.7)
      const effectiveRadius = settings.radius * (1 + 0.25 * ease)
      const effectiveFeather = settings.feather + 140 * ease

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
          context.scale(settings.spotlightScaleX, settings.spotlightScaleY)
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

        if (settings.mode === 'reading' || settings.mode === 'code') {
          const bandBase = settings.mode === 'reading' ? settings.readingHeight : settings.codeHeight
          const bandHeight = bandBase * (1 + 0.25 * ease)
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
