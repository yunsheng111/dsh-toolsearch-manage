// Unit tests for the pure decision layer: tier classification, rule priority,
// guard text, catalog rendering, search ranking, discovery folding, and the
// patch writer. No host, no network, no profile file.
//
// Run: node --test test/

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compileSet,
  classify,
  parseRule,
  compileGlob,
  guardDecision,
  projectTools,
  resolveTiers,
  targetOf,
  uniqueOwner,
  isTier,
} from '../lib/policy.js';
import { buildGroupRow, renderCatalogText, truncate, promptSection, TextCache, CATALOG_SECTION_NAME, guidanceText, toolNameSummary } from '../lib/catalog.js';
import { buildIndex, searchIndex, tokenize, stemToken, parseQuery } from '../lib/search.js';
import { createState, discover, seed, touch, evict, versionOf, parseDiscoveredMeta, discoveredFromMessages, foldEvent, META_PROTOCOL, discoveryProjection } from '../lib/discovery.js';
import { trimSdkText } from '../lib/ptc.js';
import { entryKind, isMcp } from '../lib/store.js';
import {
  splitPatchAroundManaged,
  removeOutsideMcpRows,
  managedBlockYaml,
  handoverBlockYaml,
  entryRowConfig,
  stripPluginOwned,
  parseNativeMcpEntries,
  stitchPatch,
} from '../lib/patch.js';

const MARKERS = { start: '# START', end: '# END' };

// ── policy ────────────────────────────────────────────────────────────────

test('parseRule recognizes the three rule shapes', () => {
  assert.deepEqual(parseRule('bash'), { wildcard: false, pattern: 'bash', target: 'id' });
  assert.deepEqual(parseRule('mcp__github__*'), { wildcard: true, pattern: 'mcp__github__*', target: 'id' });
  assert.deepEqual(parseRule('server:github:*'), { wildcard: true, pattern: 'github', target: 'server' });
  assert.deepEqual(parseRule('server:github'), { wildcard: false, pattern: 'github', target: 'server' });
  assert.deepEqual(parseRule('  bash  '), { wildcard: false, pattern: 'bash', target: 'id' });
});

test('compileGlob anchors and escapes', () => {
  const glob = compileGlob('mcp__a__*');
  assert.equal(glob.test('mcp__a__b'), true);
  assert.equal(glob.test('xmcp__a__b'), false);
  // Dots and brackets are literals, not regex syntax.
  assert.equal(compileGlob('a.b').test('axb'), false);
});

test('classify follows the seven-step priority', () => {
  const target = { id: 'mcp__github__get_file', name: 'mcp__github__get_file', server: 'github' };
  const compiled = compileSet({
    eager: ['mcp__github__*'],
    'on-demand': ['mcp__github__get_file'],
    disabled: ['server:github:*'],
  });
  // disabled beats everything, including the exact on-demand rule.
  assert.equal(classify(compiled, target), 'disabled');

  const noDisabled = compileSet({ eager: ['mcp__github__*'], 'on-demand': ['mcp__github__get_file'] });
  // Exact on-demand beats the wider eager glob: a UI pin must not be overridden.
  assert.equal(classify(noDisabled, target), 'on-demand');

  // Default is eager when nothing matches.
  assert.equal(classify(compileSet({}), target), 'eager');
});

test('meta tools are always eager', () => {
  const compiled = compileSet({ disabled: ['tool_search'] });
  assert.equal(classify(compiled, { id: 'tool_search', name: 'tool_search' }, new Set(['tool_search'])), 'eager');
});

test('classify matches a bare built-in name against its own id', () => {
  const compiled = compileSet({ disabled: ['web_fetch'] });
  assert.equal(classify(compiled, { id: 'web_fetch', name: 'web_fetch' }), 'disabled');
});

test('uniqueOwner refuses an ambiguous prefix', () => {
  const servers = new Set(['a', 'a__b']);
  assert.equal(uniqueOwner('mcp__a__b__x', servers), undefined); // both prefixes match
  assert.equal(uniqueOwner('mcp__a__y', servers), 'a');
  assert.equal(uniqueOwner('bash', servers), undefined);
  assert.equal(targetOf({ name: 'mcp__a__b__x' }, servers).server, undefined);
});

test('resolveTiers prefers a stored entry tier over a config rule', () => {
  const entries = [
    { kind: 'mcp', name: 'github', tier: 'disabled' },
    { kind: 'builtin', name: 'bash', tier: 'on-demand' },
  ];
  const rules = compileSet({ eager: ['server:github:*'], disabled: ['bash'] });
  const resolved = resolveTiers({
    schemas: [{ name: 'mcp__github__get_file' }, { name: 'bash' }, { name: 'read' }],
    entries,
    rules,
    metaTools: new Set(),
  });
  // The stored tier is the operator's own click; it wins over both the eager
  // server rule and the default.
  assert.equal(resolved.get('mcp__github__get_file').tier, 'disabled');
  assert.equal(resolved.get('bash').tier, 'on-demand');
  assert.equal(resolved.get('read').tier, 'eager');
});

test('guardDecision instructs for on-demand and stays silent for disabled', () => {
  const deferred = guardDecision('mcp__a__b', 'on-demand', 'tool_search');
  assert.match(deferred, /tool_search/);
  assert.match(deferred, /mcp__a__b/);
  assert.match(deferred, /select|exact name/);

  const disabled = guardDecision('bash', 'disabled', 'tool_search');
  assert.match(disabled, /disabled/);
  // A disabled tool must not be advertised, so the pointer is absent.
  assert.doesNotMatch(disabled, /tool_search/);

  assert.equal(guardDecision('read', 'eager', 'tool_search'), undefined);
});

test('projectTools removes only the named tools and returns the same object otherwise', () => {
  const assembly = { tools: [{ name: 'a' }, { name: 'b' }], sections: [] };
  assert.equal(projectTools(assembly, new Set()), assembly);
  const filtered = projectTools(assembly, new Set(['a']));
  assert.deepEqual(filtered.tools, [{ name: 'b' }]);
  // An unrelated name leaves the assembly untouched.
  assert.equal(projectTools(assembly, new Set(['zzz'])), assembly);
});

test('isTier accepts exactly the three tiers', () => {
  assert.equal(isTier('eager'), true);
  assert.equal(isTier('resident'), false);
  assert.equal(isTier(undefined), false);
});

// ── catalog ───────────────────────────────────────────────────────────────

test('truncate is budget-correct at small limits', () => {
  assert.equal(truncate('abcdef', 4), 'a...');
  assert.equal(truncate('abc', 4), 'abc');
  // Below 4 the ellipsis does not fit; it must not return MORE than asked.
  assert.equal(truncate('abcdef', 3), 'abc');
  assert.equal(truncate('  a   b  ', 10), 'a b');
});

test('buildGroupRow returns null with nothing deferred', () => {
  const options = { toolDescriptionMaxLength: 80, catalogDescriptionMaxLength: 300, granularity: 'server' };
  assert.equal(buildGroupRow({ name: 'x', description: '', notes: '', tools: [], options }), null);
  const row = buildGroupRow({ name: 'x', description: 'search', notes: '', tools: [{ name: 'mcp__x__t', description: 'does a thing' }], options });
  assert.equal(row.name, 'x');
  assert.equal(row.tools.length, 1);
});

test('publicToolName hashes only real names, never a placeholder', async () => {
  // Observed live: `mcp_load` printed
  // `callable directly as mcp__chrome-devtools___tool__77b88114da2b` because the
  // header interpolated a `<tool>` placeholder through publicToolName(), which
  // hashes anything that breaks the function-name contract. A model cannot
  // correct that string into a real tool.
  const { publicToolName } = await import('../lib/mcp-connection.js');
  assert.equal(publicToolName('github', 'get_file'), 'mcp__github__get_file');
  // A dash is legal in a function name, so it is kept, not normalised.
  assert.equal(publicToolName('chrome-devtools', 'click'), 'mcp__chrome-devtools__click');
  // The placeholder WOULD be hashed — which is exactly why it must never be passed.
  assert.match(publicToolName('chrome-devtools', '<tool>'), /__[0-9a-f]{12}$/);
});

test('a server with no declared description is summarised by its tool names', () => {
  // Live finding: all three MCP servers on this machine report an empty
  // serverDescription, so the catalog rendered three bare names —
  // "- `github` (on-demand): (no description)" — which tells the model nothing
  // about which server to search. Tool names are structured data every server
  // does provide.
  const row = buildGroupRow({
    name: 'chrome-devtools',
    description: '',
    notes: '',
    tools: [
      { name: 'mcp__chrome-devtools__click', description: 'Clicks an element' },
      { name: 'mcp__chrome-devtools__navigate_page', description: 'Go to a URL' },
    ],
    options: { toolDescriptionMaxLength: 80, catalogDescriptionMaxLength: 300, granularity: 'server' },
  });
  assert.match(row.description, /click/);
  assert.match(row.description, /navigate_page/);
  assert.match(row.description, /2 tools/);
  // The server prefix is stripped: repeating the server name adds nothing.
  assert.doesNotMatch(row.description, /mcp__chrome-devtools__/);
});

test('a declared description always wins over the tool-name summary', () => {
  const row = buildGroupRow({
    name: 'github',
    description: 'GitHub API access',
    notes: '',
    tools: [{ name: 'mcp__github__get_file', description: 'read a file' }],
    options: { toolDescriptionMaxLength: 80, catalogDescriptionMaxLength: 300, granularity: 'server' },
  });
  assert.equal(row.description, 'GitHub API access');
});

test('toolNameSummary truncates long inventories', () => {
  const tools = Array.from({ length: 20 }, (_, index) => ({ name: `mcp__big__tool_${index}` }));
  const summary = toolNameSummary(tools, 'big');
  assert.match(summary, /\(20 tools\)/);
  // Six names plus an ellipsis, not all twenty.
  assert.match(summary, /…/);
  assert.equal(summary.includes('tool_19'), false);
});

test('renderCatalogText lists one line per server at server level', () => {
  const options = { toolDescriptionMaxLength: 80, catalogDescriptionMaxLength: 300, granularity: 'server' };
  const row = buildGroupRow({
    name: 'grok-search-rs',
    description: 'web search',
    notes: '',
    tools: [
      { name: 'mcp__grok-search-rs__web_search', description: 'search the web' },
      { name: 'mcp__grok-search-rs__web_fetch', description: 'fetch a page' },
    ],
    options,
  });
  const text = renderCatalogText([row], 'tool_search');
  assert.match(text, /grok-search-rs/);
  // Server level: the tool lines must NOT appear.
  assert.doesNotMatch(text, /web_search/);
  assert.match(text, /tool_search/);
});

test('renderCatalogText lists tools at tool level', () => {
  const row = buildGroupRow({
    name: 'srv',
    description: 'd',
    notes: '',
    tools: [{ name: 'mcp__srv__do', description: 'does' }],
    options: { toolDescriptionMaxLength: 80, catalogDescriptionMaxLength: 300, granularity: 'tool' },
  });
  const text = renderCatalogText([row], 'tool_search');
  assert.match(text, /mcp__srv__do: does/);
});

test('prompt sections disable interpolation', () => {
  assert.equal(promptSection('x', 'text').interpolate, false);
  assert.equal(promptSection('x', 'text', 10).interpolate, false);
  assert.equal(promptSection('x', 'text', 10).order, 10);
  // A section appended inside the waterfall must not carry an order field.
  assert.equal('order' in promptSection('x', 'text'), false);
  assert.equal(CATALOG_SECTION_NAME, 'toolsearch:catalog');
});

test('every instruction names the search tool that actually registered', () => {
  // Observed on this machine: `dsh-toolbox-ui` owns `tool_search`, so this
  // plugin's tool registered as `deferred_tool_search`. Text that hard-coded
  // `tool_search` would have sent the model at a tool another plugin owns, or at
  // no tool at all. Both surfaces must follow the real name.
  const row = buildGroupRow({
    name: 'srv',
    description: 'd',
    notes: '',
    tools: [{ name: 'mcp__srv__do', description: 'does' }],
    options: { toolDescriptionMaxLength: 80, catalogDescriptionMaxLength: 300, granularity: 'server' },
  });
  const text = renderCatalogText([row], 'deferred_tool_search');
  assert.match(text, /deferred_tool_search/);
  assert.doesNotMatch(text, /`tool_search`/);

  const guidance = guidanceText('deferred_tool_search');
  assert.match(guidance, /deferred_tool_search/);
  assert.doesNotMatch(guidance, /call tool_search/);
});

test('TextCache keeps exactly two slots', () => {
  const cache = new TextCache();
  let computed = 0;
  const compute = (value) => () => {
    computed += 1;
    return value;
  };
  assert.equal(cache.get('a', compute('A')), 'A');
  assert.equal(cache.get('a', compute('A2')), 'A'); // cached, not recomputed
  assert.equal(cache.get('b', compute('B')), 'B');
  assert.equal(cache.get('c', compute('C')), 'C');
  assert.equal(computed, 3);
  // 'a' was evicted, so it is recomputed — that is the documented two-slot trade.
  assert.equal(cache.get('a', compute('A3')), 'A3');
});

// ── search ────────────────────────────────────────────────────────────────

test('tokenize handles CJK bigrams and latin words', () => {
  assert.deepEqual(tokenize('web search'), ['web', 'search']);
  assert.deepEqual(tokenize('截图工具'), ['截图', '图工', '工具']);
  assert.deepEqual(tokenize('ab-cd'), ['ab', 'cd']);
});

test('stemToken only normalizes plurals', () => {
  assert.equal(stemToken('symbols'), 'symbol');
  assert.equal(stemToken('classes'), 'class');
  assert.equal(stemToken('queries'), 'query');
  // Porter would over-stem these; the s-stemmer leaves them alone.
  assert.equal(stemToken('declared'), 'declared');
  assert.equal(stemToken('status'), 'status');
});

test('parseQuery recognizes select, filter and keywords', () => {
  assert.deepEqual(parseQuery('select:a,b').names, ['a', 'b']);
  assert.equal(parseQuery('+github file').kind, 'filter');
  assert.deepEqual(parseQuery('+github file').requiredTokens, ['github']);
  assert.equal(parseQuery('web search').kind, 'keywords');
  assert.equal(parseQuery('   ').kind, 'empty');
});

test('searchIndex returns full schemas for select: including missing names', () => {
  const index = buildIndex([
    { name: 'mcp__srv__alpha', description: 'first', parameters: { type: 'object' } },
    { name: 'mcp__srv__beta', description: 'second', parameters: { type: 'object' } },
  ]);
  const matches = searchIndex(index, 'select:mcp__srv__beta,mcp__srv__ghost', 10, false);
  assert.equal(matches.length, 2);
  assert.equal(matches[0].name, 'mcp__srv__beta');
  assert.deepEqual(matches[0].parameters, { type: 'object' });
  assert.equal(matches[0].found, true);
  assert.deepEqual(matches[1], { name: 'mcp__srv__ghost', found: false });
});

test('searchIndex ranks a name hit above a description hit', () => {
  const index = buildIndex([
    { name: 'mcp__srv__screenshot', description: 'capture the screen' },
    { name: 'mcp__srv__other', description: 'takes a screenshot of the page' },
  ]);
  const matches = searchIndex(index, 'screenshot', 10, true);
  assert.equal(matches[0].name, 'mcp__srv__screenshot');
});

test('searchIndex filter form requires the server token', () => {
  // The index and the query must use the SAME stem setting: stemming one side
  // only ("devtools" → "devtool") makes the match strictly worse than neither.
  const index = buildIndex(
    [
      { name: 'mcp__chrome-devtools__click', description: 'click an element' },
      { name: 'mcp__other__click', description: 'click an element' },
    ],
    true,
  );
  const matches = searchIndex(index, '+chrome-devtools click', 10, true);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].name, 'mcp__chrome-devtools__click');
  // A mismatched stem setting is exactly the failure the invariant prevents.
  const unstemed = buildIndex([{ name: 'mcp__chrome-devtools__click', description: 'click' }], false);
  assert.equal(searchIndex(unstemed, '+chrome-devtools click', 10, true).length, 0);
});

test('searchIndex caps at maxResults', () => {
  const schemas = Array.from({ length: 20 }, (_, i) => ({ name: `tool_${i}`, description: 'thing to do' }));
  const index = buildIndex(schemas);
  assert.equal(searchIndex(index, 'thing', 5).length, 5);
});

// ── discovery ─────────────────────────────────────────────────────────────

test('discover and evict keep the newest and drop the coldest', () => {
  const state = createState();
  discover(state, ['a', 'b', 'c', 'd']);
  assert.equal(state.discovered.size, 4);
  touch(state, 'a'); // a becomes the newest
  evict(state, 2);
  // size 4, cap 2, remove = min(2, 2) = 2 → the two coldest go: b, c.
  assert.deepEqual([...state.discovered.keys()].sort(), ['a', 'd']);
});

test('evict never removes more than half at once', () => {
  const state = createState();
  discover(state, ['a', 'b', 'c']);
  evict(state, 2);
  // size 3, cap 2 → remove = min(1, 1) = 1.
  assert.equal(state.discovered.size, 2);
});

test('touch does not advance the version', () => {
  const state = createState();
  discover(state, ['a']);
  const before = versionOf(state);
  touch(state, 'a');
  assert.equal(versionOf(state), before);
  touch(state, 'missing');
  assert.equal(state.discovered.has('missing'), false);
});

test('seed is idempotent for already-known names', () => {
  const state = createState();
  seed(state, ['a', 'b']);
  seed(state, ['a', 'b']);
  assert.equal(state.discovered.size, 2);
});

test('parseDiscoveredMeta rejects foreign payloads', () => {
  assert.equal(parseDiscoveredMeta({ protocol: 'other/v1', matches: [] }), undefined);
  assert.equal(parseDiscoveredMeta(null), undefined);
  assert.deepEqual(parseDiscoveredMeta({ protocol: META_PROTOCOL, discoveredTools: ['a'] }), ['a']);
});

test('foldEvent returns the same reference when nothing was added', () => {
  const result = { protocol: META_PROTOCOL, discoveredTools: ['a'] };
  const event = (text) => ({ type: 'tool/result', data: { message: { content: [{ type: 'text', text }] } } });
  const first = foldEvent({ discovered: [] }, event(JSON.stringify(result)), { toolName: 'tool_search', max: 20 });
  assert.deepEqual(first.discovered, ['a']);
  const second = foldEvent(first, event(JSON.stringify(result)), { toolName: 'tool_search', max: 20 });
  assert.equal(second, first);
  const ignored = foldEvent(first, { type: 'turn/start', data: {} }, { toolName: 'tool_search', max: 20 });
  assert.equal(ignored, first);
});

test('foldEvent reads the PTC dispatch shape', () => {
  const value = { protocol: META_PROTOCOL, discoveredTools: ['mcp__a__b'] };
  const event = { type: 'tool/ptc-dispatch', data: { name: 'tool_search', content: [{ type: 'text', text: JSON.stringify(value) }] } };
  const folded = foldEvent({ discovered: [] }, event, { toolName: 'tool_search', max: 20 });
  assert.deepEqual(folded.discovered, ['mcp__a__b']);
  // A dispatch of a DIFFERENT tool is not ours.
  const other = { ...event, data: { ...event.data, name: 'other' } };
  assert.deepEqual(foldEvent({ discovered: [] }, other, { toolName: 'tool_search', max: 20 }), { discovered: [] });
});

test('discoveredFromMessages ignores error results', () => {
  const value = { protocol: META_PROTOCOL, discoveredTools: ['a'] };
  const messages = [
    { role: 'tool', isError: true, content: [{ type: 'text', text: JSON.stringify(value) }] },
    { role: 'tool', content: [{ type: 'text', text: JSON.stringify({ ...value, discoveredTools: ['b'] }) }] },
  ];
  assert.deepEqual([...discoveredFromMessages(messages)], ['b']);
});

test('the projection definition is host-only and versioned', () => {
  // The definition only needs `z` for its state schema; the shape is what
  // matters here, not schema validation.
  let schemaBuilt = false;
  const z = {
    object: () => {
      schemaBuilt = true;
      return {};
    },
    array: () => ({}),
    string: () => ({}),
  };
  const definition = discoveryProjection({ z, toolName: 'tool_search', max: 20 });
  assert.equal(definition.stateVersion, 1);
  assert.equal(definition.key, 'toolSearchManageDiscoveries');
  assert.deepEqual(definition.init(), { discovered: [] });
  // No `wire`: this state never reaches the Client.
  assert.equal(definition.wire, undefined);
  assert.equal(schemaBuilt, true);
});

// ── PTC manual trimming ───────────────────────────────────────────────────

test('trimSdkText refuses when the premise does not hold', () => {
  const render = (schemas) => schemas.map((entry) => entry.name).join(',');
  const schemas = [{ name: 'a' }, { name: 'b' }];
  // Host text differs from what we would render → premise mismatch, no trim.
  assert.deepEqual(trimSdkText({ hostText: 'something else', schemas, drop: new Set(['a']), render }), { ok: false, reason: 'premise-mismatch' });
  // Nothing to drop → no pointless replacement.
  assert.deepEqual(trimSdkText({ hostText: 'a,b', schemas, drop: new Set(['zzz']), render }), { ok: false, reason: 'no-drop' });
  // Premise holds and something drops → success.
  const ok = trimSdkText({ hostText: 'a,b', schemas, drop: new Set(['a']), render });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, 'b');
  assert.equal(ok.dropped, 1);
});

test('trimSdkText forwards programFormat only when provided', () => {
  const seen = [];
  const render = (schemas, format) => {
    seen.push(format);
    return schemas.map((entry) => entry.name).join(',');
  };
  // Two renders per attempt: the self-check over the full set, then the subset.
  trimSdkText({ hostText: 'a', schemas: [{ name: 'a' }], drop: new Set(['a']), render });
  assert.deepEqual(seen, [undefined, undefined]);
  seen.length = 0;
  trimSdkText({ hostText: 'a', schemas: [{ name: 'a' }], drop: new Set(['a']), render, programFormat: 'function-body' });
  assert.deepEqual(seen, ['function-body', 'function-body']);
});

// ── registry migration ────────────────────────────────────────────────────

test('a v1 entry (no kind) reads as an MCP server', () => {
  const legacy = { id: 'github', name: 'github', tier: 'eager' };
  assert.equal(entryKind(legacy), 'mcp');
  assert.equal(isMcp(legacy), true);
});

test('a builtin entry is not an MCP server', () => {
  const entry = { kind: 'builtin', name: 'bash', tier: 'on-demand' };
  assert.equal(entryKind(entry), 'builtin');
  assert.equal(isMcp(entry), false);
});

test('an unknown kind falls back to mcp rather than vanishing', () => {
  assert.equal(entryKind({ kind: 'mystery' }), 'mcp');
});

// ── patch writer ──────────────────────────────────────────────────────────

test('splitPatchAroundManaged separates prefix, middle and suffix', () => {
  const text = ['# top', 'a: 1', MARKERS.start, '- insert: []', MARKERS.end, '# after', 'b: 2'].join('\n');
  const parts = splitPatchAroundManaged(text, MARKERS);
  assert.match(parts.prefix, /a: 1/);
  assert.match(parts.middle, /insert/);
  assert.match(parts.suffix, /b: 2/);
});

test('managedBlockYaml writes one disabled row per MCP entry', () => {
  const block = managedBlockYaml(
    [
      { kind: 'mcp', name: 'github', tier: 'eager', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] },
      { kind: 'builtin', name: 'bash', tier: 'on-demand' },
    ],
    MARKERS,
  );
  assert.match(block, /Managed|START/);
  assert.match(block, /serverName: github/);
  assert.match(block, /disabled: true/);
  // A built-in has no connection, so it must not produce a patch row.
  assert.doesNotMatch(block, /bash/);
});

test('managedBlockYaml refuses a duplicate loader id', () => {
  assert.throws(
    () =>
      managedBlockYaml(
        [
          { kind: 'mcp', name: 'a', transport: 'stdio', command: 'x', systemEntryId: 'same' },
          { kind: 'mcp', name: 'b', transport: 'stdio', command: 'y', systemEntryId: 'same' },
        ],
        MARKERS,
      ),
    /duplicate loader id/,
  );
});

test('entryRowConfig strips plugin-owned fields from a raw config', () => {
  const config = entryRowConfig({
    name: 'github',
    kind: 'mcp',
    rawConfig: { serverName: 'github', defer: true, tier: 'eager', command: 'npx', reconnect: { enabled: true } },
  });
  // `defer` and `tier` are expressed by the registry now; leaving them would
  // hand one decision to two owners.
  assert.equal('defer' in config, false);
  assert.equal('tier' in config, false);
  // Unmodelled native fields survive.
  assert.deepEqual(config.reconnect, { enabled: true });
  assert.equal(config.serverName, 'github');
});

test('stripPluginOwned leaves everything else intact', () => {
  assert.deepEqual(stripPluginOwned({ a: 1, defer: true, tier: 'eager' }), { a: 1 });
});

test('handoverBlockYaml enables rows but keeps an off choice', () => {
  const block = handoverBlockYaml(
    [
      { kind: 'mcp', name: 'on', tier: 'eager', transport: 'stdio', command: 'x' },
      { kind: 'mcp', name: 'off', tier: 'disabled', transport: 'stdio', command: 'y' },
    ],
    '# HANDOVER',
  );
  assert.match(block, /# HANDOVER/);
  const rows = parseNativeMcpEntries(block);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].disabled, undefined);
  assert.equal(rows[1].disabled, true);
});

test('parseNativeMcpEntries ignores foreign and unparseable text', () => {
  assert.deepEqual(parseNativeMcpEntries('not yaml: [unclosed'), []);
  assert.deepEqual(parseNativeMcpEntries('- insert:\n    - id: a\n      name: other-plugin\n'), []);
  const found = parseNativeMcpEntries('- insert:\n    - id: a\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        serverName: s\n');
  assert.equal(found.length, 1);
  assert.equal(found[0].config.serverName, 's');
});

test('removeOutsideMcpRows excises a claimed row and leaves foreign rows', () => {
  const text = [
    '- id: keep',
    '  name: something-else',
    '- insert:',
    '    - id: claimed',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        serverName: claimed',
    '    - id: foreign',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        serverName: foreign',
  ].join('\n');
  const next = removeOutsideMcpRows(text, -1, -1, new Set(['claimed']));
  assert.doesNotMatch(next, /serverName: claimed/);
  assert.match(next, /serverName: foreign/);
  assert.match(next, /name: something-else/);
});

test('stitchPatch keeps the file tail', () => {
  const next = stitchPatch('# head', `# START\n- insert: []\n# END\n`, '', '# tail\n');
  assert.match(next, /# head/);
  assert.match(next, /# tail/);
});
