// Tier policy: the single classification layer over every tool this plugin
// manages — MCP tools, built-in tools, and the plugin's own meta tools.
//
// Three tiers, one vocabulary everywhere (registry.json, config rules, UI):
//   - eager     : on the model-facing surface; callable directly.
//   - on-demand : absent from the tool table; discoverable through tool_search.
//   - disabled  : absent, not discoverable, and refused if called anyway.
//
// Pure functions only. Nothing here touches a Cordis service, which is what
// lets the whole classification be unit-tested without a host and recomputed
// on every assembly instead of being cached behind a flag someone must
// remember to invalidate.
//
// Rule parsing, glob compilation, the seven-step priority walk and the
// assembly projection are ported from `@daweifu/capability-menu@0.1.6`
// (`src/policy.ts`, Apache-2.0). See LICENSE-APACHE-CAPABILITY-MENU and the
// per-function notices below. Everything else is original to this plugin.

/**
 * The three exposure tiers. `eager` is the registry's historical name for what
 * the policy layer calls "resident"; they are the same thing and this module
 * always spells it `eager` so one string reaches every consumer.
 */
export const TIERS = Object.freeze(['eager', 'on-demand', 'disabled']);

/** A tier value is valid when it is one of the three, spelled exactly. */
export function isTier(value) {
  return value === 'eager' || value === 'on-demand' || value === 'disabled';
}

/** Normalize an unknown tier to a valid one, defaulting to `on-demand`. */
export function normalizeTier(value, fallback = 'on-demand') {
  return isTier(value) ? value : fallback;
}

// ── rule syntax (ported from capability-menu src/policy.ts) ───────────────

/**
 * Convert a user-facing rule string into a normalized rule.
 * - `server:<name>` → server-targeted rule.
 * - `server:<name>:*` → server-targeted glob over that server's tools.
 * - contains `*` → glob over the capability id.
 * - otherwise → literal exact name.
 *
 * @param {string} rule
 * @returns {{wildcard: boolean, pattern: string, target: 'id'|'server'}}
 */
export function parseRule(rule) {
  const trimmed = String(rule ?? '').trim();
  const serverPrefix = 'server:';
  if (trimmed.startsWith(serverPrefix)) {
    const rest = trimmed.slice(serverPrefix.length);
    // `server:<name>:*` → glob over the whole server.
    if (rest.endsWith(':*')) {
      return { wildcard: true, pattern: rest.slice(0, -2), target: 'server' };
    }
    return { wildcard: false, pattern: rest, target: 'server' };
  }
  return { wildcard: trimmed.includes('*'), pattern: trimmed, target: 'id' };
}

/** Compile a `*`-glob into an anchored RegExp (`*` → `.*`, everything else escaped). */
export function compileGlob(pattern) {
  const escaped = String(pattern)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Compile one tier's rule lists into fast-matchable form.
 * @param {{eager?: string[], 'on-demand'?: string[], disabled?: string[]}} set
 * @returns {{eager: object[], onDemand: object[], disabled: object[]}}
 */
export function compileSet(set = {}) {
  const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim() !== '').map(parseRule) : []);
  return {
    eager: list(set.eager),
    onDemand: list(set['on-demand']),
    disabled: list(set.disabled),
  };
}

function ruleMatches(rule, target) {
  if (rule.target === 'id') {
    if (!rule.wildcard) {
      // An exact rule matches the full id OR the bare name, so `bash` matches
      // the built-in tool whose id and name are both `bash`, and
      // `mcp__github__get_file` matches that MCP tool either way.
      return rule.pattern === target.id || rule.pattern === target.name;
    }
    return compileGlob(rule.pattern).test(target.id);
  }
  if (target.server === undefined) return false;
  if (!rule.wildcard) return rule.pattern === target.server;
  return compileGlob(rule.pattern).test(target.server);
}

/**
 * Classify one capability against compiled rules. Priority (first hit wins):
 * disabled-exact > disabled-wildcard > eager-exact > on-demand-exact >
 * eager-wildcard > on-demand-wildcard > default (eager).
 *
 * `disabled` is a control decision, so it beats an explicit `eager` rule.
 * Within eager/on-demand an exact name beats a wildcard, so pinning one
 * capability in the UI cannot be silently overridden by a broader pattern.
 *
 * @param {object} compiled result of {@link compileSet}
 * @param {{id: string, name: string, server?: string}} target
 * @param {ReadonlySet<string>} metaTools always eager
 * @returns {'eager'|'on-demand'|'disabled'}
 */
export function classify(compiled, target, metaTools = new Set()) {
  if (metaTools.has(target.id)) return 'eager';
  for (const rule of compiled.disabled) if (!rule.wildcard && ruleMatches(rule, target)) return 'disabled';
  for (const rule of compiled.disabled) if (rule.wildcard && ruleMatches(rule, target)) return 'disabled';
  for (const rule of compiled.eager) if (!rule.wildcard && ruleMatches(rule, target)) return 'eager';
  for (const rule of compiled.onDemand) if (!rule.wildcard && ruleMatches(rule, target)) return 'on-demand';
  for (const rule of compiled.eager) if (rule.wildcard && ruleMatches(rule, target)) return 'eager';
  for (const rule of compiled.onDemand) if (rule.wildcard && ruleMatches(rule, target)) return 'on-demand';
  return 'eager';
}

/** True when any rule in the list matches — used for fail-loud config validation. */
export function anyRuleMatches(rules, target) {
  return rules.some((rule) => ruleMatches(rule, target));
}

// ── projection ────────────────────────────────────────────────────────────

/**
 * Strip the tools the model must not see right now from one assembly.
 *
 * Deliberately a deny-list of `hidden` names rather than an allow-list of
 * visible ones: an assembly can carry tools this plugin never indexed (another
 * plugin's tool provider, a preset-scoped registration), and an allow-list
 * would silently delete them.
 *
 * The caller decides what `hidden` contains — `on-demand` tools that are not
 * discovered yet, plus every `disabled` tool. This function makes no
 * classification decision of its own.
 *
 * @param {{tools?: object[], sections?: object[]}} assembly
 * @param {ReadonlySet<string>} hidden
 * @returns {object} the same reference when nothing is hidden
 */
export function projectTools(assembly, hidden) {
  if (hidden.size === 0) return assembly;
  const tools = assembly.tools ?? [];
  const kept = tools.filter((tool) => !hidden.has(tool?.name));
  if (kept.length === tools.length) return assembly;
  return { ...assembly, tools: kept };
}

/**
 * The denial text for an executed-but-not-exposed tool.
 *
 * `on-demand` gets an instruction naming the exact query to run: the model
 * already knows the tool exists, it just needs its schema. `disabled` gets a
 * refusal with no pointer, because teaching the model how to reach a tool the
 * operator switched off defeats the switch.
 *
 * @param {string} name
 * @param {'on-demand'|'disabled'} tier
 * @param {string} searchToolName
 * @returns {string|undefined} `undefined` = allow
 */
export function guardDecision(name, tier, searchToolName) {
  if (tier === 'disabled') {
    return `tool "${name}" is disabled by the operator and cannot be executed`;
  }
  if (tier === 'on-demand') {
    return `tool "${name}" is deferred; call ${searchToolName} with the exact name "${name}" as the query to load its schema, then call it directly`;
  }
  return undefined;
}

// ── rule-based classification over a tool inventory ────────────────────────

/**
 * Build the classification target for one tool schema.
 *
 * Ownership is decided by a **unique** `mcp__<server>__` prefix match: a server
 * name containing `__` makes a bare prefix test ambiguous (`mcp__a__b__x` looks
 * like a tool of both `a` and `a__b`), so an ambiguous name is attributed to no
 * server and therefore only matches id-targeted rules.
 *
 * @param {{name: string}} schema
 * @param {ReadonlySet<string>} serverNames
 * @returns {{id: string, name: string, server?: string}}
 */
export function targetOf(schema, serverNames) {
  const name = typeof schema?.name === 'string' ? schema.name : '';
  const server = uniqueOwner(name, serverNames);
  return server === undefined ? { id: name, name } : { id: name, name, server };
}

/** The one server whose `mcp__<server>__` prefix matches, or undefined when none/ambiguous. */
export function uniqueOwner(name, serverNames) {
  let owner;
  for (const server of serverNames) {
    if (!name.startsWith(`mcp__${server}__`)) continue;
    // A second match means the prefix is ambiguous; fall to the stable side.
    if (owner !== undefined) return undefined;
    owner = server;
  }
  return owner;
}

/**
 * Every tool name this plugin currently controls, with its effective tier.
 *
 * Precedence, highest first: the entry's own stored tier (a per-server or
 * per-built-in decision the operator made in the UI), then a config rule, then
 * default `eager`. Stored tiers win because the alternative — a config rule
 * silently overriding a click the operator just made — is indistinguishable
 * from the UI being broken.
 *
 * @param {{schemas: object[], entries: object[], rules: object, metaTools: ReadonlySet<string>}} input
 * @returns {Map<string, {tier: string, kind: string, server?: string}>}
 */
export function resolveTiers({ schemas, entries, rules, metaTools }) {
  const serverNames = new Set(
    (entries ?? [])
      .filter((entry) => entry?.kind !== 'builtin' && typeof entry?.name === 'string')
      .map((entry) => entry.name),
  );
  // Stored per-entry tiers: an MCP entry's tier covers the whole server; a
  // built-in entry's tier covers one tool name.
  const byServer = new Map();
  const byTool = new Map();
  for (const entry of entries ?? []) {
    if (typeof entry?.tier !== 'string') continue;
    if (entry.kind === 'builtin') {
      const disabled = new Set(Array.isArray(entry.disabledTools) ? entry.disabledTools : []);
      byTool.set(entry.name, disabled.has(entry.name) ? 'disabled' : entry.tier);
    } else if (typeof entry.name === 'string') {
      byServer.set(entry.name, entry.tier);
    }
  }
  const resolved = new Map();
  for (const schema of schemas ?? []) {
    const name = typeof schema?.name === 'string' ? schema.name : undefined;
    if (name === undefined || name === '') continue;
    const target = targetOf(schema, serverNames);
    let tier;
    if (metaTools.has(name)) tier = 'eager';
    else if (byTool.has(name)) tier = byTool.get(name);
    else if (target.server !== undefined && byServer.has(target.server)) tier = byServer.get(target.server);
    else tier = classify(rules, target, metaTools);
    resolved.set(name, { tier, kind: target.server === undefined ? 'builtin' : 'mcp', ...(target.server !== undefined ? { server: target.server } : {}) });
  }
  return resolved;
}
