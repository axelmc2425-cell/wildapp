//! Effective clock: never moves backwards, and resists the wall clock being set back.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveClock {
    high_water_ms: i64,
    /// Monotonic reading taken when `high_water_ms` was last set; `None` until the first call.
    mono_at_high_water: Option<i64>,
}

impl EffectiveClock {
    pub fn new(persisted_high_water_ms: i64) -> Self {
        Self { high_water_ms: persisted_high_water_ms, mono_at_high_water: None }
    }

    /// `max(wall, high_water + (mono - mono_at_high_water))`. The first call after `new`
    /// anchors the monotonic clock, so it returns `max(wall, high_water)`.
    pub fn now(&mut self, wall_ms: i64, mono_ms: i64) -> i64 {
        let projected = match self.mono_at_high_water {
            Some(anchor) => self.high_water_ms.saturating_add((mono_ms - anchor).max(0)),
            None => self.high_water_ms,
        };
        let value = wall_ms.max(projected);
        self.high_water_ms = value;
        self.mono_at_high_water = Some(mono_ms);
        value
    }

    /// Recovery from a bogus far-future high-water mark: continues from the current wall clock.
    pub fn reset(&mut self, wall_ms: i64, mono_ms: i64) {
        self.high_water_ms = wall_ms;
        self.mono_at_high_water = Some(mono_ms);
    }

    /// Value to persist so a restart cannot go below it.
    pub fn high_water_ms(&self) -> i64 {
        self.high_water_ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wall_set_back_one_hour_is_ignored() {
        let mut c = EffectiveClock::new(0);
        assert_eq!(c.now(1_000_000, 5_000), 1_000_000);
        assert_eq!(c.now(1_000_000 - 3_600_000 + 10_000, 15_000), 1_010_000);
    }

    #[test]
    fn wall_forward_advances() {
        let mut c = EffectiveClock::new(0);
        c.now(1_000, 0);
        assert_eq!(c.now(9_000_000, 10), 9_000_000);
        assert_eq!(c.high_water_ms(), 9_000_000);
    }

    #[test]
    fn fresh_clock_never_below_persisted() {
        let mut c = EffectiveClock::new(5_000_000);
        assert_eq!(c.now(1_000, 77), 5_000_000);
        assert_eq!(c.now(1_000, 177), 5_000_100);
    }

    #[test]
    fn reset_returns_to_wall_time() {
        let mut c = EffectiveClock::new(0);
        c.now(9_000_000_000, 0); // wall was set far into the future
        assert_eq!(c.now(1_000, 10), 9_000_000_010);
        c.reset(1_000, 20);
        assert_eq!(c.now(1_000, 20), 1_000);
        assert_eq!(c.now(1_500, 30), 1_500);
        assert_eq!(c.high_water_ms(), 1_500);
    }

    #[test]
    fn never_decreases_even_with_odd_inputs() {
        let mut c = EffectiveClock::new(0);
        let mut last = i64::MIN;
        for (w, m) in [(100, 10), (50, 20), (200, 5), (10, 1_000), (0, 0)] {
            let v = c.now(w, m);
            assert!(v >= last);
            last = v;
        }
    }
}
