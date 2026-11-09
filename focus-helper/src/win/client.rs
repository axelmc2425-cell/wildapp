//! Minimal pipe client for `focus-helper send`: one JSON request line in, one reply line out.
//! Uses the same explicit access mask as the app's Tauri command (src-tauri/src/focus.rs).

use std::io::{BufRead, BufReader, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::sync::mpsc;
use std::time::Duration;

use crate::service_logic::PIPE_NAME;

const ERROR_PIPE_BUSY: i32 = 231;
const MAX_REQUEST: usize = 4 * 1024 * 1024;

/// Sends `request` (one JSON object, no newline needed) and returns the single reply line.
/// Errors are human-readable transport failures (service not running, timeout, ...).
pub fn send(request: &str) -> Result<String, String> {
    if request.len() > MAX_REQUEST {
        return Err("request is too large".to_string());
    }
    let request = request.trim_end_matches(['\r', '\n']).to_string();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = (|| -> Result<String, String> {
            // FILE_READ_DATA (0x1) | FILE_WRITE_DATA (0x2) | FILE_WRITE_ATTRIBUTES (0x100). The pipe
            // ACL for users excludes FILE_APPEND_DATA (= create pipe instance), so the default
            // GENERIC_READ|GENERIC_WRITE open would be denied.
            let mut pipe = std::fs::OpenOptions::new()
                .access_mode(0x1 | 0x2 | 0x100)
                .open(PIPE_NAME)
                .map_err(|e| {
                    if e.kind() == std::io::ErrorKind::NotFound || e.raw_os_error() == Some(ERROR_PIPE_BUSY) {
                        "the Focus Room helper service is not running (pipe not available)".to_string()
                    } else {
                        format!("could not open the helper pipe: {e}")
                    }
                })?;
            pipe.write_all(request.as_bytes())
                .and_then(|_| pipe.write_all(b"\n"))
                .and_then(|_| pipe.flush())
                .map_err(|e| format!("could not send to the helper: {e}"))?;
            let mut line = String::new();
            let n = BufReader::new(pipe)
                .read_line(&mut line)
                .map_err(|e| format!("could not read the helper reply: {e}"))?;
            if n == 0 {
                return Err("the helper closed the connection without replying".to_string());
            }
            Ok(line.trim_end_matches(['\r', '\n']).to_string())
        })();
        let _ = tx.send(result);
    });
    rx.recv_timeout(Duration::from_secs(5)).unwrap_or_else(|_| Err("the helper did not answer within 5 seconds".to_string()))
}
