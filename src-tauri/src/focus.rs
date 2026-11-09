//! Bridge from the webview to the Focus Room helper service (named pipe, Windows only).

/// Largest request accepted, in bytes.
#[cfg_attr(not(windows), allow(dead_code))]
const MAX_REQUEST: usize = 4 * 1024 * 1024;

/// Async so the pipe I/O (up to the 5 s timeout) runs on a blocking-pool thread and never
/// stalls the UI thread.
#[tauri::command]
pub async fn focus_helper_call(request: String) -> Result<String, String> {
    match tauri::async_runtime::spawn_blocking(move || call(request)).await {
        Ok(result) => result,
        Err(e) => Err(format!("The Focus Room helper call failed: {e}")),
    }
}

#[cfg(not(windows))]
fn call(_request: String) -> Result<String, String> {
    Err("Focus Room blocking is only available on Windows".to_string())
}

#[cfg(windows)]
fn call(request: String) -> Result<String, String> {
    use std::io::{BufRead, BufReader, Write};
    use std::os::windows::fs::OpenOptionsExt;
    use std::sync::mpsc;
    use std::time::Duration;

    const PIPE: &str = r"\\.\pipe\mybrain-focus";
    const ERROR_PIPE_BUSY: i32 = 231;
    const NOT_RUNNING: &str = "The Focus Room helper service is not running";

    if request.len() > MAX_REQUEST {
        return Err("Focus Room request is too large".to_string());
    }
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = (|| -> Result<String, String> {
            // Access mask: FILE_READ_DATA (0x1) | FILE_WRITE_DATA (0x2) | FILE_WRITE_ATTRIBUTES (0x100).
            // The service's pipe ACL for non-admin users deliberately excludes FILE_APPEND_DATA
            // (= FILE_CREATE_PIPE_INSTANCE) so a user cannot create competing pipe instances.
            // `.read(true).write(true)` would request GENERIC_READ | GENERIC_WRITE, which includes
            // that right and would be denied with ACCESS_DENIED, so the mask is given explicitly.
            let mut pipe = std::fs::OpenOptions::new()
                .access_mode(0x1 | 0x2 | 0x100)
                .open(PIPE)
                .map_err(|e| {
                    if e.kind() == std::io::ErrorKind::NotFound || e.raw_os_error() == Some(ERROR_PIPE_BUSY) {
                        NOT_RUNNING.to_string()
                    } else {
                        format!("Could not reach the Focus Room helper: {e}")
                    }
                })?;
            pipe.write_all(request.as_bytes())
                .and_then(|_| pipe.write_all(b"\n"))
                .and_then(|_| pipe.flush())
                .map_err(|e| format!("Could not send to the Focus Room helper: {e}"))?;
            let mut line = String::new();
            let n = BufReader::new(pipe)
                .read_line(&mut line)
                .map_err(|e| format!("Could not read the Focus Room helper reply: {e}"))?;
            if n == 0 {
                return Err("The Focus Room helper closed the connection".to_string());
            }
            Ok(line.trim_end_matches(['\r', '\n']).to_string())
        })();
        let _ = tx.send(result);
    });
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(r) => r,
        Err(_) => Err("focus helper did not answer in time".to_string()),
    }
}
