use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
pub struct FileEntry {
    pub path: String,
    pub bytes: Vec<u8>,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
pub struct Skip {
    pub path: String,
    pub reason: String,
}

#[derive(Serialize, Debug, Default)]
pub struct ReadResult {
    pub files: Vec<FileEntry>,
    pub skipped: Vec<Skip>,
}

/// Recursively read every `.md` file under `dir`. Paths are relative with `/` separators.
/// Unreadable files, files over 20 MB and symlinks are reported in `skipped` instead of failing the read.
pub fn read_folder_md(dir: &Path) -> Result<ReadResult, String> {
    const MAX_BYTES: u64 = 20 * 1024 * 1024;
    fn rel(root: &Path, path: &Path) -> String {
        let r = path.strip_prefix(root).unwrap_or(path);
        let parts: Vec<String> = r.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
        parts.join("/")
    }
    fn walk(root: &Path, dir: &Path, out: &mut ReadResult) -> Result<(), std::io::Error> {
        for entry in std::fs::read_dir(dir)? {
            let path = match entry {
                Ok(e) => e.path(),
                Err(e) => {
                    out.skipped.push(Skip { path: rel(root, dir), reason: e.to_string() });
                    continue;
                }
            };
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(e) => {
                    out.skipped.push(Skip { path: rel(root, &path), reason: e.to_string() });
                    continue;
                }
            };
            if meta.file_type().is_symlink() {
                out.skipped.push(Skip { path: rel(root, &path), reason: "symlink (not followed)".into() });
            } else if meta.is_dir() {
                if let Err(e) = walk(root, &path, out) {
                    out.skipped.push(Skip { path: rel(root, &path), reason: e.to_string() });
                }
            } else if path.extension().map_or(false, |x| x.eq_ignore_ascii_case("md")) {
                if meta.len() > MAX_BYTES {
                    out.skipped.push(Skip { path: rel(root, &path), reason: "larger than 20 MB".into() });
                    continue;
                }
                match std::fs::read(&path) {
                    Ok(bytes) => out.files.push(FileEntry { path: rel(root, &path), bytes }),
                    Err(e) => out.skipped.push(Skip { path: rel(root, &path), reason: e.to_string() }),
                }
            }
        }
        Ok(())
    }
    let mut out = ReadResult::default();
    walk(dir, dir, &mut out).map_err(|e| e.to_string())?;
    out.files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Write files under `dir`, creating folders. Paths that are absolute or contain `..` are rejected.
pub fn write_files(dir: &Path, files: &[FileEntry]) -> Result<(), String> {
    use std::path::Component;
    // Validate everything first so a bad entry writes nothing.
    for f in files {
        let bad = f.path.is_empty()
            || f.path.contains('\\')
            || f.path.contains(':')
            || Path::new(&f.path).components().any(|c| !matches!(c, Component::Normal(_)));
        if bad {
            return Err(format!("unsafe path: {}", f.path));
        }
    }
    for f in files {
        let target = dir.join(&f.path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&target, &f.bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("mybrain-files-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn write_then_read_round_trips_nested_md_files() {
        let d = tmp("rt");
        let files = vec![
            FileEntry { path: "a.md".into(), bytes: b"alpha".to_vec() },
            FileEntry { path: "sub/b.md".into(), bytes: "bêta".as_bytes().to_vec() },
        ];
        write_files(&d, &files).unwrap();
        let mut got = read_folder_md(&d).unwrap().files;
        got.sort_by(|x, y| x.path.cmp(&y.path));
        assert_eq!(got, files);
    }

    #[test]
    fn read_ignores_non_markdown_files() {
        let d = tmp("ign");
        std::fs::write(d.join("x.txt"), "no").unwrap();
        std::fs::write(d.join("y.MD"), "yes").unwrap();
        let got = read_folder_md(&d).unwrap().files;
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].path, "y.MD");
    }

    #[test]
    fn write_rejects_path_traversal_and_absolute_paths() {
        let d = tmp("trav");
        for bad in ["../evil.md", "a/../../evil.md", "/etc/evil.md", "C:\\evil.md"] {
            let r = write_files(&d, &[FileEntry { path: bad.into(), bytes: vec![1] }]);
            assert!(r.is_err(), "{bad} should be rejected");
        }
        assert!(!d.parent().unwrap().join("evil.md").exists());
    }

    #[test]
    fn oversized_files_are_reported_not_dropped_silently() {
        let d = tmp("big");
        let f = std::fs::File::create(d.join("huge.md")).unwrap();
        f.set_len(21 * 1024 * 1024).unwrap();
        std::fs::write(d.join("ok.md"), "fine").unwrap();
        let r = read_folder_md(&d).unwrap();
        assert_eq!(r.files.len(), 1);
        assert_eq!(r.skipped.len(), 1);
        assert_eq!(r.skipped[0].path, "huge.md");
        assert!(r.skipped[0].reason.contains("20 MB"));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_loops_are_skipped_and_reported() {
        let d = tmp("loop");
        std::fs::write(d.join("a.md"), "x").unwrap();
        std::os::unix::fs::symlink(&d, d.join("loop")).unwrap();
        let r = read_folder_md(&d).unwrap();
        assert_eq!(r.files.len(), 1);
        assert_eq!(r.skipped[0].path, "loop");
    }
}
