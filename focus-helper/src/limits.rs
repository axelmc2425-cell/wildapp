//! Portable time limits: a pool of seconds shared by apps and sites over a daily or weekly
//! period. Pure functions over day strings (`YYYY-MM-DD`); there is no time zone here.
//! Weeks start on Monday.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::lockstore::{good_item, MAX_UNLOCK_DELAY_MS, MIN_UNLOCK_DELAY_MS};
use crate::model::Lock;
use crate::sites::stems_from_domains;
use crate::usage::{days_from_civil, day_string, parse_day, DayUsage};

/// Most limits a store may hold.
pub const MAX_LIMITS: usize = 64;
/// Most apps plus sites in one limit.
pub const MAX_LIMIT_ITEMS: usize = 100;
/// Shortest cap, in seconds.
pub const MIN_CAP_SECS: u64 = 60;
/// Longest daily cap (24 h) and weekly cap (168 h), in seconds.
pub const MAX_DAILY_CAP_SECS: u64 = 24 * 3600;
pub const MAX_WEEKLY_CAP_SECS: u64 = 168 * 3600;

const MAX_ID_CHARS: usize = 64;
const MAX_NAME_CHARS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Period {
    Daily,
    Weekly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Limit {
    pub id: String,
    pub name: String,
    pub apps: Vec<String>,
    pub sites: Vec<String>,
    pub period: Period,
    pub cap_secs: u64,
    /// Only `None` and `Locked` are valid for a limit.
    pub lock: Lock,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unlock_delay_ms: Option<i64>,
}

/// Checks a limit; the error is a short reason code.
pub fn validate_limit(l: &Limit) -> Result<(), String> {
    let bad = |s: &str| Err(s.to_string());
    if l.id.is_empty() || l.id.chars().count() > MAX_ID_CHARS || l.id.chars().any(|c| c.is_control()) {
        return bad("bad-id");
    }
    if l.name.trim().is_empty() || l.name.chars().count() > MAX_NAME_CHARS || l.name.chars().any(|c| c.is_control()) {
        return bad("bad-name");
    }
    let n = l.apps.len() + l.sites.len();
    if n == 0 {
        return bad("no-items");
    }
    if n > MAX_LIMIT_ITEMS {
        return bad("too-many-items");
    }
    if !l.apps.iter().all(|a| good_item(a, false)) || !l.sites.iter().all(|s| good_item(s, true)) {
        return bad("bad-item");
    }
    let max = match l.period {
        Period::Daily => MAX_DAILY_CAP_SECS,
        Period::Weekly => MAX_WEEKLY_CAP_SECS,
    };
    if !(MIN_CAP_SECS..=max).contains(&l.cap_secs) {
        return bad("bad-cap");
    }
    let delay_ok = match (l.lock, l.unlock_delay_ms) {
        (Lock::Locked, Some(d)) => (MIN_UNLOCK_DELAY_MS..=MAX_UNLOCK_DELAY_MS).contains(&d),
        (Lock::Locked, None) => false,
        (Lock::None, d) => d.is_none(),
        (Lock::Frozen, _) => return bad("bad-lock"),
    };
    if delay_ok { Ok(()) } else { bad("bad-delay") }
}

/// Day of week of a valid day string, 0 = Monday ... 6 = Sunday.
pub fn weekday_monday_based(day: &str) -> Option<u8> {
    let (y, m, d) = parse_day(day)?;
    // 1970-01-01 was a Thursday (3 when Monday is 0).
    Some((days_from_civil(y, m, d) + 3).rem_euclid(7) as u8)
}

/// Inverse of `days_from_civil`: (year, month, day) for days since 1970-01-01.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn string_of(n: i64) -> String {
    let (y, m, d) = civil_from_days(n);
    day_string(y as u16, m as u16, d as u16)
}

fn number_of(day: &str) -> Option<i64> {
    let (y, m, d) = parse_day(day)?;
    Some(days_from_civil(y, m, d))
}

/// Inclusive `(from_day, to_day)` of the period containing `current_day`.
pub fn period_days(period: Period, current_day: &str) -> Option<(String, String)> {
    let n = number_of(current_day)?;
    let from = match period {
        Period::Daily => n,
        Period::Weekly => n - i64::from(weekday_monday_based(current_day)?),
    };
    Some((string_of(from), current_day.to_string()))
}

/// The first day on which a limit that is over its cap on `current_day` lifts.
pub fn period_ends_day(period: Period, current_day: &str) -> Option<String> {
    let n = number_of(current_day)?;
    let next = match period {
        Period::Daily => n + 1,
        Period::Weekly => n - i64::from(weekday_monday_based(current_day)?) + 7,
    };
    Some(string_of(next))
}

/// Whether the recorded site `label` belongs to the limit domain `domain`.
///
/// Usage rows label a browser sample with a canonical name from `SITE_MAP` (`YouTube`,
/// `Stack Overflow`) or, for the owner's own list, the lowercase domain stem (`bbc`). A label
/// matches a limit domain when, lowercased with spaces removed, it equals the domain's stem
/// (`stems_from_domains`, so `www.bbc.co.uk` -> `bbc`) or the whole lowercase domain
/// (`Booking.com` <-> `booking.com`). Equality only: a label that merely contains the stem
/// does not match. The overflow bucket `other` never matches. Stems under 3 characters are
/// dropped by `stems_from_domains`, so such domains (`x.com`) cannot be limited by label.
fn site_matches(label: &str, domain: &str, stem: Option<&str>) -> bool {
    let l: String = label.to_lowercase().chars().filter(|c| *c != ' ').collect();
    if l.is_empty() || l == "other" {
        return false;
    }
    stem == Some(l.as_str()) || l == domain.trim().trim_matches('.').to_lowercase()
}

/// Seconds the limit's apps and sites used inside the period that contains `current_day`
/// (`period_days`). Rows outside that period are ignored, a missing current-day row counts
/// zero, and an invalid `current_day` counts zero. Each distinct item counts once; browsing
/// that matched no site never counts.
///
/// Site matching: see `site_matches`. A usage label (canonical `SITE_MAP` name or lowercase
/// own-list stem) matches a limit domain when, lowercased with spaces removed, it equals the
/// domain's stem or the whole lowercase domain; equality only, `other` never matches. Known
/// limits: stems under 3 characters (`x.com`) cannot match, and multi-word labels such as
/// `Google Docs` cannot match `docs.google.com` (its stem is `google`).
pub fn used_secs(l: &Limit, days: &[DayUsage], current_day: &str) -> u64 {
    let Some((from, to)) = period_days(l.period, current_day) else { return 0 };
    let apps: BTreeSet<String> = l.apps.iter().map(|a| a.to_lowercase()).collect();
    let domains: BTreeSet<String> = l.sites.iter().map(|s| s.trim().to_lowercase()).collect();
    let stems: Vec<(String, Option<String>)> = domains
        .iter()
        .map(|d| (d.clone(), stems_from_domains(&[d.clone()]).into_iter().next()))
        .collect();
    let mut total = 0u64;
    for d in days.iter().filter(|d| d.day.as_str() >= from.as_str() && d.day.as_str() <= to.as_str()) {
        if number_of(&d.day).is_none() {
            continue;
        }
        for (name, secs) in &d.apps {
            if apps.contains(&name.to_lowercase()) {
                total = total.saturating_add(*secs);
            }
        }
        for (label, secs) in &d.sites {
            if stems.iter().any(|(dom, stem)| site_matches(label, dom, stem.as_deref())) {
                total = total.saturating_add(*secs);
            }
        }
    }
    total
}

/// True when replacing `old` with `new` weakens it: a higher cap, any item removed, another
/// period, or the lock dropped. (Deleting is the caller's case.) Items compare lowercase.
pub fn is_weaker(old: &Limit, new: &Limit) -> bool {
    let set = |v: &[String]| -> BTreeSet<String> { v.iter().map(|s| s.trim().to_lowercase()).collect() };
    new.cap_secs > old.cap_secs
        || new.period != old.period
        || (old.lock == Lock::Locked && new.lock != Lock::Locked)
        || !set(&old.apps).is_subset(&set(&new.apps))
        || !set(&old.sites).is_subset(&set(&new.sites))
}

/// Whether the pool is used up: `used_secs >= cap_secs`.
pub fn is_exceeded(l: &Limit, days: &[DayUsage], current_day: &str) -> bool {
    used_secs(l, days, current_day) >= l.cap_secs
}
