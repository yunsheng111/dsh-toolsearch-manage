// The discovery set: which deferred tools this session has already loaded.
//
// Two states, deliberately separate:
//   - RUNTIME state `{tick, version, discovered: Map<name, tick>}` is per Agent,
//     held in a WeakMap with LRU timestamps.
//   - PROJECTION state `{discovered: string[]}` is per Session, plain JSON and
//     bounded. It exists only to seed the next restore.
//
// Merging them would make the projection jitter with per-agent LRU (the host
// treats every reference change as downstream work) and would turn runtime state
// into "shared by every agent of one session".
//
// The protocol marker, its parser and the fold live together because they must
// change together: a parser that accepts an older shape is a silent failure.
//
// Ported from `dsh-toolbox-ui@1.8.2` `lib/tool-search-state.js` (MIT; see
// LICENSE-MIT-TOOLBOX-UI). The `wire` field is omitted: this state is host-only,
// never sent to the Client.

/** Marker inside the tool result, so a restore can recognise this plugin's own output. */
export const META_PROTOCOL = 'dsh-toolsearch-manage/v1';

/** Projection key. Same camelCase style as the host's own projections. */
export const PROJECTION_KEY = 'toolSearchManageDiscoveries';

export function createState() {
  return { tick: 0, version: 0, discovered: new Map() };
}

/** Seed from a restored name list, oldest first. Called once per Agent. */
export function seed(state, names) {
  for (const name of names ?? []) {
    if (typeof name !== 'string' || state.discovered.has(name)) continue;
    state.discovered.set(name, ++state.tick);
  }
  if (state.discovered.size > 0) state.version += 1;
}

/**
 * Record a batch of discoveries.
 *
 * Seeding the LRU tick at discovery time matters: a batch discovered just now
 * must be the newest, or the eviction right after it can drop what the model is
 * looking at.
 *
 * @returns {string[]} names that were genuinely new
 */
export function discover(state, names) {
  const fresh = [];
  for (const name of names ?? []) {
    if (typeof name !== 'string' || state.discovered.has(name)) continue;
    state.discovered.set(name, ++state.tick);
    fresh.push(name);
  }
  if (fresh.length > 0) state.version += 1;
  return fresh;
}

/**
 * LRU touch for an already-discovered name.
 *
 * Does not advance `version`: membership did not change, so the catalog text
 * must not be invalidated.
 */
export function touch(state, name) {
  if (!state.discovered.has(name)) return;
  state.discovered.set(name, ++state.tick);
}

/**
 * Evict down to `cap`.
 *
 * `remove = min(size - cap, max(1, floor(size / 2)))`, coldest first. Not
 * "evict until at cap": lowering the cap from 100 to 20 would then drop 80
 * entries at once, including ones in active use. Not "always drop half" either:
 * at 30 with cap 20 only 10 should go — half is a ceiling, not a step size.
 *
 * @returns {string[]} evicted names
 */
export function evict(state, cap) {
  const size = state.discovered.size;
  if (size <= cap) return [];
  const half = Math.max(1, Math.floor(size / 2));
  const remove = Math.min(size - cap, half);
  const oldest = [...state.discovered.entries()]
    .sort((left, right) => left[1] - right[1])
    .slice(0, remove)
    .map(([name]) => name);
  for (const name of oldest) state.discovered.delete(name);
  if (oldest.length > 0) state.version += 1;
  return oldest;
}

export function versionOf(state) {
  return state.version;
}

/**
 * Projection cap: `max(maxDiscovered * 4, 100)`.
 *
 * The multiplier leaves headroom for a lowered runtime cap, and the floor keeps
 * a restored set from being smaller than the runtime one — a restore that is
 * immediately evicted restores nothing.
 */
export function projectionBound(maxDiscovered) {
  return Math.max(maxDiscovered * 4, 100);
}

/**
 * Read the accumulated discovered list out of one tool result.
 * Returns `undefined` for a value this plugin does not own.
 */
export function parseDiscoveredMeta(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (value.protocol !== META_PROTOCOL) return undefined;
  for (const key of ['allDiscoveredTools', 'discoveredTools']) {
    const list = value[key];
    if (Array.isArray(list) && list.every((item) => typeof item === 'string')) return [...list];
  }
  if (Array.isArray(value.matches)) {
    return value.matches
      .filter((match) => match !== null && typeof match === 'object' && typeof match.name === 'string' && match.found !== false)
      .map((match) => match.name);
  }
  return [];
}

/**
 * Restore the discovered set from durable session messages.
 *
 * The fallback when no projection service is composed. Uses the supported
 * `session.deriveMessages()`, not the deprecated `snapshotEvents()`.
 */
export function discoveredFromMessages(messages) {
  const discovered = new Set();
  for (const message of messages ?? []) {
    if (message?.role !== 'tool' || message.isError === true) continue;
    const block = Array.isArray(message.content) ? message.content[0] : undefined;
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    let value;
    try {
      value = JSON.parse(block.text);
    } catch {
      continue;
    }
    for (const name of parseDiscoveredMeta(value) ?? []) discovered.add(name);
  }
  return discovered;
}

/**
 * The result text of one of this plugin's search calls inside a session event.
 *
 * Two paths must both be recognised:
 *   - native: `tool/result` → `data.message.content[0].text`;
 *   - PTC: a dispatch from inside a program → `tool/ptc-dispatch`, where
 *     `data.name` is the sub-call name and `data.content` the result blocks.
 *     That is not a surface event, so deriveMessages never sees it — which is
 *     exactly why the projection is the only reliable restore path there.
 */
function eventText(event, toolName) {
  if (event === null || typeof event !== 'object') return undefined;
  const data = event.data;
  if (data === null || typeof data !== 'object') return undefined;
  let blocks;
  if (event.type === 'tool/result') {
    if (data.message?.isError === true) return undefined;
    blocks = data.message?.content;
  } else if (event.type === 'tool/ptc-dispatch') {
    if (data.name !== toolName || data.isError === true) return undefined;
    blocks = data.content;
  } else return undefined;
  const block = Array.isArray(blocks) ? blocks[0] : undefined;
  return block?.type === 'text' && typeof block.text === 'string' ? block.text : undefined;
}

/**
 * Projection `apply`: previous state + one event → next state.
 *
 * Three invariants:
 *   - always return a state object (returning `undefined` would set the host's
 *     state to undefined);
 *   - return the SAME reference when nothing was added, or every event produces
 *     downstream work;
 *   - keep the result bounded, so a long session cannot grow without limit.
 */
export function foldEvent(state, event, opts) {
  const prev = Array.isArray(state?.discovered) ? state.discovered : [];
  const text = eventText(event, opts?.toolName);
  if (text === undefined) return state;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return state;
  }
  const names = parseDiscoveredMeta(value);
  if (names === undefined || names.length === 0) return state;
  const seen = new Set(prev);
  const fresh = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    fresh.push(name);
  }
  if (fresh.length === 0) return state;
  const merged = [...prev, ...fresh];
  const max = Number.isSafeInteger(opts?.max) && opts.max > 0 ? opts.max : merged.length;
  return { discovered: merged.length > max ? merged.slice(-max) : merged };
}

/**
 * The host-only projection definition (`ctx.sessionProjections.register`, the
 * overload without `wire`).
 *
 * @param {{z: object, toolName: string, max: number}} options zod namespace, search tool name, bound
 */
export function discoveryProjection({ z, toolName, max }) {
  return {
    key: PROJECTION_KEY,
    // Plain JSON: the host persists (sessionId, key, ver, seq, val) and parses once on restore.
    stateSchema: z.object({ discovered: z.array(z.string()) }),
    init: () => ({ discovered: [] }),
    apply: (state, event) => foldEvent(state, event, { toolName, max }),
    // Bump when the fold semantics or fields change; a bump invalidates stored rows.
    stateVersion: 1,
  };
}
