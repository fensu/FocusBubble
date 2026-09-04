use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::WebviewWindow;
use windows::{
    core::{factory, Interface, PCSTR},
    Graphics::{
        Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession},
        DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
        SizeInt32,
    },
    Win32::{
        Foundation::{HMODULE, HWND, POINT},
        Graphics::{
            Direct3D::{
                D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_11_0,
                D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST, ID3DBlob,
            },
            Direct3D::Fxc::D3DCompile,
            Direct3D11::{
                D3D11CreateDevice, ID3D11Buffer, ID3D11Device, ID3D11DeviceContext,
                ID3D11PixelShader, ID3D11RenderTargetView, ID3D11SamplerState,
                ID3D11ShaderResourceView, ID3D11Texture2D, ID3D11VertexShader,
                D3D11_BIND_CONSTANT_BUFFER, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
                D3D11_BUFFER_DESC, D3D11_COMPARISON_NEVER, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                D3D11_FILTER_MIN_MAG_MIP_LINEAR, D3D11_SAMPLER_DESC, D3D11_SDK_VERSION,
                D3D11_SUBRESOURCE_DATA, D3D11_TEXTURE2D_DESC, D3D11_TEXTURE_ADDRESS_CLAMP,
                D3D11_USAGE_DEFAULT, D3D11_VIEWPORT,
            },
            DirectComposition::{
                DCompositionCreateDevice, IDCompositionDevice, IDCompositionTarget,
                IDCompositionVisual,
            },
            Dxgi::{
                Common::{
                    DXGI_ALPHA_MODE_PREMULTIPLIED, DXGI_FORMAT_B8G8R8A8_UNORM,
                    DXGI_SAMPLE_DESC,
                },
                CreateDXGIFactory2, IDXGIDevice, IDXGIFactory2, IDXGIOutput, IDXGISwapChain1,
                DXGI_CREATE_FACTORY_FLAGS, DXGI_PRESENT, DXGI_SCALING_STRETCH,
                DXGI_SWAP_CHAIN_DESC1, DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
                DXGI_USAGE_RENDER_TARGET_OUTPUT,
            },
            Gdi::{
                GetMonitorInfoW, MonitorFromWindow, HMONITOR, MONITORINFO,
                MONITOR_DEFAULTTONEAREST,
            },
        },
        System::{
            Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
            WinRT::{
                Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess},
                Graphics::Capture::IGraphicsCaptureItemInterop,
            },
        },
        UI::WindowsAndMessaging::{GetCursorPos, SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE},
    },
};

use crate::renderer::GpuRendererParams;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsGpuPrototypeStatus {
    pub platform: &'static str,
    pub overlay_excluded_from_capture: bool,
    pub d3d11_device_available: bool,
    pub d3d11_feature_level: Option<String>,
    pub windows_graphics_capture_supported: bool,
    pub capture_item_created: bool,
    pub frame_pool_created: bool,
    pub first_frame_received: bool,
    pub frame_surface_available: bool,
    pub captured_frame_size: Option<String>,
    pub composition_swapchain_created: bool,
    pub direct_composition_target_created: bool,
    pub swapchain_backbuffer_presented: bool,
    pub direct_composition_committed: bool,
    pub capture_texture_available: bool,
    pub capture_texture_size: Option<String>,
    pub captured_frame_copied_to_swapchain: bool,
    pub gpu_renderer_initialized: bool,
    pub gpu_renderer_running: bool,
    pub gpu_renderer_frames_presented: u64,
    pub gpu_renderer_fps: u64,
    pub gpu_renderer_capture_size: Option<String>,
    pub gpu_renderer_last_error: Option<String>,
    pub gpu_renderer_params: Option<String>,
    pub gpu_capture_pipeline: &'static str,
    pub renderer_backend: &'static str,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuRendererSnapshot {
    pub gpu_renderer_initialized: bool,
    pub gpu_renderer_running: bool,
    pub gpu_renderer_frames_presented: u64,
    pub gpu_renderer_fps: u64,
    pub gpu_renderer_capture_size: Option<String>,
    pub gpu_renderer_last_error: Option<String>,
    pub gpu_renderer_params: Option<String>,
}

pub fn exclude_overlay_from_capture(window: &WebviewWindow) -> Result<(), String> {
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("failed to obtain overlay HWND: {error}"))?;

    unsafe {
        SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE).map_err(|error| {
            format!("SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) failed: {error}")
        })?;
    }

    Ok(())
}

pub fn probe_d3d11_device() -> Result<String, String> {
    let (_, _, selected_feature_level) = create_d3d11_device()?;
    Ok(format!("{:?}", selected_feature_level))
}

fn create_d3d11_device() -> Result<(ID3D11Device, ID3D11DeviceContext, D3D_FEATURE_LEVEL), String> {
    let feature_levels = [D3D_FEATURE_LEVEL_11_0];
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;
    let mut selected_feature_level = D3D_FEATURE_LEVEL(0);

    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&feature_levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            Some(&mut selected_feature_level),
            Some(&mut context),
        )
        .map_err(|error| format!("D3D11CreateDevice failed: {error}"))?;
    }

    let device = device.ok_or("D3D11CreateDevice returned no device".to_string())?;
    let context = context.ok_or("D3D11CreateDevice returned no immediate context".to_string())?;

    Ok((device, context, selected_feature_level))
}

pub fn probe_windows_graphics_capture() -> Result<bool, String> {
    GraphicsCaptureSession::IsSupported()
        .map_err(|error| format!("GraphicsCaptureSession::IsSupported failed: {error}"))
}

pub fn probe_composition_output(
    window: &WebviewWindow,
) -> Result<(bool, bool, bool, bool), String> {
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("failed to obtain overlay HWND for DirectComposition: {error}"))?;
    let size = window
        .inner_size()
        .map_err(|error| format!("failed to obtain overlay size: {error}"))?;
    let width = size.width.max(1);
    let height = size.height.max(1);

    let (device, context, _) = create_d3d11_device()?;
    let dxgi_device = device
        .cast::<IDXGIDevice>()
        .map_err(|error| format!("failed to cast ID3D11Device to IDXGIDevice: {error}"))?;

    let composition_device: IDCompositionDevice = unsafe { DCompositionCreateDevice(&dxgi_device) }
        .map_err(|error| format!("DCompositionCreateDevice failed: {error}"))?;

    let target: IDCompositionTarget = unsafe { composition_device.CreateTargetForHwnd(hwnd, true) }
        .map_err(|error| format!("IDCompositionDevice::CreateTargetForHwnd failed: {error}"))?;

    let factory: IDXGIFactory2 = unsafe { CreateDXGIFactory2(DXGI_CREATE_FACTORY_FLAGS(0)) }
        .map_err(|error| format!("CreateDXGIFactory2 failed: {error}"))?;
    let desc = DXGI_SWAP_CHAIN_DESC1 {
        Width: width,
        Height: height,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        Stereo: false.into(),
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
        BufferCount: 2,
        Scaling: DXGI_SCALING_STRETCH,
        SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
        AlphaMode: DXGI_ALPHA_MODE_PREMULTIPLIED,
        Flags: 0,
    };

    let swapchain: IDXGISwapChain1 =
        unsafe { factory.CreateSwapChainForComposition(&device, &desc, None::<&IDXGIOutput>) }
            .map_err(|error| format!("CreateSwapChainForComposition failed: {error}"))?;

    clear_and_present_transparent_backbuffer(&device, &context, &swapchain)?;

    let visual = unsafe { composition_device.CreateVisual() }
        .map_err(|error| format!("IDCompositionDevice::CreateVisual failed: {error}"))?;
    unsafe {
        visual
            .SetContent(&swapchain)
            .map_err(|error| format!("IDCompositionVisual::SetContent failed: {error}"))?;
        target
            .SetRoot(&visual)
            .map_err(|error| format!("IDCompositionTarget::SetRoot failed: {error}"))?;
        composition_device
            .Commit()
            .map_err(|error| format!("IDCompositionDevice::Commit failed: {error}"))?;
    }

    Ok((true, true, true, true))
}

pub fn probe_capture_texture_to_composition(
    window: &WebviewWindow,
) -> Result<(bool, Option<String>, bool), String> {
    let hwnd = window.hwnd().map_err(|error| {
        format!("failed to obtain overlay HWND for capture texture probe: {error}")
    })?;
    let (device, context, _) = create_d3d11_device()?;
    let (item, frame_pool, capture_size) = create_capture_objects_for_device(window, &device)?;
    let session = frame_pool
        .CreateCaptureSession(&item)
        .map_err(|error| format!("CreateCaptureSession failed: {error}"))?;

    session
        .StartCapture()
        .map_err(|error| format!("GraphicsCaptureSession::StartCapture failed: {error}"))?;

    let frame = wait_for_next_frame(&frame_pool, Duration::from_millis(900))?;
    let surface = frame
        .Surface()
        .map_err(|error| format!("Direct3D11CaptureFrame::Surface failed: {error}"))?;
    let access = surface
        .cast::<IDirect3DDxgiInterfaceAccess>()
        .map_err(|error| {
            format!("failed to cast IDirect3DSurface to IDirect3DDxgiInterfaceAccess: {error}")
        })?;
    let capture_texture: ID3D11Texture2D = unsafe { access.GetInterface() }.map_err(|error| {
        format!("IDirect3DDxgiInterfaceAccess::GetInterface<ID3D11Texture2D> failed: {error}")
    })?;
    let texture_size = describe_texture_size(&capture_texture);

    let (composition_device, target, swapchain, backbuffer) =
        create_composition_swapchain_for_hwnd(
            hwnd,
            &device,
            capture_size.Width as u32,
            capture_size.Height as u32,
        )?;

    unsafe {
        context.CopyResource(&backbuffer, &capture_texture);
        let visual = composition_device
            .CreateVisual()
            .map_err(|error| format!("IDCompositionDevice::CreateVisual failed: {error}"))?;
        visual
            .SetContent(&swapchain)
            .map_err(|error| format!("IDCompositionVisual::SetContent failed: {error}"))?;
        target
            .SetRoot(&visual)
            .map_err(|error| format!("IDCompositionTarget::SetRoot failed: {error}"))?;
        swapchain
            .Present(1, DXGI_PRESENT(0))
            .ok()
            .map_err(|error| {
                format!("IDXGISwapChain1::Present copied capture frame failed: {error}")
            })?;
        composition_device.Commit().map_err(|error| {
            format!("IDCompositionDevice::Commit copied capture frame failed: {error}")
        })?;
    }

    Ok((true, texture_size, true))
}

fn clear_and_present_transparent_backbuffer(
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    swapchain: &IDXGISwapChain1,
) -> Result<(), String> {
    let backbuffer: ID3D11Texture2D = unsafe { swapchain.GetBuffer(0) }
        .map_err(|error| format!("IDXGISwapChain1::GetBuffer failed: {error}"))?;
    let mut render_target_view: Option<ID3D11RenderTargetView> = None;

    unsafe {
        device
            .CreateRenderTargetView(&backbuffer, None, Some(&mut render_target_view))
            .map_err(|error| format!("ID3D11Device::CreateRenderTargetView failed: {error}"))?;

        let render_target_view = render_target_view
            .ok_or("CreateRenderTargetView returned no render target view".to_string())?;
        context.ClearRenderTargetView(&render_target_view, &[0.0, 0.0, 0.0, 0.0]);
        swapchain
            .Present(1, DXGI_PRESENT(0))
            .ok()
            .map_err(|error| format!("IDXGISwapChain1::Present failed: {error}"))?;
    }

    Ok(())
}

fn create_composition_swapchain_for_hwnd(
    hwnd: windows::Win32::Foundation::HWND,
    device: &ID3D11Device,
    width: u32,
    height: u32,
) -> Result<
    (
        IDCompositionDevice,
        IDCompositionTarget,
        IDXGISwapChain1,
        ID3D11Texture2D,
    ),
    String,
> {
    let dxgi_device = device
        .cast::<IDXGIDevice>()
        .map_err(|error| format!("failed to cast ID3D11Device to IDXGIDevice: {error}"))?;
    let composition_device: IDCompositionDevice = unsafe { DCompositionCreateDevice(&dxgi_device) }
        .map_err(|error| format!("DCompositionCreateDevice failed: {error}"))?;
    let target: IDCompositionTarget = unsafe { composition_device.CreateTargetForHwnd(hwnd, true) }
        .map_err(|error| format!("IDCompositionDevice::CreateTargetForHwnd failed: {error}"))?;
    let factory: IDXGIFactory2 = unsafe { CreateDXGIFactory2(DXGI_CREATE_FACTORY_FLAGS(0)) }
        .map_err(|error| format!("CreateDXGIFactory2 failed: {error}"))?;
    let desc = DXGI_SWAP_CHAIN_DESC1 {
        Width: width.max(1),
        Height: height.max(1),
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        Stereo: false.into(),
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
        BufferCount: 2,
        Scaling: DXGI_SCALING_STRETCH,
        SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
        AlphaMode: DXGI_ALPHA_MODE_PREMULTIPLIED,
        Flags: 0,
    };
    let swapchain: IDXGISwapChain1 =
        unsafe { factory.CreateSwapChainForComposition(device, &desc, None::<&IDXGIOutput>) }
            .map_err(|error| format!("CreateSwapChainForComposition failed: {error}"))?;
    let backbuffer: ID3D11Texture2D = unsafe { swapchain.GetBuffer(0) }
        .map_err(|error| format!("IDXGISwapChain1::GetBuffer failed: {error}"))?;

    Ok((composition_device, target, swapchain, backbuffer))
}

pub fn probe_capture_frame_pool(window: &WebviewWindow) -> Result<(bool, bool), String> {
    let (_, _, _) = create_capture_objects(window)?;
    Ok((true, true))
}

pub fn probe_first_capture_frame(
    window: &WebviewWindow,
) -> Result<(bool, bool, Option<String>), String> {
    let (item, frame_pool, _) = create_capture_objects(window)?;
    let session = frame_pool
        .CreateCaptureSession(&item)
        .map_err(|error| format!("CreateCaptureSession failed: {error}"))?;

    session
        .StartCapture()
        .map_err(|error| format!("GraphicsCaptureSession::StartCapture failed: {error}"))?;

    let frame = wait_for_next_frame(&frame_pool, Duration::from_millis(900))?;
    let surface_available = frame.Surface().is_ok();
    let size = frame
        .ContentSize()
        .ok()
        .map(|size| format!("{}x{}", size.Width, size.Height));
    Ok((true, surface_available, size))
}

fn wait_for_next_frame(
    frame_pool: &Direct3D11CaptureFramePool,
    timeout: Duration,
) -> Result<windows::Graphics::Capture::Direct3D11CaptureFrame, String> {
    let deadline = Instant::now() + timeout;
    let mut last_error = None;

    while Instant::now() < deadline {
        match frame_pool.TryGetNextFrame() {
            Ok(frame) => return Ok(frame),
            Err(error) => {
                last_error = Some(error.to_string());
                thread::sleep(Duration::from_millis(16));
            }
        }
    }

    Err(format!(
        "timed out waiting for first capture frame{}",
        last_error
            .map(|error| format!("; last TryGetNextFrame error: {error}"))
            .unwrap_or_default()
    ))
}

fn create_capture_objects(
    window: &WebviewWindow,
) -> Result<(GraphicsCaptureItem, Direct3D11CaptureFramePool, SizeInt32), String> {
    let (device, _, _) = create_d3d11_device()?;
    create_capture_objects_for_device(window, &device)
}

fn create_capture_objects_for_device(
    window: &WebviewWindow,
    device: &ID3D11Device,
) -> Result<(GraphicsCaptureItem, Direct3D11CaptureFramePool, SizeInt32), String> {
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("failed to obtain overlay HWND for capture probe: {error}"))?;
    let hmonitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    create_capture_objects_for_monitor(hmonitor, device)
}

fn create_capture_objects_for_monitor(
    hmonitor: HMONITOR,
    device: &ID3D11Device,
) -> Result<(GraphicsCaptureItem, Direct3D11CaptureFramePool, SizeInt32), String> {
    let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
        .map_err(|error| format!("failed to get IGraphicsCaptureItemInterop factory: {error}"))?;

    let item = unsafe { interop.CreateForMonitor::<GraphicsCaptureItem>(hmonitor) }
        .map_err(|error| format!("CreateForMonitor failed: {error}"))?;

    let size = item
        .Size()
        .map_err(|error| format!("GraphicsCaptureItem::Size failed: {error}"))?;

    let dxgi_device = device
        .cast::<IDXGIDevice>()
        .map_err(|error| format!("failed to cast ID3D11Device to IDXGIDevice: {error}"))?;

    let inspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device) }
        .map_err(|error| format!("CreateDirect3D11DeviceFromDXGIDevice failed: {error}"))?;
    let direct3d_device = inspectable
        .cast::<IDirect3DDevice>()
        .map_err(|error| format!("failed to cast WinRT inspectable to IDirect3DDevice: {error}"))?;

    let capture_size = SizeInt32 {
        Width: size.Width.max(1),
        Height: size.Height.max(1),
    };

    let frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &direct3d_device,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        2,
        capture_size,
    )
    .map_err(|error| format!("Direct3D11CaptureFramePool::CreateFreeThreaded failed: {error}"))?;

    Ok((item, frame_pool, capture_size))
}

fn describe_texture_size(texture: &ID3D11Texture2D) -> Option<String> {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe {
        texture.GetDesc(&mut desc);
    }
    Some(format!("{}x{}", desc.Width, desc.Height))
}

pub fn gpu_prototype_status(
    overlay_excluded_from_capture: bool,
    d3d11_device_available: bool,
    d3d11_feature_level: Option<String>,
    windows_graphics_capture_supported: bool,
    capture_item_created: bool,
    frame_pool_created: bool,
    first_frame_received: bool,
    frame_surface_available: bool,
    captured_frame_size: Option<String>,
    composition_swapchain_created: bool,
    direct_composition_target_created: bool,
    swapchain_backbuffer_presented: bool,
    direct_composition_committed: bool,
    capture_texture_available: bool,
    capture_texture_size: Option<String>,
    captured_frame_copied_to_swapchain: bool,
    renderer: GpuRendererSnapshot,
) -> WindowsGpuPrototypeStatus {
    WindowsGpuPrototypeStatus {
        platform: "windows",
        overlay_excluded_from_capture,
        d3d11_device_available,
        d3d11_feature_level,
        windows_graphics_capture_supported,
        capture_item_created,
        frame_pool_created,
        first_frame_received,
        frame_surface_available,
        captured_frame_size,
        composition_swapchain_created,
        direct_composition_target_created,
        swapchain_backbuffer_presented,
        direct_composition_committed,
        capture_texture_available,
        capture_texture_size,
        captured_frame_copied_to_swapchain,
        gpu_renderer_initialized: renderer.gpu_renderer_initialized,
        gpu_renderer_running: renderer.gpu_renderer_running,
        gpu_renderer_frames_presented: renderer.gpu_renderer_frames_presented,
        gpu_renderer_fps: renderer.gpu_renderer_fps,
        gpu_renderer_capture_size: renderer.gpu_renderer_capture_size,
        gpu_renderer_last_error: renderer.gpu_renderer_last_error,
        gpu_renderer_params: renderer.gpu_renderer_params,
        gpu_capture_pipeline: if renderer.gpu_renderer_running {
            "stage B/C/D live: capture -> 1/4 downsample -> blur H/V -> mask+dim composite -> DComp"
        } else {
            "shader pipeline ready (blur/mask/dim); start passthrough from control panel"
        },
        renderer_backend: if renderer.gpu_renderer_initialized {
            "WindowsGpuRenderer shader pipeline (CanvasRenderer fallback idle)"
        } else {
            "current: CanvasRenderer fallback; WindowsGpuRenderer shader pipeline ready"
        },
    }
}

// ---------------------------------------------------------------------------
// 阶段 A：WindowsGpuRenderer 持续直通渲染
//
// render thread 内完成全部对象的创建与销毁（D3D/WGC/DComp COM 对象不跨线程），
// 主线程只持有 stop flag、线程句柄和一份原子状态快照。
// ---------------------------------------------------------------------------

#[derive(Default)]
struct GpuRendererSharedState {
    initialized: AtomicBool,
    running: AtomicBool,
    frames_presented: AtomicU64,
    fps: AtomicU64,
    capture_size: Mutex<Option<String>>,
    last_error: Mutex<Option<String>>,
    /// 最近一帧实际使用的 shader 参数（换算成物理像素后），用于诊断参数链路。
    applied_params: Mutex<Option<String>>,
}

struct SendHwnd(HWND);
unsafe impl Send for SendHwnd {}

struct SendHMonitor(HMONITOR);
unsafe impl Send for SendHMonitor {}

pub struct GpuRenderer {
    stop_flag: Arc<AtomicBool>,
    status: Arc<GpuRendererSharedState>,
    join: Option<thread::JoinHandle<()>>,
}

impl GpuRenderer {
    pub fn start(
        window: &WebviewWindow,
        params: Arc<Mutex<GpuRendererParams>>,
    ) -> Result<Self, String> {
        let hwnd = window
            .hwnd()
            .map_err(|error| format!("failed to obtain overlay HWND for GPU renderer: {error}"))?;
        let hmonitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };

        let stop_flag = Arc::new(AtomicBool::new(false));
        let status = Arc::new(GpuRendererSharedState::default());
        let (init_tx, init_rx) = mpsc::channel::<Result<(), String>>();

        let thread_stop = Arc::clone(&stop_flag);
        let thread_status = Arc::clone(&status);
        let thread_hwnd = SendHwnd(hwnd);
        let thread_hmonitor = SendHMonitor(hmonitor);

        let join = thread::Builder::new()
            .name("focus-bubble-gpu-renderer".to_string())
            .spawn(move || {
                let co_initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).is_ok() };

                run_capture_display_loop(
                    thread_hwnd,
                    thread_hmonitor,
                    &thread_stop,
                    &thread_status,
                    &params,
                    &init_tx,
                );

                if co_initialized {
                    unsafe { CoUninitialize() };
                }
            })
            .map_err(|error| format!("failed to spawn GPU renderer thread: {error}"))?;

        match init_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(())) => Ok(Self {
                stop_flag,
                status,
                join: Some(join),
            }),
            Ok(Err(error)) => {
                let _ = join.join();
                Err(error)
            }
            Err(_) => {
                stop_flag.store(true, Ordering::Relaxed);
                let _ = join.join();
                Err("GPU renderer initialization timed out".to_string())
            }
        }
    }

    pub fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }

    pub fn is_alive(&self) -> bool {
        self.join
            .as_ref()
            .map(|join| !join.is_finished())
            .unwrap_or(false)
    }

    pub fn snapshot(&self) -> GpuRendererSnapshot {
        GpuRendererSnapshot {
            gpu_renderer_initialized: self.status.initialized.load(Ordering::Relaxed),
            gpu_renderer_running: self.status.running.load(Ordering::Relaxed),
            gpu_renderer_frames_presented: self.status.frames_presented.load(Ordering::Relaxed),
            gpu_renderer_fps: self.status.fps.load(Ordering::Relaxed),
            gpu_renderer_capture_size: self
                .status
                .capture_size
                .lock()
                .ok()
                .and_then(|capture_size| capture_size.clone()),
            gpu_renderer_last_error: self
                .status
                .last_error
                .lock()
                .ok()
                .and_then(|last_error| last_error.clone()),
            gpu_renderer_params: self
                .status
                .applied_params
                .lock()
                .ok()
                .and_then(|applied_params| applied_params.clone()),
        }
    }
}

impl Drop for GpuRenderer {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run_capture_display_loop(
    hwnd: SendHwnd,
    hmonitor: SendHMonitor,
    stop_flag: &AtomicBool,
    status: &GpuRendererSharedState,
    params: &Mutex<GpuRendererParams>,
    init_tx: &mpsc::Sender<Result<(), String>>,
) {
    let objects = match build_capture_display_objects(hwnd.0, hmonitor.0) {
        Ok(objects) => objects,
        Err(error) => {
            if let Ok(mut last_error) = status.last_error.lock() {
                *last_error = Some(error.clone());
            }
            let _ = init_tx.send(Err(error));
            return;
        }
    };

    status.initialized.store(true, Ordering::Relaxed);
    if let Ok(mut capture_size) = status.capture_size.lock() {
        *capture_size = Some(format!(
            "{}x{}",
            objects.capture_width, objects.capture_height
        ));
    }
    let _ = init_tx.send(Ok(()));

    status.running.store(true, Ordering::Relaxed);
    let mut frames_presented: u64 = 0;
    let mut second_frames: u64 = 0;
    let mut second_start = Instant::now();
    let mut comfort = crate::renderer::ComfortState::new();
    let mut comfort_tick = Instant::now();

    let loop_error: Option<String> = loop {
        if stop_flag.load(Ordering::Relaxed) {
            break None;
        }

        // 统计每秒真实 presented 帧率；WGC 静止桌面时不产帧，也要推进秒窗口。
        if second_start.elapsed() >= Duration::from_secs(1) {
            status.fps.store(second_frames, Ordering::Relaxed);
            second_frames = 0;
            second_start = Instant::now();
        }

        match objects.frame_pool.TryGetNextFrame() {
            Ok(frame) => {
                let raw_params = *params
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let raw_mouse = mouse_position_in_monitor(hmonitor.0);
                let dt = comfort_tick.elapsed().as_secs_f32();
                comfort_tick = Instant::now();
                let (smoothed_mouse, effective_params) =
                    crate::renderer::update_comfort(&raw_params, raw_mouse, &mut comfort, dt);

                if let Ok(mut applied) = status.applied_params.lock() {
                    *applied = Some(format!(
                        "enabled={} mode={} radius={:.0} feather={:.0} dim={:.2} blur={:.0} band={:.0} sx={:.2} sy={:.2} mouse={:.0},{:.0} v={:.0}px/s",
                        effective_params.enabled,
                        effective_params.mode,
                        effective_params.radius,
                        effective_params.feather,
                        effective_params.dim,
                        effective_params.blur_px,
                        effective_params.band_half_px,
                        effective_params.spot_scale_x,
                        effective_params.spot_scale_y,
                        smoothed_mouse[0],
                        smoothed_mouse[1],
                        comfort.smoothed_speed()
                    ));
                }

                match render_blur_frame(&objects, &frame, effective_params, smoothed_mouse) {
                    Ok(()) => {
                        frames_presented += 1;
                        second_frames += 1;
                        status
                            .frames_presented
                            .store(frames_presented, Ordering::Relaxed);
                    }
                    Err(error) => break Some(error),
                }
            }
            Err(_) => thread::sleep(Duration::from_millis(4)),
        }
    };

    status.fps.store(0, Ordering::Relaxed);
    status.running.store(false, Ordering::Relaxed);
    if let Some(error) = loop_error {
        if let Ok(mut last_error) = status.last_error.lock() {
            *last_error = Some(error);
        }
    }
}

/// 全局鼠标 -> 当前 monitor 局部物理像素坐标（capture texture 坐标系）。
fn mouse_position_in_monitor(hmonitor: HMONITOR) -> [f32; 2] {
    let mut point = POINT::default();
    let _ = unsafe { GetCursorPos(&mut point) };

    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let _ = unsafe { GetMonitorInfoW(hmonitor, &mut info) };

    [
        (point.x - info.rcMonitor.left) as f32,
        (point.y - info.rcMonitor.top) as f32,
    ]
}

struct CaptureDisplayObjects {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    frame_pool: Direct3D11CaptureFramePool,
    _session: GraphicsCaptureSession,
    _composition_device: IDCompositionDevice,
    _target: IDCompositionTarget,
    _visual: IDCompositionVisual,
    swapchain: IDXGISwapChain1,
    pipeline: ShaderPipeline,
    capture_width: u32,
    capture_height: u32,
}

fn build_capture_display_objects(
    hwnd: HWND,
    hmonitor: HMONITOR,
) -> Result<CaptureDisplayObjects, String> {
    let (device, context, _) = create_d3d11_device()?;
    let (item, frame_pool, capture_size) =
        create_capture_objects_for_monitor(hmonitor, &device)?;

    let session = frame_pool
        .CreateCaptureSession(&item)
        .map_err(|error| format!("CreateCaptureSession failed: {error}"))?;
    // 系统捕获提示条会污染直通画面，尽量关掉；权限不足时忽略，不影响管线。
    let _ = session.SetIsBorderRequired(false);
    session
        .StartCapture()
        .map_err(|error| format!("GraphicsCaptureSession::StartCapture failed: {error}"))?;

    let capture_width = capture_size.Width.max(1) as u32;
    let capture_height = capture_size.Height.max(1) as u32;

    let (composition_device, target, swapchain, _initial_backbuffer) =
        create_composition_swapchain_for_hwnd(hwnd, &device, capture_width, capture_height)?;

    let pipeline = build_shader_pipeline(&device, capture_width, capture_height)?;

    // visual 树只在启动时提交一次；之后 swapchain 的 Present 会自动驱动 DComp。
    let visual = unsafe { composition_device.CreateVisual() }
        .map_err(|error| format!("IDCompositionDevice::CreateVisual failed: {error}"))?;
    unsafe {
        visual
            .SetContent(&swapchain)
            .map_err(|error| format!("IDCompositionVisual::SetContent failed: {error}"))?;
        target
            .SetRoot(&visual)
            .map_err(|error| format!("IDCompositionTarget::SetRoot failed: {error}"))?;
        composition_device
            .Commit()
            .map_err(|error| format!("IDCompositionDevice::Commit failed: {error}"))?;
    }

    Ok(CaptureDisplayObjects {
        device,
        context,
        frame_pool,
        _session: session,
        _composition_device: composition_device,
        _target: target,
        _visual: visual,
        swapchain,
        pipeline,
        capture_width,
        capture_height,
    })
}

// ---------------------------------------------------------------------------
// 阶段 B/C/D：shader 管线
//
// capture texture
//   -> pass1 PSBlurH    -> 1/4 quarterA（横向模糊 + 降采样）
//   -> pass2 PSBlurV    -> 1/4 quarterB（纵向模糊）
//   -> pass3 PSComposite -> swapchain back buffer（mask 光圈 + 变暗 + 混合）
// ---------------------------------------------------------------------------

const HLSL_SOURCE: &str = r#"
cbuffer Params : register(b0)
{
    // packoffset 按 16 字节寄存器编址，必须与 Rust 端 ShaderConstants
    // 的字节布局一一对应（两个 float2 共享 c0，标量依次排到 c3）。
    float2 screenSize : packoffset(c0.x);
    float2 mouse : packoffset(c0.z);
    float radius : packoffset(c1.x);
    float feather : packoffset(c1.y);
    float dim : packoffset(c1.z);
    float mode : packoffset(c1.w);
    float bandHalf : packoffset(c2.x);
    float blurMix : packoffset(c2.y);
    float blurStepU : packoffset(c2.z);
    float blurStepV : packoffset(c2.w);
    float enabled : packoffset(c3.x);
    float spotScaleX : packoffset(c3.y);
    float spotScaleY : packoffset(c3.z);
};

struct PSInput
{
    float4 pos : SV_POSITION;
    float2 uv : TEXCOORD0;
};

PSInput VSMain(uint id : SV_VertexID)
{
    PSInput output;
    float x = (id == 2) ? 3.0 : -1.0;
    float y = (id == 1) ? 3.0 : -1.0;
    output.pos = float4(x, y, 0.0, 1.0);
    output.uv = float2((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
    return output;
}

static const float BLUR_WEIGHTS[5] =
{
    0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216
};

Texture2D<float4> sourceTex : register(t0);
Texture2D<float4> blurTex : register(t1);
SamplerState linearSampler : register(s0);

float4 PSBlurH(PSInput input) : SV_Target
{
    float3 color = sourceTex.Sample(linearSampler, input.uv).rgb * BLUR_WEIGHTS[0];
    [unroll]
    for (int i = 1; i < 5; i++)
    {
        float u = blurStepU * i;
        color += sourceTex.Sample(linearSampler, input.uv + float2(u, 0.0)).rgb * BLUR_WEIGHTS[i];
        color += sourceTex.Sample(linearSampler, input.uv - float2(u, 0.0)).rgb * BLUR_WEIGHTS[i];
    }
    return float4(color, 1.0);
}

float4 PSBlurV(PSInput input) : SV_Target
{
    float3 color = sourceTex.Sample(linearSampler, input.uv).rgb * BLUR_WEIGHTS[0];
    [unroll]
    for (int i = 1; i < 5; i++)
    {
        float v = blurStepV * i;
        color += sourceTex.Sample(linearSampler, input.uv + float2(0.0, v)).rgb * BLUR_WEIGHTS[i];
        color += sourceTex.Sample(linearSampler, input.uv - float2(0.0, v)).rgb * BLUR_WEIGHTS[i];
    }
    return float4(color, 1.0);
}

float focusDistance(float2 pixel)
{
    if (mode < 0.5)
    {
        // 拉伸系数把圆距离变成椭圆：半轴 = radius * scale。
        float2 delta = (pixel - mouse) / float2(spotScaleX, spotScaleY);
        return length(delta);
    }
    return abs(pixel.y - mouse.y);
}

float4 PSComposite(PSInput input) : SV_Target
{
    float4 original = sourceTex.Sample(linearSampler, input.uv);

    if (enabled < 0.5)
    {
        return float4(original.rgb, 1.0);
    }

    float4 blurred = blurTex.Sample(linearSampler, input.uv);
    float2 pixel = input.uv * screenSize;
    float edge = (mode < 0.5) ? radius : bandHalf;
    float mask = smoothstep(edge, edge + max(feather, 1.0), focusDistance(pixel));
    float3 periphery = lerp(original.rgb, blurred.rgb, blurMix) * (1.0 - dim);
    float3 color = lerp(original.rgb, periphery, mask);

    // swapchain 是 premultiplied alpha；直通画面整体不透明。
    return float4(color, 1.0);
}
"#;

/// 与 HLSL cbuffer Params 一一对应；总大小必须是 16 的倍数。
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct ShaderConstants {
    screen_size: [f32; 2],
    mouse: [f32; 2],
    radius: f32,
    feather: f32,
    dim: f32,
    mode: f32,
    band_half: f32,
    blur_mix: f32,
    blur_step_u: f32,
    blur_step_v: f32,
    enabled: f32,
    spot_scale_x: f32,
    spot_scale_y: f32,
    pad: [f32; 1],
}

struct ShaderPipeline {
    vertex_shader: ID3D11VertexShader,
    pixel_shader_blur_h: ID3D11PixelShader,
    pixel_shader_blur_v: ID3D11PixelShader,
    pixel_shader_composite: ID3D11PixelShader,
    sampler: ID3D11SamplerState,
    constant_buffer: ID3D11Buffer,
    rtv_quarter_a: ID3D11RenderTargetView,
    rtv_quarter_b: ID3D11RenderTargetView,
    srv_quarter_a: ID3D11ShaderResourceView,
    srv_quarter_b: ID3D11ShaderResourceView,
    _quarter_texture_a: ID3D11Texture2D,
    _quarter_texture_b: ID3D11Texture2D,
    quarter_width: u32,
    quarter_height: u32,
}

fn build_shader_pipeline(
    device: &ID3D11Device,
    capture_width: u32,
    capture_height: u32,
) -> Result<ShaderPipeline, String> {
    let vertex_shader = compile_vertex_shader(device)?;
    let pixel_shader_blur_h = compile_pixel_shader(device, "PSBlurH")?;
    let pixel_shader_blur_v = compile_pixel_shader(device, "PSBlurV")?;
    let pixel_shader_composite = compile_pixel_shader(device, "PSComposite")?;

    let sampler_desc = D3D11_SAMPLER_DESC {
        Filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR,
        AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
        AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
        AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
        MipLODBias: 0.0,
        MaxAnisotropy: 1,
        ComparisonFunc: D3D11_COMPARISON_NEVER,
        BorderColor: [0.0; 4],
        MinLOD: 0.0,
        MaxLOD: f32::MAX,
    };
    let mut sampler: Option<ID3D11SamplerState> = None;
    unsafe {
        device
            .CreateSamplerState(&sampler_desc, Some(&mut sampler))
            .map_err(|error| format!("CreateSamplerState failed: {error}"))?;
    }
    let sampler =
        sampler.ok_or_else(|| "CreateSamplerState returned no sampler".to_string())?;

    let constant_desc = D3D11_BUFFER_DESC {
        ByteWidth: std::mem::size_of::<ShaderConstants>() as u32,
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
        StructureByteStride: 0,
    };
    let initial_constants = ShaderConstants::default();
    let initial_data = D3D11_SUBRESOURCE_DATA {
        pSysMem: &initial_constants as *const ShaderConstants as *const core::ffi::c_void,
        SysMemPitch: 0,
        SysMemSlicePitch: 0,
    };
    let mut constant_buffer: Option<ID3D11Buffer> = None;
    unsafe {
        device
            .CreateBuffer(&constant_desc, Some(&initial_data), Some(&mut constant_buffer))
            .map_err(|error| format!("CreateBuffer failed for shader constants: {error}"))?;
    }
    let constant_buffer =
        constant_buffer.ok_or_else(|| "CreateBuffer returned no buffer".to_string())?;

    let quarter_width = ((capture_width + 3) / 4).max(1);
    let quarter_height = ((capture_height + 3) / 4).max(1);
    let quarter_desc = D3D11_TEXTURE2D_DESC {
        Width: quarter_width,
        Height: quarter_height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE).0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };

    let mut quarter_texture_a: Option<ID3D11Texture2D> = None;
    let mut quarter_texture_b: Option<ID3D11Texture2D> = None;
    unsafe {
        device
            .CreateTexture2D(&quarter_desc, None, Some(&mut quarter_texture_a))
            .map_err(|error| format!("CreateTexture2D failed for quarterA: {error}"))?;
        device
            .CreateTexture2D(&quarter_desc, None, Some(&mut quarter_texture_b))
            .map_err(|error| format!("CreateTexture2D failed for quarterB: {error}"))?;
    }
    let quarter_texture_a =
        quarter_texture_a.ok_or_else(|| "CreateTexture2D returned no quarterA".to_string())?;
    let quarter_texture_b =
        quarter_texture_b.ok_or_else(|| "CreateTexture2D returned no quarterB".to_string())?;

    let mut rtv_quarter_a: Option<ID3D11RenderTargetView> = None;
    let mut rtv_quarter_b: Option<ID3D11RenderTargetView> = None;
    let mut srv_quarter_a: Option<ID3D11ShaderResourceView> = None;
    let mut srv_quarter_b: Option<ID3D11ShaderResourceView> = None;
    unsafe {
        device
            .CreateRenderTargetView(&quarter_texture_a, None, Some(&mut rtv_quarter_a))
            .map_err(|error| format!("CreateRenderTargetView failed for quarterA: {error}"))?;
        device
            .CreateRenderTargetView(&quarter_texture_b, None, Some(&mut rtv_quarter_b))
            .map_err(|error| format!("CreateRenderTargetView failed for quarterB: {error}"))?;
        device
            .CreateShaderResourceView(&quarter_texture_a, None, Some(&mut srv_quarter_a))
            .map_err(|error| format!("CreateShaderResourceView failed for quarterA: {error}"))?;
        device
            .CreateShaderResourceView(&quarter_texture_b, None, Some(&mut srv_quarter_b))
            .map_err(|error| format!("CreateShaderResourceView failed for quarterB: {error}"))?;
    }

    Ok(ShaderPipeline {
        vertex_shader,
        pixel_shader_blur_h,
        pixel_shader_blur_v,
        pixel_shader_composite,
        sampler,
        constant_buffer,
        rtv_quarter_a: rtv_quarter_a
            .ok_or_else(|| "CreateRenderTargetView returned no quarterA view".to_string())?,
        rtv_quarter_b: rtv_quarter_b
            .ok_or_else(|| "CreateRenderTargetView returned no quarterB view".to_string())?,
        srv_quarter_a: srv_quarter_a
            .ok_or_else(|| "CreateShaderResourceView returned no quarterA view".to_string())?,
        srv_quarter_b: srv_quarter_b
            .ok_or_else(|| "CreateShaderResourceView returned no quarterB view".to_string())?,
        _quarter_texture_a: quarter_texture_a,
        _quarter_texture_b: quarter_texture_b,
        quarter_width,
        quarter_height,
    })
}

fn compile_shader_blob(entry: &str, target: &str) -> Result<ID3DBlob, String> {
    let mut entry_buffer: Vec<u8> = entry.bytes().collect();
    entry_buffer.push(0);
    let mut target_buffer: Vec<u8> = target.bytes().collect();
    target_buffer.push(0);

    let mut code: Option<ID3DBlob> = None;
    let mut errors: Option<ID3DBlob> = None;

    let compile_result = unsafe {
        D3DCompile(
            HLSL_SOURCE.as_ptr().cast(),
            HLSL_SOURCE.len(),
            PCSTR::null(),
            None,
            None,
            PCSTR(entry_buffer.as_ptr()),
            PCSTR(target_buffer.as_ptr()),
            0,
            0,
            &mut code,
            Some(&mut errors),
        )
    };

    compile_result.map_err(|error| {
        let details = errors
            .as_ref()
            .map(blob_text)
            .unwrap_or_else(|| error.to_string());
        format!("D3DCompile failed for {entry}: {details}")
    })?;

    code.ok_or_else(|| format!("D3DCompile produced no shader code for {entry}"))
}

fn blob_bytes(blob: &ID3DBlob) -> &[u8] {
    unsafe {
        std::slice::from_raw_parts(blob.GetBufferPointer() as *const u8, blob.GetBufferSize())
    }
}

fn blob_text(blob: &ID3DBlob) -> String {
    String::from_utf8_lossy(blob_bytes(blob)).into_owned()
}

fn compile_vertex_shader(device: &ID3D11Device) -> Result<ID3D11VertexShader, String> {
    let blob = compile_shader_blob("VSMain", "vs_5_0")?;
    let bytecode = blob_bytes(&blob);
    let mut shader: Option<ID3D11VertexShader> = None;
    unsafe {
        device
            .CreateVertexShader(bytecode, None, Some(&mut shader))
            .map_err(|error| format!("CreateVertexShader failed: {error}"))?;
    }
    shader.ok_or_else(|| "CreateVertexShader returned no shader".to_string())
}

fn compile_pixel_shader(device: &ID3D11Device, entry: &str) -> Result<ID3D11PixelShader, String> {
    let blob = compile_shader_blob(entry, "ps_5_0")?;
    let bytecode = blob_bytes(&blob);
    let mut shader: Option<ID3D11PixelShader> = None;
    unsafe {
        device
            .CreatePixelShader(bytecode, None, Some(&mut shader))
            .map_err(|error| format!("CreatePixelShader failed for {entry}: {error}"))?;
    }
    shader.ok_or_else(|| format!("CreatePixelShader returned no shader for {entry}"))
}

fn viewport(width: u32, height: u32) -> D3D11_VIEWPORT {
    D3D11_VIEWPORT {
        TopLeftX: 0.0,
        TopLeftY: 0.0,
        Width: width as f32,
        Height: height as f32,
        MinDepth: 0.0,
        MaxDepth: 1.0,
    }
}

fn render_blur_frame(
    objects: &CaptureDisplayObjects,
    frame: &windows::Graphics::Capture::Direct3D11CaptureFrame,
    params: GpuRendererParams,
    mouse: [f32; 2],
) -> Result<(), String> {
    let surface = frame
        .Surface()
        .map_err(|error| format!("Direct3D11CaptureFrame::Surface failed: {error}"))?;
    let access = surface
        .cast::<IDirect3DDxgiInterfaceAccess>()
        .map_err(|error| {
            format!("failed to cast IDirect3DSurface to IDirect3DDxgiInterfaceAccess: {error}")
        })?;
    let capture_texture: ID3D11Texture2D = unsafe { access.GetInterface() }.map_err(|error| {
        format!("IDirect3DDxgiInterfaceAccess::GetInterface<ID3D11Texture2D> failed: {error}")
    })?;

    let device = &objects.device;
    let context = &objects.context;
    let pipeline = &objects.pipeline;

    // capture surface 每帧可能来自不同 pool buffer，SRV 每帧重建。
    let mut capture_srv: Option<ID3D11ShaderResourceView> = None;
    unsafe {
        device
            .CreateShaderResourceView(&capture_texture, None, Some(&mut capture_srv))
            .map_err(|error| format!("CreateShaderResourceView failed for capture: {error}"))?;
    }
    let capture_srv = capture_srv
        .ok_or_else(|| "CreateShaderResourceView returned no capture view".to_string())?;

    // flip 模型 swapchain 的 buffer 每帧轮换，RTV 每帧重建。
    let backbuffer: ID3D11Texture2D = unsafe { objects.swapchain.GetBuffer(0) }
        .map_err(|error| format!("IDXGISwapChain1::GetBuffer failed: {error}"))?;
    let mut backbuffer_rtv: Option<ID3D11RenderTargetView> = None;
    unsafe {
        device
            .CreateRenderTargetView(&backbuffer, None, Some(&mut backbuffer_rtv))
            .map_err(|error| format!("CreateRenderTargetView failed for backbuffer: {error}"))?;
    }
    let backbuffer_rtv = backbuffer_rtv
        .ok_or_else(|| "CreateRenderTargetView returned no backbuffer view".to_string())?;

    let quarter_width = pipeline.quarter_width as f32;
    let quarter_height = pipeline.quarter_height as f32;
    let blur_span = (params.blur_px * 0.25).max(1.0);
    let constants = ShaderConstants {
        screen_size: [objects.capture_width as f32, objects.capture_height as f32],
        mouse,
        radius: params.radius,
        feather: params.feather,
        dim: params.dim,
        mode: params.mode as f32,
        band_half: params.band_half_px,
        blur_mix: if params.blur_px >= 1.0 { 1.0 } else { 0.0 },
        blur_step_u: blur_span / quarter_width,
        blur_step_v: blur_span / quarter_height,
        enabled: if params.enabled { 1.0 } else { 0.0 },
        spot_scale_x: params.spot_scale_x.max(0.1),
        spot_scale_y: params.spot_scale_y.max(0.1),
        pad: [0.0],
    };

    unsafe {
        context.UpdateSubresource(
            &pipeline.constant_buffer,
            0,
            None,
            &constants as *const ShaderConstants as *const core::ffi::c_void,
            0,
            0,
        );

        context.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        context.IASetInputLayout(None);
        context.VSSetShader(Some(&pipeline.vertex_shader), None);
        context.PSSetSamplers(0, Some(&[Some(pipeline.sampler.clone())]));
        context.PSSetConstantBuffers(0, Some(&[Some(pipeline.constant_buffer.clone())]));

        // pass 1：capture -> quarterA，横向模糊 + 降采样
        context.OMSetRenderTargets(Some(&[Some(pipeline.rtv_quarter_a.clone())]), None);
        context.RSSetViewports(Some(&[viewport(
            pipeline.quarter_width,
            pipeline.quarter_height,
        )]));
        context.PSSetShader(Some(&pipeline.pixel_shader_blur_h), None);
        context.PSSetShaderResources(0, Some(&[Some(capture_srv.clone())]));
        context.Draw(3, 0);

        // pass 2：quarterA -> quarterB，纵向模糊
        context.OMSetRenderTargets(Some(&[Some(pipeline.rtv_quarter_b.clone())]), None);
        context.PSSetShader(Some(&pipeline.pixel_shader_blur_v), None);
        context.PSSetShaderResources(0, Some(&[Some(pipeline.srv_quarter_a.clone())]));
        context.Draw(3, 0);

        // pass 3：composite -> back buffer，光圈 mask + 变暗 + 模糊混合
        context.OMSetRenderTargets(Some(&[Some(backbuffer_rtv)]), None);
        context.RSSetViewports(Some(&[viewport(
            objects.capture_width,
            objects.capture_height,
        )]));
        context.PSSetShader(Some(&pipeline.pixel_shader_composite), None);
        context.PSSetShaderResources(
            0,
            Some(&[Some(capture_srv), Some(pipeline.srv_quarter_b.clone())]),
        );
        context.Draw(3, 0);

        // 解绑输出和采样，避免下帧资源仍被绑定为 RTV/SRV。
        context.OMSetRenderTargets(None, None);
        context.PSSetShaderResources(0, Some(&[None, None]));

        objects
            .swapchain
            .Present(1, DXGI_PRESENT(0))
            .ok()
            .map_err(|error| format!("IDXGISwapChain1::Present failed: {error}"))?;
    }

    Ok(())
}
