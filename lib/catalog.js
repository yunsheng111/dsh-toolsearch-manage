// The model-facing deferred-capability catalog.
//
// One renderer, two granularities, chosen by config:
//
//   server level (default)   - `grok-search-rs` (on-demand): one-line purpose
//   tool level               - the same line plus one indented line per tool
//
// Measured on this machine's 63-tool MCP inventory (18 known descriptions,
// 161 chars average): server level 401 chars, tool level ~6,926 at an 80-char
// cap and ~11,336 at 150. The model needs to know what a server is FOR; the
// specific parameters arrive with the search tool, which returns full schemas.
//
// Rendering is separated from indexing (toolbox-ui decision B11): the search
// index is cached per tool-surface revision, the text per
// (revision, discovery version, granularity). The previous implementation
// re-rendered the whole catalog on every step just to compare it byte for byte.
//
// SECURITY: every string here is third-party text (an MCP server's own
// description). Sections are emitted with `interpolate: false` — the prompt
// renderer interpolates `{{name}}` by default, so one `{{...}}` inside a server
// description would make every assembly step throw.
//
// Section naming, the `interpolate: false` rule and the two-slot text cache
// follow `dsh-toolbox-ui@1.8.2` (MIT; see LICENSE-MIT-TOOLBOX-UI).

/** Section name of the live catalog, appended on the assembly waterfall. */
export const CATALOG_SECTION_NAME = 'toolsearch:catalog';

/** Section name of the static guidance paragraph. */
export const GUIDANCE_SECTION_NAME = 'toolsearch:guidance';

/**
 * The static guidance paragraph. Registered once and masked to empty text while
 * nothing is deferred, so it never teaches the model to search an absent
 * catalog.
 *
 * The tool name is a PARAMETER, not a literal. The search tool can be registered
 * under a fallback name when another plugin already owns `tool_search`, and a
 * paragraph naming a tool that does not exist sends the model at nothing. This
 * was observed on this machine: `dsh-toolbox-ui` registers `tool_search` first,
 * so this plugin's own became `deferred_tool_search`.
 *
 * @param {string} searchToolName the name actually registered this process
 * @returns {string}
 */
export function guidanceText(searchToolName) {
  return `Some tools are deferred: the prompt catalogues them by name and purpose but does not load their parameter schemas. When a deferred capability fits the task, call ${searchToolName} with a capability query (it matches tool names, descriptions and parameter names) and then call the chosen tool directly by its exact name. Do not claim a capability is unavailable before searching.`;
}

/**
 * A prompt section for third-party text.
 *
 * `interpolate: false` is mandatory, not defensive. `order` is only needed on
 * the `systemPrompt.section()` registration path (it requires a finite number);
 * a section appended inside the assembly waterfall carries none.
 *
 * @param {string} name
 * @param {string} text
 * @param {number} [order]
 */
export function promptSection(name, text, order) {
  return order === undefined ? { name, text, interpolate: false } : { name, text, interpolate: false, order };
}

/**
 * Collapse whitespace and clip to `maxLength`, with the ellipsis inside the
 * budget.
 *
 * `maxLength` below 4 would make `slice` a negative index and return the whole
 * string — a "truncated" value longer than the input. Clamp instead.
 */
export function truncate(value, maxLength) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  const limit = Math.max(0, Math.floor(maxLength));
  if (limit < 4) return normalized.slice(0, limit);
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

/**
 * Build one catalog group, or null when it has nothing deferred to show.
 *
 * A group with no deferred tools produces no line: `eager` capabilities are in
 * the tool table with full schemas, and `disabled` ones must stay invisible —
 * naming one would tell the model how to ask for it.
 *
 * @param {object} input
 * @param {string} input.name group key (`<server>` or `built-in`)
 * @param {string} input.description one-line purpose
 * @param {string} input.notes operator note, shown only for MCP servers
 * @param {Array<{name: string, description: string}>} input.tools deferred tools only
 * @param {{toolDescriptionMaxLength: number, catalogDescriptionMaxLength: number, granularity: 'server'|'tool'}} input.options
 * @returns {object|null}
 */
export function buildGroupRow({ name, description, notes, tools, options }) {
  const deferred = Array.isArray(tools) ? tools.filter((tool) => typeof tool?.name === 'string' && tool.name !== '') : [];
  if (deferred.length === 0) return null;
  return {
    name,
    tier: 'on-demand',
    // A server that reports no description leaves the row saying nothing, and
    // on this machine all three do exactly that — the catalog then reads as
    // three bare names, which is no better than not having a catalog. Falling
    // back to the server's own tool names is derived from data we already hold
    // and is usually enough to tell servers apart ("click, fill, navigate_page"
    // is recognisably browser automation).
    description: truncate(
      (description ?? '') !== '' ? description : toolNameSummary(deferred, name),
      options.catalogDescriptionMaxLength,
    ),
    notes: truncate(notes ?? '', options.catalogDescriptionMaxLength),
    granularity: options.granularity,
    tools: deferred.map((tool) => ({
      name: tool.name,
      description: truncate(tool.description ?? '', options.toolDescriptionMaxLength),
    })),
  };
}

/**
 * A one-line stand-in for a server that declares no description.
 *
 * Lists its tool names, dropping the server prefix MCP tool names carry, so the
 * line says what the server can do rather than repeating its name. Tool names
 * are the only structured information every server provides.
 *
 * @param {Array<{name: string}>} tools
 * @param {string} serverName used to strip a `mcp__<server>__` prefix
 * @returns {string}
 */
export function toolNameSummary(tools, serverName) {
  const prefix = `mcp__${serverName}__`;
  const names = tools
    .map((tool) => (typeof tool?.name === 'string' && tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool?.name))
    .filter((toolName) => typeof toolName === 'string' && toolName !== '');
  if (names.length === 0) return '';
  // Six is enough to convey the shape of a server without turning the catalog
  // into a tool listing; the exact names arrive with a search.
  const shown = names.slice(0, 6).join(', ');
  return names.length > 6 ? `${shown}, … (${names.length} tools)` : `${shown} (${names.length} tools)`;
}

/**
 * Render the catalog body from already-built group rows.
 *
 * `searchToolName` is threaded through for the same reason as in
 * {@link guidanceText}: the instructions must name the tool that actually exists.
 *
 * @param {object[]} rows result of {@link buildGroupRow}, nulls dropped
 * @param {string} searchToolName the name actually registered this process
 * @returns {string}
 */
export function renderCatalogText(rows, searchToolName) {
  const lines = [];
  for (const row of rows) {
    let line = `- \`${row.name}\` (${row.tier}): ${row.description !== '' ? row.description : '(no description)'}`;
    if (row.notes !== '') line += ` (notes: ${row.notes})`;
    lines.push(line);
    if (row.granularity === 'tool') {
      for (const tool of row.tools) lines.push(`  - ${tool.name}${tool.description !== '' ? `: ${tool.description}` : ''}`);
    }
  }
  return [
    '<system-reminder>',
    'These capabilities are NOT in your tool table: only their names and purposes are listed here, without parameter schemas.',
    '',
    '<capability_catalog>',
    ...lines,
    '</capability_catalog>',
    '',
    'How to reach them:',
    `- \`${searchToolName}\` with a capability query returns the most relevant deferred tools with complete schemas; use \`select:<exact name>\` when you already know the name. A returned tool is immediately callable by its exact name.`,
    "- A server marked `on-demand` can also be reached through this plugin's bridge: `mcp_load {name}` returns its tool definitions, and `mcp_call {name, tool, args}` invokes one. Calling `mcp_call` for a server you have not loaded is an error.",
    "- `mcp_register` / `mcp_load` / `mcp_call` (and the search tool itself) are this plugin's own management tools, not tools of any MCP server — never reach them through `mcp_call`.",
    '- Never claim a capability is unavailable before searching.',
    '</system-reminder>',
  ].join('\n');
}

/**
 * Two-slot text cache.
 *
 * The key must carry both the tool-surface revision and the discovery version:
 * keyed on revision alone the text freezes on the bytes from before a
 * discovery, and keyed on the version alone it keeps serving a renamed tool's
 * old description. Two slots suffice — an evicted discovery returns to a key
 * the other slot still holds.
 */
export class TextCache {
  constructor() {
    this.slots = new Map();
  }

  /** @param {string} key @param {() => string} compute */
  get(key, compute) {
    const hit = this.slots.get(key);
    if (hit !== undefined) return hit;
    const text = compute();
    this.slots.set(key, text);
    if (this.slots.size > 2) {
      const oldest = this.slots.keys().next();
      if (!oldest.done) this.slots.delete(oldest.value);
    }
    return text;
  }

  clear() {
    this.slots.clear();
  }
}
