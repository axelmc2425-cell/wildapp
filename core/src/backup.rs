use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;

const DB_NAME: &str = "mybrain.db";
const PENDING: &str = "restore-pending";

fn add_dir(w: &mut zip::ZipWriter<fs::File>, root: &Path, dir: &Path) -> Result<(), String> {
    let opts = SimpleFileOptions::default();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.is_dir() {
            add_dir(w, root, &path)?;
        } else {
            let rel: Vec<String> = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect();
            w.start_file(rel.join("/"), opts).map_err(|e| e.to_string())?;
            w.write_all(&fs::read(&path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Zip `mybrain.db` and `attachments/` from `data_dir` into `dest`.
pub fn backup_create(data_dir: &Path, dest: &Path) -> Result<(), String> {
    let db = data_dir.join(DB_NAME);
    if !db.exists() {
        return Err("no database to back up".into());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut w = zip::ZipWriter::new(fs::File::create(dest).map_err(|e| e.to_string())?);
    w.start_file(DB_NAME, SimpleFileOptions::default()).map_err(|e| e.to_string())?;
    w.write_all(&fs::read(&db).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let att = data_dir.join("attachments");
    if att.is_dir() {
        add_dir(&mut w, data_dir, &att)?;
    }
    w.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// A timestamped zip in `<data_dir>/auto-backups/`. Returns its path.
pub fn auto_backup(data_dir: &Path, label: &str) -> Result<PathBuf, String> {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let dest = data_dir.join("auto-backups").join(format!("{label}-{secs}.zip"));
    backup_create(data_dir, &dest)?;
    Ok(dest)
}

/// Validate `src` and stage it so the next launch replaces the data. A safety zip of the
/// current data is written to `<data_dir>/auto-backups/` first.
pub fn restore_stage(data_dir: &Path, src: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(fs::File::open(src).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let has_db = (0..archive.len()).any(|i| {
        archive.by_index(i).ok().and_then(|f| f.enclosed_name()).map_or(false, |n| n == Path::new(DB_NAME))
    });
    if !has_db {
        return Err("that file is not a MyBrain backup (no database inside)".into());
    }
    if data_dir.join(DB_NAME).exists() {
        auto_backup(data_dir, "before-restore")?;
    }
    let pending = data_dir.join(PENDING);
    let _ = fs::remove_dir_all(&pending);
    fs::create_dir_all(&pending).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(name) = f.enclosed_name() else { continue };
        let wanted = name == Path::new(DB_NAME) || name.starts_with("attachments");
        if !wanted || f.is_dir() {
            continue;
        }
        let target = pending.join(&name);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        fs::write(&target, buf).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// If a restore is staged, replace the database and attachments with it. Returns true if applied.
pub fn apply_pending_restore(data_dir: &Path) -> Result<bool, String> {
    let pending = data_dir.join(PENDING);
    if !pending.is_dir() {
        return Ok(false);
    }
    if !pending.join(DB_NAME).exists() {
        let _ = fs::remove_dir_all(&pending);
        return Ok(false);
    }
    for f in [DB_NAME, "mybrain.db-wal", "mybrain.db-shm"] {
        let _ = fs::remove_file(data_dir.join(f));
    }
    let _ = fs::remove_dir_all(data_dir.join("attachments"));
    fs::rename(pending.join(DB_NAME), data_dir.join(DB_NAME)).map_err(|e| e.to_string())?;
    if pending.join("attachments").is_dir() {
        fs::rename(pending.join("attachments"), data_dir.join("attachments")).map_err(|e| e.to_string())?;
    } else {
        fs::create_dir_all(data_dir.join("attachments")).map_err(|e| e.to_string())?;
    }
    let _ = fs::remove_dir_all(&pending);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("mybrain-backup-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("attachments/sub")).unwrap();
        d
    }

    #[test]
    fn backup_restore_brings_original_data_back() {
        let d = tmp("rt");
        fs::write(d.join("mybrain.db"), b"original-db").unwrap();
        fs::write(d.join("attachments/sub/a.bin"), b"original-attachment").unwrap();
        let zip = d.join("backup.zip");
        backup_create(&d, &zip).unwrap();

        fs::write(d.join("mybrain.db"), b"changed").unwrap();
        fs::write(d.join("attachments/sub/a.bin"), b"changed").unwrap();
        fs::write(d.join("attachments/new.bin"), b"extra").unwrap();

        restore_stage(&d, &zip).unwrap();
        assert!(apply_pending_restore(&d).unwrap());

        assert_eq!(fs::read(d.join("mybrain.db")).unwrap(), b"original-db");
        assert_eq!(fs::read(d.join("attachments/sub/a.bin")).unwrap(), b"original-attachment");
        assert!(!d.join("attachments/new.bin").exists());
    }

    #[test]
    fn restore_writes_a_safety_copy_of_the_current_data() {
        let d = tmp("safe");
        fs::write(d.join("mybrain.db"), b"v1").unwrap();
        let zip = d.join("b.zip");
        backup_create(&d, &zip).unwrap();
        fs::write(d.join("mybrain.db"), b"v2-current").unwrap();
        restore_stage(&d, &zip).unwrap();
        let n = fs::read_dir(d.join("auto-backups")).unwrap().count();
        assert_eq!(n, 1);
    }

    #[test]
    fn apply_pending_restore_does_nothing_when_nothing_is_staged() {
        let d = tmp("none");
        fs::write(d.join("mybrain.db"), b"keep").unwrap();
        assert!(!apply_pending_restore(&d).unwrap());
        assert_eq!(fs::read(d.join("mybrain.db")).unwrap(), b"keep");
    }

    #[test]
    fn restore_rejects_a_zip_without_a_database() {
        let d = tmp("bad");
        let zip = d.join("empty.zip");
        let f = fs::File::create(&zip).unwrap();
        let mut w = zip::ZipWriter::new(f);
        w.start_file("readme.txt", zip::write::SimpleFileOptions::default()).unwrap();
        std::io::Write::write_all(&mut w, b"hi").unwrap();
        w.finish().unwrap();
        fs::write(d.join("mybrain.db"), b"keep").unwrap();
        assert!(restore_stage(&d, &zip).is_err());
        assert!(!apply_pending_restore(&d).unwrap());
        assert_eq!(fs::read(d.join("mybrain.db")).unwrap(), b"keep");
    }

    #[test]
    fn restore_ignores_zip_entries_that_escape_the_folder() {
        let d = tmp("slip");
        let zip = d.join("evil.zip");
        let f = fs::File::create(&zip).unwrap();
        let mut w = zip::ZipWriter::new(f);
        let o = zip::write::SimpleFileOptions::default();
        w.start_file("mybrain.db", o).unwrap();
        std::io::Write::write_all(&mut w, b"db").unwrap();
        w.start_file("../escaped.txt", o).unwrap();
        std::io::Write::write_all(&mut w, b"bad").unwrap();
        w.finish().unwrap();
        restore_stage(&d, &zip).unwrap();
        apply_pending_restore(&d).unwrap();
        assert!(!d.parent().unwrap().join("escaped.txt").exists());
        assert_eq!(fs::read(d.join("mybrain.db")).unwrap(), b"db");
    }
}
