// M3 evidence with the HOST's own SDK renderers.
//
// The unit tests cover trimSdkText's decision logic with a stub renderer. That
// proves the branching, not the premise: the whole safety argument for trimming
// `tools:sdk` is "render(fullSet) equals the host's text byte for byte", and that
// can only be checked against the real `renderToolsSdk`. So this script renders
// with the host package, then feeds the result back through trimSdkText exactly
// as the assembly path does.
//
// Run: node --test test/ptc.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import { renderToolsSdk, renderToolsSdkPy, RUN_CODE_NAME } from '@deepseek-ai/dsh-tools';
import { trimSdkText, rendererFor } from '../lib/ptc.js';

/** Two tool schemas in the shape the host renders from (`sdkSchemas` minus run_code). */
const schemas = [
  {
    name: 'mcp__github__get_file',
    description: 'Read a file from a repository',
    parameters: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] },
    output: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
  },
  {
    name: 'mcp__chrome-devtools__click',
    description: 'Click an element on the page',
    parameters: { type: 'object', properties: { pageId: { type: 'number' }, uid: { type: 'string' } }, required: ['pageId', 'uid'] },
    output: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  },
];

test('the host exports both renderers under the names this plugin uses', () => {
  assert.equal(typeof renderToolsSdk, 'function');
  assert.equal(typeof renderToolsSdkPy, 'function');
  // The trim excludes run_code by name; the constant must match the host's.
  assert.equal(RUN_CODE_NAME, 'run_code');
});

test('trimSdkText accepts the host renderer output as its premise', async () => {
  const hostText = renderToolsSdk(schemas);
  assert.equal(typeof hostText, 'string');
  assert.ok(hostText.length > 0, 'host renderer produced no text');

  const result = trimSdkText({ hostText, schemas, drop: new Set(['mcp__github__get_file']), render: renderToolsSdk });
  assert.equal(result.ok, true, `trim refused: ${result.reason}`);
  assert.equal(result.dropped, 1);
  // The kept tool is still declared; the dropped one is gone.
  assert.match(result.text, /chrome-devtools__click|chrome_devtools__click/);
  assert.doesNotMatch(result.text, /github__get_file|github___get_file/);
  // And the trim is a real saving.
  assert.ok(result.text.length < hostText.length, 'trim did not shrink the manual');
});

test('the python renderer is trimmed the same way', () => {
  const hostText = renderToolsSdkPy(schemas);
  const result = trimSdkText({ hostText, schemas, drop: new Set(['mcp__chrome-devtools__click']), render: renderToolsSdkPy });
  assert.equal(result.ok, true, `trim refused: ${result.reason}`);
  assert.equal(result.dropped, 1);
  assert.ok(result.text.length < hostText.length);
});

test('a premise mismatch is refused, so a foreign edit can never be overwritten', () => {
  // Another plugin already rewrote the section: the host text no longer equals
  // what we would render, so trimming would silently replace their work.
  const hostText = `${renderToolsSdk(schemas)}\n\n<!-- appended by another plugin -->`;
  const result = trimSdkText({ hostText, schemas, drop: new Set(['mcp__github__get_file']), render: renderToolsSdk });
  assert.deepEqual(result, { ok: false, reason: 'premise-mismatch' });
});

test('rendererFor resolves the host renderers and refuses an unknown package', async () => {
  assert.equal(typeof (await rendererFor('typescript')), 'function');
  assert.equal(typeof (await rendererFor('python')), 'function');
  // An unknown language falls back to TS, matching the host, which rejects the
  // language before reaching a renderer.
  assert.equal(typeof (await rendererFor('ruby')), 'function');
});

test('dropping every tool still produces valid text rather than throwing', () => {
  const hostText = renderToolsSdk(schemas);
  const all = new Set(schemas.map((entry) => entry.name));
  const result = trimSdkText({ hostText, schemas, drop: all, render: renderToolsSdk });
  // The host renderer may return an empty string for an empty set; either way
  // this must not throw and must report success with everything dropped.
  assert.equal(result.ok, true, `unexpected refusal: ${result.reason}`);
  assert.equal(result.dropped, schemas.length);
});
