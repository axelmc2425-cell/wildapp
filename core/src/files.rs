use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
pub struct FileEntry {
    pub path: String,
    pub bytes: Vec<u8>,
}

/// Recursively read every `.md` file under `dir`. Paths are relative with `/` separators.
pub fn read_folder_md(dir: &Path) -> Result<Vec<FileEntry>, String> {
    const MAX_BYTES: u64 = 20 * 1024 * 1024;
    fn walk(root: &Path, dir: &Path, out: &mut Vec<FileEntry>) -> Result<(), String> {
        for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.is_dir() {
                walk(root, &path, out)?;
            } else if path.extension().map_or(false, |x| x.eq_ignore_ascii_case("md")) {
                let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
                if meta.len() > MAX_BYTES {
                    continue;
                }
                let rel = path.strip_prefix(root).map_err(|e| e.to_string())?;
                let rel: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
                out.push(FileEntry { path: rel.join("/"), bytes: std::fs::read(&path).map_err(|e| e.to_string())? });
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out)?;
    out.sort_by(|a, b| a.path.cmp(&b.path));
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
        let mut got = read_folder_md(&d).unwrap();
        got.sort_by(|x, y| x.path.cmp(&y.path));
        assert_eq!(got, files);
    }

    #[test]
    fn read_ignores_non_markdown_files() {
        let d = tmp("ign");
        std::fs::write(d.join("x.txt"), "no").unwrap();
        std::fs::write(d.join("y.MD"), "yes").unwrap();
        let got = read_folder_md(&d).unwrap();
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
}
