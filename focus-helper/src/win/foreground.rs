//! Foreground-window sampler. Reads the active program, whether the workstation is locked, and
//! how long the user has been idle.
//!
//! This runs in the interactive user's session, inside the `focus-helper sampler` process that the
//! installer starts at sign-in, and NOT in the helper service: the service lives in Session 0 and
//! cannot see any user's foreground window, input idle time or lock state. There,
//! `OpenInputDesktop` failing is the correct "locked" signal. Window titles are read only for browsers, are returned in
//! the `Sample` and are never logged or stored by this module.

use windows_sys::Win32::Foundation::{CloseHandle, FALSE, HWND};
use windows_sys::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop, DESKTOP_READOBJECTS};
use windows_sys::Win32::System::SystemInformation::{GetLocalTime, GetTickCount};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
};

use crate::sites::is_browser;
use crate::usage::{base_name, day_string, Sample};

/// True when the input desktop cannot be opened (secure desktop: locked or UAC prompt).
fn input_desktop_unavailable() -> bool {
    // SAFETY: plain FFI call; a non-null handle is closed right below.
    let desk = unsafe { OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS) };
    if desk == 0 {
        return true;
    }
    // SAFETY: `desk` is a valid desktop handle we just opened.
    unsafe { CloseDesktop(desk) };
    false
}

/// Full image path of the process owning `pid`, or `None` when it cannot be opened or read.
fn process_image_path(pid: u32) -> Option<String> {
    // SAFETY: plain FFI call; the handle is closed on every path below.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid) };
    if handle == 0 {
        return None;
    }
    let mut buf = vec![0u16; 32768];
    let mut len = buf.len() as u32;
    // SAFETY: `buf` is writable for `len` u16s; `len` is updated to the characters written.
    let ok = unsafe { QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len) };
    // SAFETY: `handle` was opened above and is not used afterwards.
    unsafe { CloseHandle(handle) };
    if ok == 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

fn window_title(hwnd: HWND) -> Option<String> {
    // SAFETY: plain FFI calls on a window handle; a stale handle just yields 0.
    let n = unsafe { GetWindowTextLengthW(hwnd) };
    if n <= 0 {
        return None;
    }
    let mut buf = vec![0u16; n as usize + 1];
    // SAFETY: `buf` is writable for `buf.len()` u16s.
    let got = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    if got <= 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..got as usize]))
}

/// Seconds since the last keyboard or mouse input; `None` when the OS cannot say.
fn idle_secs() -> Option<u64> {
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    // SAFETY: `info` is a valid LASTINPUTINFO with cbSize set.
    if unsafe { GetLastInputInfo(&mut info) } == 0 {
        return None;
    }
    // SAFETY: plain FFI call. Both ticks wrap at 2^32 ms, so wrapping subtraction is correct.
    let now = unsafe { GetTickCount() };
    Some(u64::from(now.wrapping_sub(info.dwTime)) / 1000)
}

fn local_day() -> String {
    // SAFETY: GetLocalTime fills the SYSTEMTIME it is given.
    let t = unsafe {
        let mut t = std::mem::zeroed();
        GetLocalTime(&mut t);
        t
    };
    day_string(t.wYear, t.wMonth, t.wDay)
}

/// One foreground observation, or `None` when nothing countable is in front (no window, the
/// process cannot be read, or the workstation is locked).
pub fn sample() -> Option<Sample> {
    if input_desktop_unavailable() {
        return None;
    }
    // SAFETY: plain FFI call.
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd == 0 {
        return None;
    }
    let mut pid = 0u32;
    // SAFETY: `pid` is a valid out pointer.
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    if pid == 0 {
        return None;
    }
    let exe = base_name(&process_image_path(pid)?);
    if exe.is_empty() || exe.eq_ignore_ascii_case("LockApp.exe") {
        return None;
    }
    let title = if is_browser(&exe) { window_title(hwnd) } else { None };
    // Fail closed: without a trustworthy idle time nothing is counted.
    let idle_secs = idle_secs()?;
    Some(Sample { exe, title, idle_secs, day: local_day() })
}

/// How often the sampler reports.
const REPORT_EVERY: std::time::Duration = std::time::Duration::from_secs(5);

/// The `focus-helper sampler` loop: every 5 s report the foreground program to the service over
/// the pipe. All errors are ignored (the service may be down or restarting); titles are only
/// ever put into the request and are never logged. Never returns.
pub fn run_sampler() -> ! {
    // Started from the Run key as a console-subsystem exe: drop the console right away so no
    // window stays on screen (a brief flash at sign-in is possible).
    // SAFETY: plain FFI call; failure (no console) is harmless.
    unsafe { windows_sys::Win32::System::Console::FreeConsole() };
    loop {
        if let Some(s) = sample() {
            let request = serde_json::json!({
                "type": "ReportForeground",
                "exe": s.exe,
                "title": s.title.map(|t| crate::usage::truncate_title(&t, 1000)),
                "idle_secs": s.idle_secs,
                "day": s.day,
            });
            let _ = crate::win::client::send(&request.to_string());
        }
        std::thread::sleep(REPORT_EVERY);
    }
}
