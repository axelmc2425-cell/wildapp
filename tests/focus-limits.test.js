import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_DURATION_MS, validateWindow, extendWindow } from "../src/modules/focus/limits.js";

const DAY = 86400000;
const win = (over = {}) => ({ id: "w1", starts: 1000, ends: 2000, lock: "none", mode: "block", sites: [], apps: [], ...over });

test("MAX_DURATION_MS values", () => {
  assert.equal(MAX_DURATION_MS.locked, 7 * DAY);
  assert.equal(MAX_DURATION_MS.frozen, DAY);
});

test("validateWindow locked cap", () => {
  assert.deepEqual(validateWindow(win({ lock: "locked", ends: 1000 + 7 * DAY })), { ok: true });
  assert.deepEqual(validateWindow(win({ lock: "locked", ends: 1000 + 7 * DAY + 1 })), { ok: false, reason: "too-long" });
});

test("validateWindow frozen cap", () => {
  assert.deepEqual(validateWindow(win({ lock: "frozen", ends: 1000 + DAY })), { ok: true });
  assert.deepEqual(validateWindow(win({ lock: "frozen", ends: 1000 + DAY + 1 })), { ok: false, reason: "too-long" });
});

test("validateWindow none has no cap", () => {
  assert.deepEqual(validateWindow(win({ ends: 1000 + 365 * DAY })), { ok: true });
});

test("validateWindow bad times and lock", () => {
  assert.deepEqual(validateWindow(win({ ends: 1000 })), { ok: false, reason: "bad-times" });
  assert.deepEqual(validateWindow(win({ ends: NaN })), { ok: false, reason: "bad-times" });
  assert.deepEqual(validateWindow(win({ starts: Infinity, ends: Infinity })), { ok: false, reason: "bad-times" });
  assert.deepEqual(validateWindow(win({ lock: "weird" })), { ok: false, reason: "bad-lock" });
});

test("extendWindow returns new object", () => {
  const w = win({ lock: "locked" });
  const e = extendWindow(w, 3000);
  assert.notEqual(e, w);
  assert.equal(e.ends, 3000);
  assert.equal(w.ends, 2000);
  assert.equal(e.id, w.id);
});

test("extendWindow rejects shortening", () => {
  assert.throws(() => extendWindow(win(), 2000), /cannot shorten/);
  assert.throws(() => extendWindow(win(), 1500), /cannot shorten/);
});

test("extendWindow enforces cap from starts", () => {
  const w = win({ lock: "frozen" });
  assert.equal(extendWindow(w, 1000 + DAY).ends, 1000 + DAY);
  assert.throws(() => extendWindow(w, 1000 + DAY + 1), /exceeds maximum duration/);
});
