#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod focus;

use mybrain_core::backup;
use mybrain_core::db::Db;
use mybrain_core::files::{self, FileEntry, ReadResult};
use mybrain_core::photos::{self, ImportResult};
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{Manager, State};

struct DataDir(PathBuf);

#[derive(Deserialize)]
struct Stmt {
    sql: String,
    #[serde(default)]
    params: Vec<Value>,
}

#[tauri::command]
fn db_all(db: State<Db>, sql: String, params: Vec<Value>) -> Result<Vec<Value>, String> {
    db.all(&sql, &params)
}

#[tauri::command]
fn db_run(db: State<Db>, sql: String, params: Vec<Value>) -> Result<Value, String> {
    db.run(&sql, &params)
}

#[tauri::command]
fn db_batch(db: State<Db>, stmts: Vec<Stmt>) -> Result<(), String> {
    let v: Vec<(String, Vec<Value>)> = stmts.into_iter().map(|s| (s.sql, s.params)).collect();
    db.batch(&v)
}

#[tauri::command]
fn data_dir(dd: State<DataDir>) -> String {
    dd.0.to_string_lossy().into_owned()
}

#[tauri::command(async)]
fn backup_create(db: State<Db>, dd: State<DataDir>, dest: String) -> Result<(), String> {
    db.checkpoint()?;
    backup::backup_create(&dd.0, Path::new(&dest))
}

#[tauri::command(async)]
fn backup_auto(db: State<Db>, dd: State<DataDir>, label: String) -> Result<String, String> {
    let label: String = label.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    db.checkpoint()?;
    backup::auto_backup(&dd.0, &label).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command(async)]
fn backup_restore(db: State<Db>, dd: State<DataDir>, src: String) -> Result<(), String> {
    db.checkpoint()?;
    backup::restore_stage(&dd.0, Path::new(&src))
}

#[tauri::command(async)]
fn read_folder_md(dir: String) -> Result<ReadResult, String> {
    files::read_folder_md(Path::new(&dir))
}

#[tauri::command(async)]
fn write_files(dir: String, files: Vec<FileEntry>) -> Result<(), String> {
    files::write_files(Path::new(&dir), &files)
}

#[tauri::command(async)]
fn photo_import(dd: State<DataDir>, sources: Vec<String>) -> ImportResult {
    photos::import_photos(&dd.0, &sources)
}

#[tauri::command(async)]
fn photo_delete(dd: State<DataDir>, file: String) -> Result<(), String> {
    photos::delete_photo_file(&dd.0, &file)
}

#[tauri::command(async)]
fn reveal_in_folder(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        if !Path::new(&path).exists() {
            return Err("file not found".into());
        }
        // One argument, no shell: Explorer opens with the file selected.
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", path))
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("not supported".into())
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(dir.join("attachments")).map_err(|e| e.to_string())?;
            // A staged restore is applied before the database is opened.
            let _ = backup::apply_pending_restore(&dir);
            app.manage(Db::open(&dir.join("mybrain.db"))?);
            app.manage(DataDir(dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db_all,
            db_run,
            db_batch,
            data_dir,
            backup_create,
            backup_auto,
            backup_restore,
            read_folder_md,
            write_files,
            reveal_in_folder,
            photo_import,
            photo_delete,
            focus::focus_helper_call
        ])
        .run(tauri::generate_context!())
        .expect("error while running MyBrain");
}
