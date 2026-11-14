use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Lock {
    None,
    Locked,
    Frozen,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Block,
    Allow,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Window {
    pub id: String,
    pub starts: i64,
    pub ends: i64,
    pub lock: Lock,
    pub mode: Mode,
    pub sites: Vec<String>,
    pub apps: Vec<String>,
    /// Absolute Windows folders whose programs are blocked (block mode only).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub app_folders: Vec<String>,
    /// Waiting period (ms) before a Locked window can be unlocked without the partner.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unlock_delay_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Allow {
    pub sites: Vec<String>,
    pub apps: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockInfo {
    pub id: String,
    pub lock: Lock,
    pub ends: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub block_sites: Vec<String>,
    pub block_apps: Vec<String>,
    /// Omitted from JSON when empty so the shared JS decide vectors stay byte-identical.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub block_folders: Vec<String>,
    pub allow: Option<Allow>,
    pub frozen: bool,
    pub locks: Vec<LockInfo>,
    /// Time limits that are used up now. Omitted from JSON when empty (shared decide vectors).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub limit_blocks: Vec<LimitBlock>,
}

/// An exceeded time limit; it blocks until `until_day` (the first day it lifts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LimitBlock {
    pub id: String,
    pub until_day: String,
}
