// release 构建使用 windows 子系统，避免双击运行时弹出终端窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    focus_bubble_lib::run()
}
