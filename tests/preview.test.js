import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPreview } from '../src/modules/secondbrain/preview.js';

test('raw HTML is shown as text and never as a script tag', () => {
  const html = renderPreview('<script>alert(1)</script>', new Set());
  assert.ok(html.includes('&lt;script&gt;'), html);
  assert.ok(!html.includes('<script'), html);
});

test('inline raw HTML such as an img onerror is escaped', () => {
  const html = renderPreview('hi <img src=x onerror=alert(1)> there', new Set());
  assert.ok(!html.includes('<img'), html);
});

test('javascript: links are not rendered as links', () => {
  const html = renderPreview('[click](javascript:alert(1))', new Set());
  assert.ok(!html.includes('javascript:'), html);
});

test('a resolved wikilink has class wikilink and not missing', () => {
  const html = renderPreview('[[Foo]]', new Set(['foo']));
  assert.ok(html.includes('class="wikilink"'), html);
  assert.ok(!html.includes('missing'), html);
  assert.ok(html.includes('data-title="Foo"'), html);
});

test('an unresolved wikilink has the missing class', () => {
  assert.ok(renderPreview('[[Nope]]', new Set()).includes('wikilink missing'));
});

test('wikilink alias shows the alias text and links the title', () => {
  const html = renderPreview('[[Foo|the foo]]', new Set(['foo']));
  assert.ok(html.includes('>the foo</a>'), html);
  assert.ok(html.includes('data-title="Foo"'), html);
});

test('wikilink titles with quotes are escaped in attributes', () => {
  const html = renderPreview('[[Say "hi"]]', new Set());
  assert.ok(html.includes('data-title="Say &quot;hi&quot;"'), html);
});

test('markdown renders headings and emphasis', () => {
  const html = renderPreview('# Title\n\n*em*', new Set());
  assert.ok(html.includes('<h1') && html.includes('<em>em</em>'), html);
});
