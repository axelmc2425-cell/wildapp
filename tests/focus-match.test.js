import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDomain, hostMatches, normalizeApp, appMatches } from "../src/modules/focus/match.js";

test("normalizeDomain", () => {
  assert.equal(normalizeDomain("https://WWW.Reddit.com/r/x?y=1"), "reddit.com");
  assert.equal(normalizeDomain("reddit.com:8080/a"), "reddit.com");
  assert.equal(normalizeDomain("reddit.com."), "reddit.com");
  assert.equal(normalizeDomain("localhost"), null);
  assert.equal(normalizeDomain("a b.com"), null);
  assert.equal(normalizeDomain("10.0.0.1"), null);
});

test("hostMatches", () => {
  assert.equal(hostMatches("old.reddit.com", "reddit.com"), true);
  assert.equal(hostMatches("reddit.com", "reddit.com"), true);
  assert.equal(hostMatches("notreddit.com", "reddit.com"), false);
});

test("normalizeApp / appMatches", () => {
  assert.equal(normalizeApp("C:\\Games\\Steam.EXE"), "steam.exe");
  assert.equal(normalizeApp("chrome"), "chrome.exe");
  assert.equal(appMatches("Chrome.exe", "chrome"), true);
  assert.equal(appMatches("firefox.exe", "chrome"), false);
});
