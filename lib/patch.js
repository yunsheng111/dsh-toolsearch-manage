// The single writer of the profile's `cordis.patch.yml`.
//
// Three plugins used to rewrite the same `@deepseek-ai/dsh-mcp-client` rows with
// three different strategies and no lock, so the last writer won and the others
// silently lost their edits. This module is that writer consolidated: the
// marker-delimited-block strategy from `dsh-skill-mcp-manager@1.2.2` (the only
// one of the three that touches just its own span, leaving the rest of the file
// byte-for-byte identical), plus one fix that plugin got wrong.
//
// The fix: the previous implementation built a shadow row as
// `{ ...entry.rawConfig, serverName }`, which copies a native `defer: true`
// straight back into the managed block. `defer` is no longer a patch field at
// all — the registry's `tier` expresses it — so it is stripped on import and on
// write. Leaving it would hand the same decision to two owners again.

import { parse, stringify } from 'yaml';

export const MCP_PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client';

// Fields this plugin owns in the registry and must never round-trip into a
// patch row: `defer`/`tier` are expressed by the registry, and `toolCallTimeoutMs`
// is written from the entry's own field so the two cannot disagree.
const PATCH_OWNED_FIELDS = ['defer', 'tier'];

/**
 * Strip plugin-owned fields from a raw config object.
 * @param {object} rawConfig
 * @returns {object}
 */
export function stripPluginOwned(rawConfig) {
  const out = {};
  for (const [key, value] of Object.entries(rawConfig ?? {})) {
    if (PATCH_OWNED_FIELDS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

function indexAfterLine(text, index) {
  const newline = text.indexOf('\n', index);
  return newline < 0 ? text.length : newline + 1;
}

/**
 * Split one patch file into the part before the managed span, the span itself,
 * whatever unrelated top-level blocks live inside the span, and the suffix.
 *
 * @param {string} text
 * @param {{start: string, end: string}} markers
 */
export function splitPatchAroundManaged(text, markers) {
  const start = text.indexOf(markers.start);
  if (start < 0) return { prefix: text, middle: '', relocated: '', suffix: '' };
  const afterStart = indexAfterLine(text, start);
  const end = text.indexOf(markers.end, afterStart);
  const middle = end >= 0 ? text.slice(afterStart, end) : text.slice(afterStart);
  const suffix = end >= 0 ? text.slice(indexAfterLine(text, end)) : '';
  return { prefix: text.slice(0, start), middle, relocated: extractUnrecognizedMiddle(middle), suffix };
}

// Top-level `- …` blocks in a patch-array slice. Comments and blank lines not
// attached to a block are ignored: the managed span's own comments are ours.
export function splitTopLevelPatchEntries(text) {
  const entries = [];
  let buf = [];
  const flush = () => {
    while (buf.length > 0 && buf[buf.length - 1] === '') buf.pop();
    if (buf.length === 0) return;
    entries.push(buf.join('\n'));
    buf = [];
  };
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith('- ')) {
      flush();
      buf.push(line);
    } else if (buf.length > 0) {
      buf.push(line);
    }
  }
  flush();
  return entries;
}

/**
 * Is this top-level entry ours to delete or rewrite?
 *
 * Ours is either a shadow `- insert:` whose rows are all mcp-client rows, or a
 * takeover row that is only `{ id, disabled: true }`. Anything else — oauth
 * blocks, other plugins, mixed inserts — is not rewritten, ever.
 */
export function isManagedPatchEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const keys = Object.keys(entry);
  if (typeof entry.id === 'string' && entry.id !== '' && entry.disabled === true && keys.length === 2 && keys.includes('id') && keys.includes('disabled')) {
    return true;
  }
  if (!Array.isArray(entry.insert) || entry.insert.length === 0) return false;
  if (typeof entry.id === 'string' && entry.id !== '') return false;
  return entry.insert.every((item) => item !== null && typeof item === 'object' && item.name === MCP_PLUGIN_NAME);
}

function extractUnrecognizedMiddle(middleText) {
  const kept = [];
  for (const block of splitTopLevelPatchEntries(middleText)) {
    let parsed;
    try {
      parsed = parse(block);
    } catch {
      kept.push(block);
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    if (items.length > 0 && items.every(isManagedPatchEntry)) continue;
    kept.push(block);
  }
  return kept.join('\n');
}

export function stitchPatch(prefix, block, relocated, suffix) {
  const extras = [];
  if (block && block.trim() !== '') extras.push(block.replace(/^\n+/, '').trimEnd());
  if (relocated && relocated.trim() !== '') extras.push(relocated.replace(/^\n+/, '').trimEnd());
  let next = prefix.trimEnd();
  if (extras.length > 0) next += `\n\n${extras.join('\n\n')}\n`;
  else next += '\n';
  if (suffix) {
    next += suffix;
    if (!next.endsWith('\n')) next += '\n';
  }
  return next;
}

// ── native import ─────────────────────────────────────────────────────────

/**
 * Native mcp-client insert rows in a patch slice.
 *
 * A slice that does not parse (an unknown YAML tag, a hand-edited file) yields
 * `[]` so the plugin never corrupts it: native rows are then simply left alone.
 */
export function parseNativeMcpEntries(text) {
  const found = [];
  try {
    const docs = parse(text);
    if (!Array.isArray(docs)) return found;
    for (const block of docs) {
      if (block === null || typeof block !== 'object' || !Array.isArray(block.insert)) continue;
      for (const entry of block.insert) {
        if (entry !== null && typeof entry === 'object' && entry.name === MCP_PLUGIN_NAME) found.push(entry);
      }
    }
  } catch {
    /* leave native entries untouched */
  }
  return found;
}

// ── row excision ──────────────────────────────────────────────────────────

function splitTopLevelPatchEntriesWithRanges(text) {
  const lines = String(text).split(/\r?\n/);
  const lineOffsets = [];
  let acc = 0;
  for (const line of lines) {
    lineOffsets.push(acc);
    acc += line.length + 1;
  }
  const entries = [];
  let buf = [];
  let startLine = -1;
  const flush = () => {
    while (buf.length > 0 && buf[buf.length - 1] === '') buf.pop();
    if (buf.length === 0) return;
    const startOffset = lineOffsets[startLine];
    const endLine = startLine + buf.length;
    entries.push({
      text: buf.join('\n'),
      startLine,
      startOffset,
      endOffset: lineOffsets[Math.min(endLine, lineOffsets.length - 1)] + (endLine >= lineOffsets.length ? lines[lines.length - 1].length : 0),
    });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('- ')) {
      flush();
      startLine = i;
      buf.push(lines[i]);
    } else if (buf.length > 0) {
      buf.push(lines[i]);
    }
  }
  flush();
  return { entries, lineOffsets };
}

// Row spans inside one `- insert:` entry. Row starts are `- ` lines at the
// sequence's own indent; deeper-indented lines belong to the current row.
function segmentInsertRows(entryText) {
  const lines = entryText.split(/\r?\n/);
  let seqIndent = null;
  const rows = [];
  let current = null;
  for (let i = 1; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)- /);
    if (match === null) continue;
    const indent = match[1].length;
    if (seqIndent === null) seqIndent = indent;
    if (indent !== seqIndent) continue;
    if (current !== null) rows.push(current);
    current = { relStart: i, relEnd: lines.length };
  }
  if (current !== null) rows.push(current);
  if (seqIndent === null) return null;
  for (let i = 0; i < rows.length; i++) {
    rows[i].relEnd = i + 1 < rows.length ? rows[i + 1].relStart : lines.length;
  }
  return rows;
}

/**
 * Remove every mcp-client insert row that lives OUTSIDE the managed span and is
 * claimed by the registry. After a merge those rows exist only inside the block;
 * a leftover copy outside would collide on the loader entry id.
 *
 * Rows the registry does not claim (importNativeMcp: false, foreign rows) stay
 * untouched. Whole `- insert:` blocks that become empty are removed; comments
 * trailing an entry are kept.
 *
 * @param {string} text
 * @param {number} managedStartOffset negative when the file has no managed span yet
 * @param {number} managedEndOffset
 * @param {ReadonlySet<string>} claimedIds
 */
export function removeOutsideMcpRows(text, managedStartOffset, managedEndOffset, claimedIds) {
  const { entries, lineOffsets } = splitTopLevelPatchEntriesWithRanges(text);
  const cuts = [];
  for (const entry of entries) {
    if (managedStartOffset >= 0 && entry.startOffset >= managedStartOffset && entry.startOffset < managedEndOffset) continue;
    let parsed;
    try {
      parsed = parse(entry.text);
    } catch {
      continue;
    }
    const blocks = Array.isArray(parsed) ? parsed : [parsed];
    if (blocks.length !== 1 || blocks[0] === null || typeof blocks[0] !== 'object') continue;
    const insert = blocks[0].insert;
    if (!Array.isArray(insert) || insert.length === 0) continue;
    const dshIndexes = [];
    const claimedIndexes = [];
    insert.forEach((row, index) => {
      if (row === null || typeof row !== 'object' || row.name !== MCP_PLUGIN_NAME) return;
      dshIndexes.push(index);
      if (typeof row.id === 'string' && claimedIds.has(row.id)) claimedIndexes.push(index);
    });
    if (claimedIndexes.length === 0) continue;
    if (claimedIndexes.length === dshIndexes.length && dshIndexes.length === insert.length) {
      // The whole entry goes; keep trailing comment lines attached after it.
      let endOffset = entry.endOffset;
      const entryLines = entry.text.split(/\r?\n/);
      while (entryLines.length > 0) {
        const last = entryLines[entryLines.length - 1].trim();
        if (last === '' || last.startsWith('#')) {
          entryLines.pop();
          endOffset = lineOffsets[entry.startLine + entryLines.length] ?? endOffset;
        } else break;
      }
      cuts.push([entry.startOffset, endOffset]);
      continue;
    }
    const rows = segmentInsertRows(entry.text);
    if (rows === null || rows.length !== insert.length) continue;
    const entryLines = entry.text.split(/\r?\n/);
    const relOffsets = [];
    let relAcc = 0;
    for (const line of entryLines) {
      relOffsets.push(relAcc);
      relAcc += line.length + 1;
    }
    for (const index of claimedIndexes) {
      const row = rows[index];
      const start = entry.startOffset + relOffsets[row.relStart];
      const lastLine = Math.min(row.relEnd, entryLines.length - 1);
      const end = entry.startOffset + relOffsets[lastLine] + (entryLines[lastLine]?.length ?? 0) + 1;
      cuts.push([start, Math.min(end, text.length)]);
    }
  }
  let next = text;
  for (const [start, end] of cuts.sort((a, b) => b[0] - a[0])) {
    next = next.slice(0, start) + next.slice(Math.min(end, next.length));
  }
  return next;
}

// ── block generation ──────────────────────────────────────────────────────

/**
 * The `config` object of one shadow row.
 *
 * `rawConfig` is what the native row declared; it is preferred over the
 * registry's projection because it may carry fields this plugin does not model
 * (reconnect policy, timeouts) and dropping them silently would change the
 * server's behaviour on the next handover.
 *
 * @param {object} entry
 * @returns {object|null} null = this entry has no patch row
 */
export function entryRowConfig(entry) {
  if (entry.rawConfig && typeof entry.rawConfig === 'object') {
    return { ...stripPluginOwned(entry.rawConfig), serverName: entry.name };
  }
  const config = { serverName: entry.name };
  if (Number.isSafeInteger(entry.toolCallTimeoutMs) && entry.toolCallTimeoutMs > 0) {
    config.toolCallTimeoutMs = entry.toolCallTimeoutMs;
  }
  if (entry.transport === 'stdio') {
    config.transport = 'stdio';
    config.command = entry.command;
    if (Array.isArray(entry.args) && entry.args.length > 0) config.args = entry.args;
    if (entry.env && typeof entry.env === 'object' && Object.keys(entry.env).length > 0) config.env = entry.env;
    if (entry.cwd) config.cwd = entry.cwd;
  } else if (entry.transport === 'streamable-http') {
    config.transport = 'streamable-http';
    config.url = entry.url;
    if (entry.headers && typeof entry.headers === 'object' && Object.keys(entry.headers).length > 0) config.headers = entry.headers;
  } else {
    return null;
  }
  return config;
}

export function entryRowId(entry) {
  return typeof entry.systemEntryId === 'string' && entry.systemEntryId !== '' ? entry.systemEntryId : `mcp-${entry.name}`;
}

/**
 * Regenerate the managed span: exactly one disabled row per MCP entry.
 *
 * A duplicate loader id can never be written — it would make the next boot fail
 * with an unresolvable entry id, and the failure would surface far from here.
 * So this throws instead, and the caller logs and leaves the file alone.
 *
 * @param {object[]} entries
 * @param {{start: string, end: string}} markers
 */
export function managedBlockYaml(entries, markers) {
  const rows = [];
  const seen = new Set();
  for (const entry of entries) {
    const id = entryRowId(entry);
    if (seen.has(id)) throw new Error(`managed MCP rows would duplicate loader id "${id}" — refusing to write the patch`);
    seen.add(id);
    const config = entryRowConfig(entry);
    if (config === null) continue;
    rows.push({ id, name: MCP_PLUGIN_NAME, config, disabled: true });
  }
  const parts = [markers.start];
  if (rows.length > 0) parts.push(stringify([{ insert: rows }]).trimEnd());
  parts.push(markers.end);
  return `${parts.join('\n')}\n`;
}

/**
 * Hand every entry back to the native client as an enabled insert row.
 * A `disabled`-tier entry keeps its disabled flag, so the operator's off choice
 * survives the uninstall instead of silently turning the server back on.
 */
export function handoverBlockYaml(entries, marker) {
  const rows = [];
  for (const entry of entries) {
    const config = entryRowConfig(entry);
    if (config === null) continue;
    const row = { id: entryRowId(entry), name: MCP_PLUGIN_NAME, config };
    if (entry.tier === 'disabled') row.disabled = true;
    rows.push(row);
  }
  if (rows.length === 0) return '';
  return `${marker}\n${stringify([{ insert: rows }]).trimEnd()}`;
}
