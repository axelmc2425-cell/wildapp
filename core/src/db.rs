use rusqlite::types::{Value, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde_json::{json, Map, Value as Json};
use std::path::Path;
use std::sync::Mutex;

/// One SQLite connection behind a mutex. Mirrors the JS `Db` interface.
pub struct Db {
    conn: Mutex<Connection>,
}

fn to_sql(v: &Json) -> Value {
    match v {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Integer(*b as i64),
        Json::Number(n) => match n.as_i64() {
            Some(i) => Value::Integer(i),
            None => Value::Real(n.as_f64().unwrap_or(0.0)),
        },
        Json::String(s) => Value::Text(s.clone()),
        other => Value::Text(other.to_string()),
    }
}

fn from_ref(v: ValueRef) -> Json {
    match v {
        ValueRef::Null => Json::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
        ValueRef::Blob(_) => Json::Null,
    }
}

impl Db {
    pub fn open(path: &Path) -> Result<Db, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
            .map_err(|e| e.to_string())?;
        Ok(Db { conn: Mutex::new(conn) })
    }

    pub fn all(&self, sql: &str, params: &[Json]) -> Result<Vec<Json>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let vals: Vec<Value> = params.iter().map(to_sql).collect();
        let mut rows = stmt.query(params_from_iter(vals)).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let mut m = Map::new();
            for (i, n) in names.iter().enumerate() {
                m.insert(n.clone(), from_ref(row.get_ref(i).map_err(|e| e.to_string())?));
            }
            out.push(Json::Object(m));
        }
        Ok(out)
    }

    pub fn run(&self, sql: &str, params: &[Json]) -> Result<Json, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let vals: Vec<Value> = params.iter().map(to_sql).collect();
        let changes = conn.execute(sql, params_from_iter(vals)).map_err(|e| e.to_string())?;
        Ok(json!({ "lastInsertId": conn.last_insert_rowid(), "changes": changes }))
    }

    /// All statements in one transaction; any failure rolls everything back.
    pub fn batch(&self, stmts: &[(String, Vec<Json>)]) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for (sql, params) in stmts {
            let vals: Vec<Value> = params.iter().map(to_sql).collect();
            tx.execute(sql, params_from_iter(vals)).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// Flush the WAL so the database file is complete on its own (used before backup).
    pub fn checkpoint(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_db() -> (Db, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("mybrain-test-{}-{:?}", std::process::id(), std::thread::current().id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.db");
        let _ = std::fs::remove_file(&p);
        (Db::open(&p).unwrap(), p)
    }

    #[test]
    fn run_and_all_round_trip() {
        let (db, _) = temp_db();
        db.run("CREATE TABLE n(id INTEGER PRIMARY KEY, t TEXT)", &[]).unwrap();
        let r = db.run("INSERT INTO n(t) VALUES (?)", &[json!("hi")]).unwrap();
        assert_eq!(r["lastInsertId"], 1);
        let rows = db.all("SELECT id, t FROM n", &[]).unwrap();
        assert_eq!(rows[0]["t"], "hi");
    }

    #[test]
    fn batch_rolls_back_on_failure() {
        let (db, _) = temp_db();
        db.run("CREATE TABLE n(id INTEGER PRIMARY KEY, t TEXT)", &[]).unwrap();
        let res = db.batch(&[
            ("INSERT INTO n(t) VALUES ('a')".into(), vec![]),
            ("INSERT INTO missing VALUES (1)".into(), vec![]),
        ]);
        assert!(res.is_err());
        assert_eq!(db.all("SELECT * FROM n", &[]).unwrap().len(), 0);
    }
}
