use crate::files::Skip;
use serde::Serialize;
use std::path::{Component, Path};

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct ImportedPhoto {
    /// Path relative to the `attachments/` folder, always with `/` separators, e.g. `photos/IMG_1.jpg`.
    pub file: String,
    pub taken_ms: i64,
    pub original: String,
}

#[derive(Serialize, Debug, Default)]
pub struct ImportResult {
    pub imported: Vec<ImportedPhoto>,
    pub skipped: Vec<Skip>,
}

const EXTENSIONS: [&str; 7] = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"];

/// Copy images into `<data_dir>/attachments/photos/`. Nothing is uploaded anywhere.
/// Unsupported files are skipped, an identical file already there is returned as imported without a second copy,
/// and a different file with the same name gets a numeric suffix.
pub fn import_photos(data_dir: &Path, sources: &[String]) -> ImportResult {
    use std::fs;
    use std::time::UNIX_EPOCH;
    let dest_dir = data_dir.join("attachments").join("photos");
    let mut out = ImportResult::default();
    let skip = |out: &mut ImportResult, name: &str, reason: String| out.skipped.push(Skip { path: name.to_string(), reason });
    if let Err(e) = fs::create_dir_all(&dest_dir) {
        for s in sources {
            let name = Path::new(s).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            skip(&mut out, &name, e.to_string());
        }
        return out;
    }
    for src in sources {
        let path = Path::new(src);
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let supported = path
            .extension()
            .and_then(|e| e.to_str())
            .map_or(false, |e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()));
        if !supported {
            skip(&mut out, &name, "not a supported image (jpg, png, gif, webp, bmp, avif)".into());
            continue;
        }
        let meta = match fs::metadata(path) {
            Ok(m) => m,
            Err(e) => { skip(&mut out, &name, e.to_string()); continue; }
        };
        let bytes = match fs::read(path) {
            Ok(b) => b,
            Err(e) => { skip(&mut out, &name, e.to_string()); continue; }
        };
        let taken_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let (stem, ext) = match name.rfind('.') {
            Some(i) => (name[..i].to_string(), name[i + 1..].to_string()),
            None => (name.clone(), String::new()),
        };
        let mut candidate = name.clone();
        let mut n = 1;
        loop {
            let target = dest_dir.join(&candidate);
            if !target.exists() {
                match fs::write(&target, &bytes) {
                    Ok(()) => out.imported.push(ImportedPhoto { file: format!("photos/{candidate}"), taken_ms, original: name.clone() }),
                    Err(e) => skip(&mut out, &name, e.to_string()),
                }
                break;
            }
            if fs::read(&target).map_or(false, |b| b == bytes) {
                // Same file already in the vault: report it so a row whose delete left the file behind can come back.
                out.imported.push(ImportedPhoto { file: format!("photos/{candidate}"), taken_ms, original: name.clone() });
                break;
            }
            n += 1;
            candidate = format!("{stem}-{n}.{ext}");
        }
    }
    out
}

/// Delete a photo file previously returned by `import_photos`. Rejects anything outside `photos/`.
pub fn delete_photo_file(data_dir: &Path, file: &str) -> Result<(), String> {
    let safe = file.starts_with("photos/")
        && !file.contains('\\')
        && Path::new(file).components().all(|c| matches!(c, Component::Normal(_)));
    if !safe {
        return Err(format!("not a photo path: {file}"));
    }
    std::fs::remove_file(data_dir.join("attachments").join(file)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{Duration, UNIX_EPOCH};

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("mybrain-photos-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn make(dir: &Path, name: &str, bytes: &[u8], mtime_secs: u64) -> String {
        let p = dir.join(name);
        fs::write(&p, bytes).unwrap();
        let f = fs::File::options().write(true).open(&p).unwrap();
        f.set_modified(UNIX_EPOCH + Duration::from_secs(mtime_secs)).unwrap();
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn imports_copy_files_and_report_the_modified_time_as_taken() {
        let data = tmp("a-data");
        let src = tmp("a-src");
        let a = make(&src, "IMG_1.JPG", b"one", 1_700_000_000);
        let r = import_photos(&data, &[a]);
        assert_eq!(r.imported.len(), 1);
        assert_eq!(r.imported[0].file, "photos/IMG_1.JPG");
        assert_eq!(r.imported[0].taken_ms, 1_700_000_000_000);
        assert_eq!(r.imported[0].original, "IMG_1.JPG");
        assert_eq!(fs::read(data.join("attachments/photos/IMG_1.JPG")).unwrap(), b"one");
    }

    #[test]
    fn unsupported_and_missing_files_are_skipped_with_a_reason() {
        let data = tmp("b-data");
        let src = tmp("b-src");
        let doc = make(&src, "notes.txt", b"x", 1);
        let missing = src.join("gone.png").to_string_lossy().into_owned();
        let r = import_photos(&data, &[doc, missing]);
        assert!(r.imported.is_empty());
        assert_eq!(r.skipped.len(), 2);
        assert_eq!(r.skipped[0].path, "notes.txt");
        assert!(r.skipped[0].reason.contains("not a supported image"));
        assert_eq!(r.skipped[1].path, "gone.png");
    }

    #[test]
    fn the_same_photo_twice_is_a_duplicate_but_a_different_one_with_the_same_name_is_kept() {
        let data = tmp("c-data");
        let s1 = tmp("c-s1");
        let s2 = tmp("c-s2");
        let s3 = tmp("c-s3");
        let a = make(&s1, "x.png", b"same", 10);
        let a2 = make(&s2, "x.png", b"same", 10);
        let b = make(&s3, "x.png", b"different", 20);
        assert_eq!(import_photos(&data, &[a]).imported.len(), 1);
        // The same file again is reported as imported (same stored name, no second copy) so a row whose
        // earlier delete left the file behind can come back; the app ignores rows it already has.
        let dup = import_photos(&data, &[a2]);
        assert_eq!(dup.imported.len(), 1);
        assert_eq!(dup.imported[0].file, "photos/x.png");
        assert!(dup.skipped.is_empty());
        assert_eq!(fs::read_dir(data.join("attachments/photos")).unwrap().count(), 1);
        let r = import_photos(&data, &[b]);
        assert_eq!(r.imported[0].file, "photos/x-2.png");
        assert_eq!(fs::read(data.join("attachments/photos/x-2.png")).unwrap(), b"different");
    }

    #[test]
    fn delete_removes_the_file_and_refuses_paths_outside_photos() {
        let data = tmp("d-data");
        let src = tmp("d-src");
        let a = make(&src, "p.webp", b"p", 5);
        let r = import_photos(&data, &[a]);
        delete_photo_file(&data, &r.imported[0].file).unwrap();
        assert!(!data.join("attachments/photos/p.webp").exists());
        fs::write(data.join("mybrain.db"), b"db").unwrap();
        for bad in ["../mybrain.db", "photos/../../mybrain.db", "/etc/passwd", "mybrain.db", "photos/..\\x"] {
            assert!(delete_photo_file(&data, bad).is_err(), "{bad}");
        }
        assert!(data.join("mybrain.db").exists());
    }
}
