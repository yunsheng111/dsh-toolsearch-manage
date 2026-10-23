// PTC adaptation: trim the `tools:sdk` manual to the tools the model can
// actually reach.
//
// Why trimming is possible at all: the host renders `tools:sdk` from the full
// schema set of the visible tool table (`renderToolsSdk` / `renderToolsSdkPy`),
// and that manual is an ordinary entry in `assembly.sections`. Trimming is
// therefore re-rendering a SUBSET, not parsing the generated text.
//
// Why it is necessary: masking tools out of `assembly.tools` is a no-op for
// `tools:sdk`, because it is a separate projection path. Measured on
// `dsh-toolbox-ui@1.8.2`: a PTC session with deferral paid 3181 EXTRA characters
// per request — installing the plugin made things worse.
//
// The invariant that makes this safe (B2/B3): first prove `render(fullSet)`
// equals the host's text byte for byte. Only then is "my input equals the input
// the host rendered from" established. Any failed step returns the host's own
// text — the worst case stays today's behaviour, never worse.
//
// Assembly judgement must read `ctx.tools.modeFor(scope)` (no scope = the
// deployment default), and BOTH `native` and `ptc` are live: only `both` is
// inert. Writing "not native ⇒ inert" would switch PTC off entirely.

/**
 * `dsh-tools` is loaded lazily, and only by {@link rendererFor}.
 *
 * The trim decision below is a pure function over strings and is the part that
 * must be testable without a host. A static import would drag the whole host
 * tool runtime into every test and every module that only wants
 * `trimSdkText` — and the renderers are needed exclusively at assembly time.
 */
let dshTools;

async function loadDshTools() {
  if (dshTools === undefined) dshTools = await import('@deepseek-ai/dsh-tools');
  return dshTools;
}

/** The host's canonical PTC transport tool name (`dsh-tools` exports `RUN_CODE_NAME`). */
const RUN_CODE_NAME = 'run_code';

/** The section name of the host's generated SDK manual. */
const SDK_SECTION_NAME = 'tools:sdk';

/**
 * Pick the renderer for a runtime language. The host recognises only these two
 * keys; an unknown language is rejected by the host before this runs, so TS is
 * the safe fallback rather than a second, divergent decision.
 *
 * Returns `undefined` when the host package cannot be loaded, which the caller
 * treats as "cannot trim" — never as an error.
 */
export async function rendererFor(language) {
  let host;
  try {
    host = await loadDshTools();
  } catch {
    return undefined;
  }
  const render = language === 'python' ? host.renderToolsSdkPy : host.renderToolsSdk;
  return typeof render === 'function' ? render : undefined;
}

/**
 * Probe what the host offers, once, and report it. A missing capability means a
 * lost optimisation, never a failure to mount — so this never throws.
 *
 * `modeFor` and `sdkSchemas` are marked `private` in `dsh-tools`'s types, and
 * this package has no typecheck step: probing turns "the host renamed it" from
 * a mount-time throw into "degrade to today's behaviour plus one log line".
 *
 * @param {object} ctx
 * @returns {{modeFor: boolean, sdkSchemas: boolean, ptcRuntime: boolean}}
 */
export function probePtc(ctx) {
  const tools = ctx?.tools;
  const get = typeof ctx?.get === 'function' ? (serviceName) => ctx.get(serviceName) : () => undefined;
  const caps = {
    modeFor: typeof tools?.modeFor === 'function',
    sdkSchemas: typeof tools?.sdkSchemas === 'function',
    ptcRuntime: get('ptcRuntime') !== undefined,
  };
  if (caps.ptcRuntime && !caps.modeFor) {
    ctx.logger?.warn?.('toolsearch-manage: ctx.tools.modeFor() is unavailable (host private API may have been renamed): the PTC manual will not be trimmed');
  }
  return caps;
}

/**
 * Read the exact input the host rendered `tools:sdk` from.
 *
 * Two paths, verified byte-identical by toolbox-ui's F22 measurement:
 *   - fast: `tools.sdkSchemas(scope)`, one call (private, feature-detected);
 *   - main: the public `tools.schemas(scope)` plus a per-tool `tools.get` for
 *     `output.schema`. That is O(n²), so the caller caches by revision.
 *
 * Both exclude `run_code`, as the host's own `sdkSchemas` does. A single tool
 * without `output.schema` means giving up (`via: 'incomplete'`): a manual
 * missing one signature is WRONG, and trimming wrongly is worse than not
 * trimming.
 */
export function readSdkSchemas(tools, scope, caps) {
  if (caps?.sdkSchemas === true && typeof tools?.sdkSchemas === 'function') {
    const fast = tools.sdkSchemas(scope);
    if (Array.isArray(fast)) return { schemas: fast.filter((entry) => entry?.name !== RUN_CODE_NAME), via: 'sdkSchemas' };
  }
  if (typeof tools?.schemas !== 'function' || typeof tools?.get !== 'function') return { schemas: undefined, via: 'none' };
  const listed = tools.schemas(scope);
  if (!Array.isArray(listed)) return { schemas: undefined, via: 'none' };
  const schemas = [];
  for (const entry of listed) {
    if (entry?.name === RUN_CODE_NAME) continue;
    const definition = tools.get(entry.name, scope);
    const output = definition?.output?.schema;
    if (output === undefined) return { schemas: undefined, via: 'incomplete' };
    schemas.push({ ...entry, output });
  }
  return { schemas, via: 'public' };
}

/**
 * The trim decision. Pure: same input, same output, no requests, no caching.
 *
 * Order is part of correctness:
 *   1. no schemas → give up (`no-schemas`);
 *   2. `render(fullSet)` compared byte for byte against the host's text, and a
 *      mismatch → `premise-mismatch`;
 *   3. filter out the `drop` names; nothing dropped → `no-drop` (no pointless
 *      replacement);
 *   4. re-render the subset → success.
 *
 * `programFormat` is forwarded only when defined: from 0.2.1 the TS renderer
 * takes it and the host passes `runtime.programFormat`; not forwarding it fails
 * the self-check and silently degrades to no trimming. The 0.2.0 renderer
 * ignores a second argument, so "forward when defined" is correct on both.
 */
export function trimSdkText({ hostText, schemas, drop, render, programFormat }) {
  if (!Array.isArray(schemas) || schemas.length === 0) return { ok: false, reason: 'no-schemas' };
  const renderWith = (list) => (programFormat === undefined ? render(list) : render(list, programFormat));
  let full;
  try {
    full = renderWith(schemas);
  } catch {
    return { ok: false, reason: 'render-threw' };
  }
  if (typeof full !== 'string' || full !== hostText) return { ok: false, reason: 'premise-mismatch' };
  const kept = schemas.filter((entry) => !drop.has(entry?.name));
  if (kept.length === schemas.length) return { ok: false, reason: 'no-drop' };
  let text;
  try {
    text = renderWith(kept);
  } catch {
    return { ok: false, reason: 'render-threw' };
  }
  if (typeof text !== 'string') return { ok: false, reason: 'render-threw' };
  return { ok: true, text, dropped: schemas.length - kept.length };
}

/** Per-agent SDK-input cache, keyed by the tool-surface revision. */
const sdkCache = new WeakMap();
const warned = new Set();

function warnOnce(ctx, key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  ctx.logger?.warn?.(`toolsearch-manage: ${message}`);
}

/**
 * Replace the `tools:sdk` section with a subset render when, and only when, the
 * premise holds. Returns the SAME array reference on every failure path, so a
 * caller can tell "nothing changed" from "rewritten".
 *
 * Five gates, in order:
 *   1. the section exists and its text is non-empty (a native agent under a PTC
 *      deployment keeps the section with empty text);
 *   2. no `ptcRuntime` → no PTC session can exist → nothing to trim;
 *   3. the host's render input is readable;
 *   4. the self-check passes;
 *   5. at least one name is actually dropped.
 *
 * @param {object} ctx
 * @param {{sections?: object[]}} assembly
 * @param {{scope?: object}} context the assembly context (`scope` = the agent)
 * @param {{revision: number}} session
 * @param {(toolName: string) => boolean} isDrop
 * @param {{modeFor: boolean, sdkSchemas: boolean, ptcRuntime: boolean}} caps
 */
export async function trimSdkSections(ctx, assembly, context, session, isDrop, caps) {
  const sections = assembly.sections ?? [];
  const section = sections.find((entry) => entry?.name === SDK_SECTION_NAME);
  if (section === undefined || typeof section.text !== 'string' || section.text === '') return assembly;
  if (!caps?.ptcRuntime) return assembly;
  const runtime = typeof ctx.get === 'function' ? ctx.get('ptcRuntime') : undefined;
  if (runtime === undefined) return assembly;
  const scope = context?.scope;
  // Both `native` and `ptc` are live modes; only `both` is inert, and `both`
  // does not exist on hosts that offer `modeFor` (it was removed in 0.2.1).
  if (caps.modeFor) {
    let mode;
    try {
      mode = ctx.tools.modeFor(scope);
    } catch (error) {
      warnOnce(ctx, 'modeForThrew', `ctx.tools.modeFor() threw (treating as native): ${String(error?.message ?? error)}`);
      return assembly;
    }
    if (mode !== 'ptc') return assembly;
  }
  const revision = session?.revision ?? 0;
  let read = sdkCache.get(scope ?? null);
  if (read === undefined || read.revision !== revision) {
    read = { revision, value: readSdkSchemas(ctx.tools, scope, caps) };
    sdkCache.set(scope ?? null, read);
  }
  if (read.value.schemas === undefined) {
    warnOnce(ctx, `sdkRead:${read.value.via}`, `cannot read the input the host rendered ${SDK_SECTION_NAME} from (${read.value.via}); leaving the manual alone`);
    return assembly;
  }
  const drop = new Set(read.value.schemas.map((entry) => entry?.name).filter((toolName) => typeof toolName === 'string' && isDrop(toolName)));
  if (drop.size === 0) return assembly;
  const render = await rendererFor(runtime.language);
  if (render === undefined) {
    warnOnce(ctx, 'noRenderer', `cannot load the host's ${SDK_SECTION_NAME} renderer; leaving the manual alone`);
    return assembly;
  }
  const programFormat = typeof runtime.programFormat === 'string' ? runtime.programFormat : undefined;
  const result = trimSdkText({ hostText: section.text, schemas: read.value.schemas, drop, render, programFormat });
  if (!result.ok) {
    if (result.reason !== 'no-drop') warnOnce(ctx, `trim:${result.reason}`, `${SDK_SECTION_NAME} not trimmed (${result.reason}); keeping the host text`);
    return assembly;
  }
  return { ...assembly, sections: sections.map((entry) => (entry === section ? { ...entry, text: result.text } : entry)) };
}
