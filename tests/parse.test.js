import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLinks, extractTags } from '../src/modules/secondbrain/parse.js';

test('extractLinks dedupes case-insensitively, handles aliases and ignores empty links', () => {
  assert.deepEqual(extractLinks('see [[Foo]] and [[foo|x]] and [[ ]]'), ['Foo']);
});
test('extractLinks ignores links inside fenced code blocks', () => {
  assert.deepEqual(extractLinks('```\n[[Hidden]]\n```\n[[Shown]]'), ['Shown']);
});
test('extractLinks trims titles', () => {
  assert.deepEqual(extractLinks('[[  Spaced out  ]]'), ['Spaced out']);
});
test('extractTags lowercases, supports slashes and skips URL fragments', () => {
  assert.deepEqual(extractTags('#Idea and https://x.com/#frag and #a/b'), ['idea', 'a/b']);
});
test('extractTags ignores headings and code blocks', () => {
  assert.deepEqual(extractTags('# Heading\n```\n#nope\n```\n#yes'), ['yes']);
});
