#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use mybrain_core::db::Db;
use serde::Deserialize;
use serde_json::Value;
use tauri::{Manager, State};

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

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(dir.join("attachments")).map_err(|e| e.to_string())?;
            app.manage(Db::open(&dir.join("mybrain.db"))?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![db_all, db_run, db_batch])
        .run(tauri::generate_context!())
        .expect("error while running MyBrain");
}
