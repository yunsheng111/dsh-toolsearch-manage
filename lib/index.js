// dsh-toolsearch-manage — the single owner of tool visibility in this profile.
//
// One plugin, four concerns that used to belong to three separate packages and
// fought over the same `cordis.patch.yml` rows:
//
//   TIERS       every tool (MCP, built-in, the plugin's own meta tools) is
//               `eager` (visible and callable), `on-demand` (absent until
//               discovered through the search tool), or `disabled` (absent,
//               undiscoverable, and refused if called anyway).
//   CONNECTION  MCP servers connect per DSH session, never shared. A stateful
//               server (a browser, a local document bridge) must not leak state
//               into a session that happens to run beside it.
//   PATCH       this plugin is the only writer of the profile's
//               `cordis.patch.yml`. MCP rows consolidate into one
//               marker-delimited block regenerated from the registry.
//   DISCOVERY   the search tool returns complete schemas for deferred tools and
//               makes each one directly callable; a prompt section carries the
//               catalog of what is deferred.
//
// Why one mechanism instead of three (the reason this package exists): three
// plugins rewriting the same rows with three strategies and no lock means the
// last writer wins and the others silently lose their edits. Format was never
// the problem — `yaml@2.9.1` round-trips the real file byte-identically — the
// problem was semantic ownership.
//
// Dependency shape, deliberately minimal: `inject = ['tools']`, the one service
// the kernel always composes. Cordis `inject` is a dependency DECLARATION, not
// an optional hint: a missing service leaves the fiber inactive with no error.
// So `skills`, `webServer`, `systemPrompt` are acquired with `ctx.inject` or
// `ctx.get` — a profile without `dsh-skill` then loses only the skill face while
// the MCP tool surface keeps working.

import { readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import z from '@deepseek-ai/schemastery';

import {
  REGISTRY_VERSION,
  isMcp,
  resolveDataDir,
  resolveProfile,
  patchPathFor,
  dshHome,
  loadRegistry,
  saveRegistry,
  loadSettings,
  saveSettings,
  writePatch,
} from './store.js';
import { TIERS, isTier, compileSet, resolveTiers, guardDecision, projectTools } from './policy.js';
import {
  CATALOG_SECTION_NAME,
  GUIDANCE_SECTION_NAME,
  guidanceText,
  promptSection,
  buildGroupRow,
  renderCatalogText,
  TextCache,
} from './catalog.js';
import { connectEntry, callTool, connectionIdentity, isErrorContextSuffix, publicToolName, SessionRuntime } from './mcp-connection.js';
import { probePackage, auditProfile } from './plugin-check.js';
import { selfUpdateNotice } from './self-update.js';
import { checkForUpdate } from './self-update.js';
import { preflightUpdate, runUpdate } from './self-updater.js';
import { createMcpResultOutput, finalizeMcpResultContent, settleMcpToolResult, supportedStructuredSchema } from './mcp-result.js';
import { registerRecursiveSkillProvider, setDisableModelInvocation } from './skill.js';
import { mountUi, entryView, openWithSystemEditor, trashDirectory } from './ui.js';
import { createAuditRunner } from './session-audit.js';
import {
  handoverBlockYaml,
  managedBlockYaml,
  entryRowId,
  parseNativeMcpEntries,
  removeOutsideMcpRows,
  splitPatchAroundManaged,
  stitchPatch,
} from './patch.js';
import {
  createState,
  seed,
  discover,
  touch,
  evict,
  discoveryProjection,
  discoveredFromMessages,
  PROJECTION_KEY,
  META_PROTOCOL,
} from './discovery.js';
import { buildIndex, searchIndex } from './search.js';
import { trimSdkSections, probePtc } from './ptc.js';
import { collectImportLocations, resolveImportLocation, IMPORT_SOURCES } from './mcp-import-sources.js';
import { builtinMcpCatalog, BUILTIN_MCP_SERVERS, matchesBuiltinIdentity, normalizeMcpImport, MCP_CATEGORIES, MCP_CATEGORY_LABELS } from './mcp-import.js';

/** Read the plugin's own version for the MCP handshake. */
function readPluginVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    if (typeof pkg.version === 'string' && pkg.version !== '') return pkg.version;
  } catch {
    /* package.json unreadable — the MCP handshake still needs a string */
  }
  return '0.0.0';
}

const name = 'toolsearch-manage';
// The one service the kernel always composes; everything else is optional.
const inject = ['tools'];

const PLUGIN_VERSION = readPluginVersion();
const SEARCH_TOOL_CANDIDATES = ['deferred_tool_search', 'mcp_tool_search'];

const MANAGED_MARKER = '# ── Managed MCP servers (dsh-toolsearch-manage, disabled shadow entries) ──';
const MANAGED_END_MARKER = '# ── End managed MCP servers (dsh-toolsearch-manage) ──';
const HANDOVER_MARKER = '# ── Handed back to native dsh-mcp-client (was managed by dsh-toolsearch-manage) ──';
const MARKERS = { start: MANAGED_MARKER, end: MANAGED_END_MARKER };

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const GUIDANCE_SECTION_ORDER = 3060;
const LOCAL_COMMAND_APPROVALS = new Set(['follow', 'always-ask', 'always-allow']);
/**
 * How often to re-check that this plugin still owns its managed block.
 *
 * The block can be removed by another writer while the process runs (Plugin
 * Manager rewriting the file from the host's own model does exactly that), so a
 * startup-only reconcile cannot cover it. 20 s is free — one file read — and
 * repairs a lost block long before the next restart would read it.
 */
const PATCH_OWNERSHIP_INTERVAL_MS = 20000;

const Config = z.object({
  dataDir: z.string().default(''),
  /** Profile whose patch this plugin owns. Empty = detect (DSH_PROFILE, then argv, then directory). */
  profile: z.string().default(''),
  trialTimeoutMs: z.number().default(30000),
  toolCallTimeoutMs: z.number().default(60000),
  /** Cap on a server description inside the catalog. */
  catalogDescriptionMaxLength: z.number().default(300),
  /** Cap on a tool description inside a tool-level catalog row. */
  toolDescriptionMaxLength: z.number().default(80),
  /**
   * Catalog granularity. `server` (default) lists one line per deferred server:
   * measured 401 chars for this machine's 63-tool inventory, versus ~6,926 at
   * tool level. `tool` adds one line per deferred tool, for a server whose tools
   * the model must be able to tell apart without searching first.
   */
  catalogGranularity: z.union(['server', 'tool']).default('server'),
  /** Import MCP rows already present in the profile patch. */
  importNativeMcp: z.boolean().default(true),
  /** The model-facing search tool name; renamed automatically when taken. */
  searchToolName: z.string().default('tool_search'),
  maxResults: z.number().default(10),
  maxDiscovered: z.number().default(20),
  stem: z.boolean().default(true),
  /** Trim the `tools:sdk` manual under PTC, so deferring never costs characters. */
  trimPtcManual: z.boolean().default(true),
  /**
   * Rule lists applied to capabilities that have no entry of their own. Same
   * syntax as the UI: `server:<name>:*` for a whole server, `*` globs, or exact
   * names. A stored tier always wins over a rule.
   */
  rules: z.object({
    eager: z.array(z.string()).default([]),
    'on-demand': z.array(z.string()).default([]),
    disabled: z.array(z.string()).default([]),
  }),
});

// ── model-facing output shapes ─────────────────────────────────────────────

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

// ── apply ──────────────────────────────────────────────────────────────────

async function apply(ctx, config = {}) {
  const dataDir = resolveDataDir(config);
  // Verification stays on by default: an environment variable naming a profile
  // that is not on disk must never redirect the patch writer. An explicit
  // `profile` config value (including the `__test__` sentinel) short-circuits the
  // detection before verification runs, so tests cannot touch a real profile.
  const profile = resolveProfile(config);
  const patchPath = patchPathFor({ profile });
  const trialTimeoutMs = config.trialTimeoutMs ?? 30000;
  const toolCallTimeoutMs = config.toolCallTimeoutMs ?? 60000;
  const catalogDescriptionMaxLength = config.catalogDescriptionMaxLength ?? 300;
  let toolDescriptionMaxLength = config.toolDescriptionMaxLength ?? 80;
  let catalogGranularity = config.catalogGranularity === 'tool' ? 'tool' : 'server';
  const maxResults = positiveInt(config.maxResults, 10);
  const maxDiscovered = Math.max(maxResults, positiveInt(config.maxDiscovered, 20));
  const stem = config.stem !== false;
  const trimPtcManual = config.trimPtcManual !== false;
  const rules = compileSet({
    eager: config.rules?.eager ?? [],
    'on-demand': config.rules?.['on-demand'] ?? [],
    disabled: config.rules?.disabled ?? [],
  });

  // ── live state ──
  let registry = { version: REGISTRY_VERSION, entries: [] };
  /** Per-tool tiers for built-ins, synced from the live tool table. */
  const builtinTiers = new Map();
  /** Per-agent session state. Weak so a disposed agent leaves nothing behind. */
  const sessions = new WeakMap();
  /** Agents seen in this process; a WeakMap is not iterable, so ids are tracked here. */
  const knownAgents = new Set();
  /** Eager entries that failed to connect in this process. Never persisted. */
  const eagerConnectFailed = new Set();
  /** Row ids removed through the UI; reconcile must not re-adopt their shadow row. */
  const retiredRowIds = new Set();
  let localCommandApproval = 'follow';
  // Where the management surface appears. The rail icon and the settings page are
  // separate registrations, and which of them exist is decided at assembly time —
  // a slot registration cannot be toggled without a re-mount, so the client asks
  // this value before it registers anything.
  //
  // `both` is the default: the settings page is where an operator looks first,
  // and the rail is where the page is usable, so hiding either by default would
  // make one of those two journeys fail.
  let uiPlacement = 'both';
  let lanHostAllowlist = [];
  let stdioMaxBufferSizeMb = null;
  let stdioMaxBufferSizeBytes;

  function applyStdioMaxBufferSizeSetting(value) {
    stdioMaxBufferSizeMb = typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
    stdioMaxBufferSizeBytes = stdioMaxBufferSizeMb === null ? undefined : stdioMaxBufferSizeMb * 1048576;
  }

  const searchToolName = chooseSearchToolName(ctx, config.searchToolName ?? 'tool_search');
  const metaTools = new Set([searchToolName, 'mcp_register', 'mcp_load', 'mcp_call', 'plugin_check']);
  const caps = probePtc(ctx);

  // ── registry queries ──

  const mcpEntries = () => registry.entries.filter(isMcp);
  const entryByName = (serverName) => registry.entries.find((entry) => isMcp(entry) && entry.name === serverName);
  const disabledToolNames = (entry) =>
    new Set(Array.isArray(entry?.disabledTools) ? entry.disabledTools.filter((value) => typeof value === 'string') : []);

  /** The MCP entry whose `mcp__<server>__` prefix uniquely owns this tool name. */
  function uniqueServerOf(toolName) {
    let owner;
    for (const entry of mcpEntries()) {
      if (!toolName.startsWith(`mcp__${entry.name}__`)) continue;
      // A second match means the prefix is ambiguous; fall to the stable side.
      if (owner !== undefined) return undefined;
      owner = entry;
    }
    return owner;
  }

  /**
   * The effective tier of one capability name.
   *
   * The registry is consulted for MCP tools even before anything connects, which
   * is what lets the guard refuse a hallucinated call to a server that was never
   * loaded. An unknown owner falls back to the rule list, so a hand-written
   * `server:<name>:*` still classifies tools whose server has no entry yet.
   */
  function tierOfName(toolName) {
    if (metaTools.has(toolName)) return 'eager';
    const builtin = builtinTiers.get(toolName);
    if (builtin !== undefined) return builtin;
    const owner = uniqueServerOf(toolName);
    if (owner !== undefined) return owner.tier;
    const resolved = resolveTiers({ schemas: [{ name: toolName }], entries: mcpEntries(), rules, metaTools });
    return resolved.get(toolName)?.tier ?? 'eager';
  }

  // ── session runtime ──

  function sessionFor(agent) {
    let session = sessions.get(agent);
    if (session !== undefined) return session;
    session = { runtime: new SessionRuntime(agent), state: createState(), restored: false };
    sessions.set(agent, session);
    knownAgents.add(agent);
    const agentCtx = agent?.ctx;
    if (agentCtx !== undefined && typeof agentCtx.effect === 'function') {
      // Register on the agent's own context so disposal is automatic, and keep
      // the same cleanup reachable from ours (see the plugin teardown below).
      agentCtx.effect(() => async () => {
        sessions.delete(agent);
        knownAgents.delete(agent);
        await session.runtime.disposeAll();
      });
    }
    return session;
  }

  const liveSessions = () => [...knownAgents].map((agent) => sessions.get(agent)).filter((session) => session !== undefined);

  /**
   * Restore the discovery set once per agent, projection first.
   *
   * The projection is the only path that works under PTC: a search there runs
   * inside a program, leaving a `tool/ptc-dispatch` event that is not a surface
   * event, so `deriveMessages()` never sees it. The message path stays as the
   * fallback for a profile without `dsh-session-projection`.
   */
  function restoreDiscovery(session) {
    if (session.restored) return;
    session.restored = true;
    const agent = session.runtime.agent;
    const projections = typeof ctx.get === 'function' ? ctx.get('sessionProjections') : undefined;
    if (projections !== undefined && agent?.session !== undefined) {
      try {
        const saved = projections.stateOf(agent.session, PROJECTION_KEY);
        if (Array.isArray(saved?.discovered) && saved.discovered.length > 0) {
          seed(session.state, saved.discovered);
          return;
        }
      } catch {
        /* fall through to the message path */
      }
    }
    try {
      const messages = typeof agent?.session?.deriveMessages === 'function' ? agent.session.deriveMessages() : [];
      seed(session.state, [...discoveredFromMessages(messages)]);
    } catch {
      /* a session without a readable log simply starts empty */
    }
  }

  // ── connection + tool registration ──

  function applyServerMetadata(entry, connection) {
    entry.metaFetchedAt = new Date().toISOString();
    const info = connection?.serverInfo;
    if (info && typeof info === 'object') {
      if (typeof info.name === 'string' && info.name !== '') entry.serverName = info.name;
      if (typeof info.version === 'string' && info.version !== '') entry.serverVersion = info.version;
      if (typeof info.title === 'string' && info.title !== '') entry.serverTitle = info.title;
      if (typeof info.description === 'string' && info.description !== '') entry.serverDescription = info.description;
      if (typeof info.websiteUrl === 'string' && info.websiteUrl !== '') entry.websiteUrl = info.websiteUrl;
    }
    if (typeof connection?.instructions === 'string' && connection.instructions !== '') entry.instructions = connection.instructions;
    if (connection?.capabilities && typeof connection.capabilities === 'object') entry.capabilities = connection.capabilities;
  }

  const snapshotOf = (connection) =>
    connection.tools.map((tool) => ({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema }));

  /**
   * Register one server's tools in the calling agent's scope.
   *
   * Registration is what makes a tool callable; the assemble filter is what
   * makes it invisible. Keeping those apart is the point: a tier change never
   * has to unregister and re-register, it only changes the filter's answer.
   */
  function registerEntryTools(session, entry, connection) {
    const previous = session.runtime.nativeDisposers.get(entry.name);
    if (previous !== undefined) for (const dispose of previous.values()) dispose();
    const disposers = new Map();
    const host = session.runtime.agent?.ctx?.tools ?? ctx.tools;
    const disabled = disabledToolNames(entry);
    for (const tool of connection.tools) {
      if (disabled.has(tool.name)) continue;
      const publicName = publicToolName(entry.name, tool.name);
      const projections = new WeakMap();
      disposers.set(
        publicName,
        host.register({
          name: publicName,
          description: tool.description ?? '',
          parameters: tool.inputSchema ?? { type: 'object' },
          output: createMcpResultOutput(supportedStructuredSchema(tool.outputSchema), tool.name),
          finalizeContent(exec, result) {
            return finalizeMcpResultContent(projections, exec, result);
          },
          async execute(args, exec) {
            const live = session.runtime.connections.get(entry.name) ?? connection;
            const errorContext = { server: entry.name, inputSchema: tool.inputSchema };
            const result = await callTool(live.client, tool.name, args, { timeoutMs: toolCallTimeoutMs, signal: exec.signal, errorInfo: errorContext });
            return settleMcpToolResult(ctx, exec, projections, result, tool.name, isErrorContextSuffix(errorContext, tool.name, args));
          },
        }),
      );
    }
    session.runtime.nativeDisposers.set(entry.name, disposers);
    session.runtime.connectionKeys.set(entry.name, connectionIdentity(entry));
    return disposers.size;
  }

  /**
   * Connect (if needed) and register one server for one session.
   *
   * Serialised per (session, server) by the load lock: two parallel calls asking
   * for the same server would otherwise each dispose the other's connection, and
   * the second disposal would kill the one just published.
   */
  function ensureSessionEntry(session, entry) {
    return session.runtime.withLoadLock(entry.name, async () => {
      const existing = session.runtime.connections.get(entry.name);
      const sameConnection = existing !== undefined && session.runtime.connectionKeys.get(entry.name) === connectionIdentity(entry);
      if (existing !== undefined && sameConnection) return existing;
      if (existing !== undefined) await session.runtime.disposeEntry(entry.name);
      const connection = await connectEntry(entry, { timeoutMs: trialTimeoutMs, version: PLUGIN_VERSION, stdioMaxBufferSizeBytes });
      session.runtime.connections.set(entry.name, connection);
      entry.tools = snapshotOf(connection);
      applyServerMetadata(entry, connection);
      registerEntryTools(session, entry, connection);
      return connection;
    });
  }

  async function disposeEverywhere(serverName) {
    for (const session of liveSessions()) await session.runtime.disposeEntry(serverName);
  }

  // ── patch reconcile (single writer) ──

  /**
   * Absorb + regenerate in one pass.
   *
   *   1. Scan the WHOLE patch for mcp-client rows and adopt the ones no entry
   *      claims by row id (hand-added rows anywhere are absorbed once; a renamed
   *      entry is never re-imported).
   *   2. Regenerate the managed span from the registry: exactly one disabled row
   *      per MCP entry. A duplicate loader id aborts the write.
   *   3. Excise every claimed mcp-client row outside the span — the rows moved
   *      into the block must not survive as stray copies.
   */
  async function reconcile() {
    let current;
    try {
      current = await readFile(patchPath, 'utf8');
    } catch {
      ctx.logger.warn(`toolsearch-manage: cannot read ${patchPath}; reconcile skipped`);
      return 0;
    }
    const { prefix, middle, suffix } = splitPatchAroundManaged(current, MARKERS);
    const claimedIds = new Set(mcpEntries().map(entryRowId));
    let imported = 0;
    const absorb = (text) => {
      if (config.importNativeMcp === false) return;
      for (const row of parseNativeMcpEntries(text)) {
        const rowId = typeof row.id === 'string' && row.id !== '' ? row.id : null;
        if (rowId !== null && (claimedIds.has(rowId) || retiredRowIds.has(rowId))) continue;
        const serverName = row.config?.serverName;
        if (typeof serverName !== 'string' || serverName === '') continue;
        if (registry.entries.some((entry) => entry.name === serverName)) continue;
        registry.entries.push(nativeRowToEntry(row, row.disabled === true ? 'disabled' : 'on-demand'));
        if (rowId !== null) claimedIds.add(rowId);
        imported += 1;
      }
    };
    absorb(prefix);
    absorb(middle);
    absorb(suffix);

    let block;
    try {
      block = managedBlockYaml(mcpEntries(), MARKERS);
    } catch (error) {
      // A duplicate loader id would break the NEXT boot, far from here. Refuse
      // loudly and leave the file exactly as it was.
      ctx.logger.error(`toolsearch-manage: ${String(error?.message ?? error)}`);
      if (imported > 0) await saveRegistry(dataDir, registry);
      return imported;
    }
    const managedStart = current.indexOf(MANAGED_MARKER);
    const endIndex = managedStart < 0 ? -1 : current.indexOf(MANAGED_END_MARKER, managedStart);
    const managedEnd = managedStart < 0 || endIndex < 0 ? current.length : indexAfterLine(current, endIndex);
    const stripped = removeOutsideMcpRows(current, managedStart, managedEnd, claimedIds);
    const parts = splitPatchAroundManaged(stripped, MARKERS);
    const next = stitchPatch(parts.prefix, block, parts.relocated, parts.suffix);
    if (next !== current) {
      await writePatch(patchPath, current, next);
      ctx.logger.info(`toolsearch-manage: reconciled ${patchPath} (profile: ${profile})`);
    }
    if (imported > 0) await saveRegistry(dataDir, registry);
    return imported;
  }

  /**
   * Remove this plugin's managed block from profiles other than the one it owns.
   *
   * Only the block is removed — the marker span and any `- insert:` it produced —
   * and nothing else in the file is touched. A profile whose block is EMPTY
   * (markers with no rows, which is what a misdirected first run leaves behind)
   * loses the two marker lines and keeps every other byte.
   *
   * This runs before {@link reconcile} so a corrected detection takes effect on
   * the same start that fixes it.
   */
  async function releaseForeignPatchBlocks() {
    let names;
    try {
      names = readdirSync(join(dshHome(), 'profiles'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== profile)
        .map((entry) => entry.name);
    } catch {
      return;
    }
    for (const otherProfile of names) {
      const otherPath = join(dshHome(), 'profiles', otherProfile, 'cordis.patch.yml');
      let current;
      try {
        current = await readFile(otherPath, 'utf8');
      } catch {
        continue;
      }
      if (!current.includes(MANAGED_MARKER)) continue;
      const parts = splitPatchAroundManaged(current, MARKERS);
      // Keep any foreign block that was parked inside our span, drop only ours.
      const next = stitchPatch(parts.prefix, '', parts.relocated, parts.suffix);
      try {
        await writePatch(otherPath, current, next);
        ctx.logger.warn(
          `toolsearch-manage: removed a managed block from profile "${otherProfile}" (this plugin owns "${profile}"); that patch now lives in ${patchPath}`,
        );
      } catch (error) {
        ctx.logger.error(`toolsearch-manage: cannot clean up ${otherPath}: ${String(error?.message ?? error)}`);
      }
    }
  }

  /**
   * Re-install the managed block if another writer removed it.
   *
   * Observed on this machine within minutes of the first start: disabling an
   * unrelated bundle through Plugin Manager rewrote `cordis.patch.yml` from the
   * host's own model of the file, which did not include this plugin's block. The
   * rows vanished; the registry still held all three servers, so the next boot
   * would find native rows absent AND its own rows absent — the servers would
   * simply stop existing.
   *
   * A single startup reconcile cannot cover that, because the overwrite happens
   * while the process is running. So the file is watched, and losing the span is
   * treated as a condition to repair rather than a log line to skip. This is the
   * same conflict the package was built to remove (one writer), now defended at
   * the only place that can: the loser of a race re-applies its claim.
   *
   * Bounded on purpose: `attempts` caps the repairs per process so two plugins
   * fighting over one file cannot spin. When the cap is reached the operator is
   * told, because a permanent fight needs a human decision, not more retries.
   */
  function watchPatchOwnership() {
    const attemptLimit = 5;
    let attempts = 0;
    let inFlight = false;
    let timer;

    const check = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        let current;
        try {
          current = await readFile(patchPath, 'utf8');
        } catch {
          return;
        }
        if (current.includes(MANAGED_MARKER)) return;
        if (attempts >= attemptLimit) {
          ctx.logger.error(
            `toolsearch-manage: the managed block in ${patchPath} was removed ${attempts} times; another writer keeps overwriting it. Re-apply it manually or disable the other plugin.`,
          );
          return;
        }
        attempts += 1;
        ctx.logger.warn(`toolsearch-manage: the managed block in ${patchPath} disappeared (another writer rewrote the file); restoring it (attempt ${attempts}/${attemptLimit})`);
        await reconcile();
        if (mcpEntries().length > 0) {
          const after = await readFile(patchPath, 'utf8');
          if (!after.includes(MANAGED_MARKER)) {
            ctx.logger.error(`toolsearch-manage: restoring the managed block failed; ${patchPath} still has no span`);
          }
        }
      } catch (error) {
        ctx.logger.warn(`toolsearch-manage: patch ownership check failed: ${String(error?.message ?? error)}`);
      } finally {
        inFlight = false;
      }
    };

    // A short delay keeps the first check out of the boot path; the interval is
    // slow enough to be free and fast enough that a lost block is repaired long
    // before the next restart reads the file.
    timer = setInterval(() => {
      void check();
    }, PATCH_OWNERSHIP_INTERVAL_MS);
    if (typeof timer?.unref === 'function') timer.unref();
    ctx.effect(() => () => clearInterval(timer));
  }

  function nativeRowToEntry(row, tier) {
    const cfg = row.config ?? {};
    const now = new Date().toISOString();
    return mcpEntry({
      name: cfg.serverName,
      tier,
      transport: cfg.transport,
      command: cfg.command ?? null,
      args: cfg.args ?? [],
      env: cfg.env ?? {},
      cwd: cfg.cwd ?? null,
      url: cfg.url ?? null,
      headers: cfg.headers ?? {},
      toolCallTimeoutMs: cfg.toolCallTimeoutMs,
      systemEntryId: typeof row.id === 'string' ? row.id : `mcp-${cfg.serverName}`,
      registeredAt: now,
      // `rawConfig` makes the next write prefer the native row's own config, so
      // fields this plugin does not model (reconnect policy, timeouts) survive a
      // handover unchanged.
      rawConfig: { ...cfg },
    });
  }

  /** Warm entries with no cached snapshot so the catalog has real names from the first step. */
  async function warmSnapshots() {
    let changed = false;
    const missing = mcpEntries().filter(
      (entry) => entry.tier !== 'disabled' && (!Array.isArray(entry.tools) || entry.tools.length === 0 || entry.metaFetchedAt == null),
    );
    await Promise.all(
      missing.map(async (entry) => {
        try {
          const connection = await connectEntry(entry, { timeoutMs: trialTimeoutMs, version: PLUGIN_VERSION, stdioMaxBufferSizeBytes });
          try {
            entry.tools = snapshotOf(connection);
            entry.lastLoadAt = new Date().toISOString();
            applyServerMetadata(entry, connection);
            changed = true;
          } finally {
            await connection.client.close();
          }
        } catch (error) {
          ctx.logger.warn(`toolsearch-manage: warm-up snapshot for "${entry.name}" failed: ${String(error?.message ?? error)}`);
        }
      }),
    );
    if (changed) await saveRegistry(dataDir, registry);
    return changed;
  }

  // ── per-session eager bring-up ──

  async function ensureSessionRuntime(agent) {
    if (agent === undefined || agent === null) return;
    const session = sessionFor(agent);
    restoreDiscovery(session);
    for (const entry of mcpEntries()) {
      if (entry.tier === 'eager') {
        if (eagerConnectFailed.has(entry.name) && !session.runtime.connections.has(entry.name)) continue;
        if (session.runtime.connections.has(entry.name) && session.runtime.connectionKeys.get(entry.name) === connectionIdentity(entry)) continue;
        try {
          await ensureSessionEntry(session, entry);
          eagerConnectFailed.delete(entry.name);
        } catch (error) {
          eagerConnectFailed.add(entry.name);
          ctx.logger.error(`toolsearch-manage: failed to start eager MCP "${entry.name}": ${String(error?.message ?? error)}`);
        }
      } else if (entry.tier === 'disabled' && session.runtime.connections.has(entry.name)) {
        await session.runtime.disposeEntry(entry.name);
      }
    }
  }

  // ── built-in inventory ──

  /**
   * Sync the built-in tool names from the live global view.
   *
   * Built-ins have no connection and no configuration: only the operator's tier
   * decision is kept, so this only ever adds or drops names and never overwrites
   * a stored tier.
   */
  function syncBuiltins() {
    let schemas = [];
    try {
      schemas = ctx.tools.schemas() ?? [];
    } catch {
      return;
    }
    const seen = new Set();
    for (const schema of schemas) {
      const toolName = schema?.name;
      if (typeof toolName !== 'string' || toolName === '') continue;
      if (toolName.startsWith('mcp__') || metaTools.has(toolName)) continue;
      seen.add(toolName);
      if (!builtinTiers.has(toolName)) builtinTiers.set(toolName, 'eager');
    }
    for (const toolName of [...builtinTiers.keys()]) if (!seen.has(toolName)) builtinTiers.delete(toolName);
  }

  // ── search ──

  const indexCache = new WeakMap();
  const catalogCache = new TextCache();

  /**
   * The full searchable inventory: the live view plus registry snapshots for
   * servers that have not connected yet.
   *
   * Without the snapshots a deferred server would be unsearchable until its
   * first load, which inverts the point of on-demand loading.
   */
  function allKnownSchemas() {
    const byName = new Map();
    let live = [];
    try {
      live = ctx.tools.schemas() ?? [];
    } catch {
      live = [];
    }
    for (const schema of live) if (typeof schema?.name === 'string') byName.set(schema.name, schema);
    for (const entry of mcpEntries()) {
      const disabled = disabledToolNames(entry);
      for (const tool of entry.tools ?? []) {
        if (disabled.has(tool.name)) continue;
        const publicName = publicToolName(entry.name, tool.name);
        if (byName.has(publicName)) continue;
        byName.set(publicName, { name: publicName, description: tool.description ?? '', parameters: tool.inputSchema ?? {} });
      }
    }
    return [...byName.values()];
  }

  function revisionOf(schemas) {
    return hash(`${stem ? 's' : 'r'}\u0000${JSON.stringify(schemas.map((schema) => [schema?.name, schema?.description]))}`);
  }

  function indexFor(agent) {
    const schemas = allKnownSchemas();
    const revision = revisionOf(schemas);
    const cached = indexCache.get(agent ?? null);
    if (cached !== undefined && cached.revision === revision) return { index: cached.index, revision };
    const index = buildIndex(schemas, stem);
    indexCache.set(agent ?? null, { revision, index });
    return { index, revision };
  }

  // Fifth meta tool: read-only profile integrity probe. PROBE answers "should
  // I install this npm package", AUDIT answers "is the profile I booted from
  // still clean" — both without executing any plugin code.
  const pluginCheckTool = {
    name: 'plugin_check',
    description:
      'Plugin compatibility & profile integrity check (read-only, runs no plugin code). mode=probe: BEFORE installing an npm plugin, verifies it would not pull @deepseek-ai/* host-internal packages into the profile (the known startup-crash mechanism). mode=audit: AFTER installing (any source), verifies every @deepseek-ai/* package in the current profile matches the host\'s built-in version and has resolvable dependencies. Run audit after every plugin install and before reporting success.',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['probe', 'audit'], description: "probe: pre-install npm metadata check (needs package); audit: installed-profile integrity check (no arguments)." },
        package: { type: 'string', description: 'npm package name, required for mode=probe.' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify({ status: value.status, summary: value.summary, packages: value.packages ?? [] }) }],
    },
    async execute(args) {
      if (args.mode === 'probe') {
        const name = typeof args.package === 'string' ? args.package.trim() : '';
        if (name === '') throw new Error('plugin_check: mode=probe requires a package name');
        return await probePackage(name);
      }
      return auditProfile(join(dshHome(), 'profiles', profile));
    },
  };

  const searchTool = {
    name: searchToolName,
    description:
      'Search deferred tools by capability. The prompt lists their names and purposes only — descriptions and parameter schemas are not loaded. Returns the most relevant tools with complete schemas, and each returned tool becomes callable directly by its exact name. Queries match tool names, descriptions and parameter names. Tool names are English identifiers, so English keywords are most reliable; keywords in a server\'s own description language match too.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Capability query. Forms: "select:<name>[,<name>...]" for exact names; "+<server> <words>" to require a server; plain keywords otherwise.',
        },
        max_results: { type: 'integer', description: `Maximum tools to return (1-${maxResults}); defaults to ${maxResults}.` },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      // The accumulated discovered list goes to meta only; leaking it into the
      // prompt would re-send a growing table on every search.
      render: (_args, value) => {
        const rendered = { ...value };
        delete rendered.allDiscoveredTools;
        return [{ type: 'text', text: JSON.stringify(rendered) }];
      },
      presentationMeta: (_args, value) => ({ protocol: META_PROTOCOL, allDiscoveredTools: value.allDiscoveredTools ?? [] }),
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error(`${searchToolName} requires an agent-scoped execution`);
      const session = sessionFor(exec.agent);
      restoreDiscovery(session);
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (query === '') throw new Error('query must not be empty');
      const limit = Math.min(Math.max(Number(args.max_results) || maxResults, 1), maxResults);
      const { index } = indexFor(exec.agent);
      if (index.size === 0) throw new Error(`${searchToolName}: no tool is registered in this session`);
      const matches = searchIndex(index, query, limit, stem);
      const found = matches.filter((match) => match.found).map((match) => match.name);
      // Connecting before answering is what makes "call it directly afterwards"
      // true: a deferred server has no registered tools, so returning a schema
      // would point at a tool that does not exist yet.
      const loadErrors = [];
      const servers = new Set(found.map((toolName) => uniqueServerOf(toolName)?.name).filter((serverName) => typeof serverName === 'string'));
      for (const serverName of servers) {
        const entry = entryByName(serverName);
        if (entry === undefined || entry.tier === 'disabled') continue;
        if (session.runtime.connections.has(entry.name)) continue;
        try {
          await ensureSessionEntry(session, entry);
        } catch (error) {
          loadErrors.push(`${serverName}: ${String(error?.message ?? error)}`);
        }
      }
      const discoveredNow = discover(session.state, found.filter((toolName) => tierOfName(toolName) !== 'disabled'));
      if (discoveredNow.length > 0) evict(session.state, Math.max(maxDiscovered, discoveredNow.length));
      return {
        protocol: META_PROTOCOL,
        query,
        matches,
        discoveredTools: discoveredNow,
        discoveredCount: session.state.discovered.size,
        ...(loadErrors.length > 0 ? { loadErrors } : {}),
        instruction:
          matches.length > 0
            ? 'Call any returned tool directly by its exact name with arguments matching the returned parameters schema.'
            : 'No tool matched. Rephrase the query with exact capability words, or consult the deferred catalog section of the prompt.',
        allDiscoveredTools: [...session.state.discovered.keys()].sort(),
      };
    },
  };

  // ── mcp_register / mcp_load / mcp_call ──

  const mcpRegister = {
    name: 'mcp_register',
    description:
      'Register (add) or modify an MCP server entry. Validates by trial-connecting (30s) and listing tools, then persists to the registry. The server\'s own description/version/title/website/instructions are captured from it during the trial connection. Reuse it to change tier, connection parameters, or notes. Only connection-contract changes re-connect; changing notes or downgrading to disabled skips the trial connection.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Stable server name ([A-Za-z0-9_-]{1,32}); the model-facing namespace.' },
        tier: { type: 'string', enum: [...TIERS], description: 'Default on-demand.' },
        transport: { type: 'string', enum: ['stdio', 'streamable-http'], description: 'Required on add.' },
        command: { type: 'string', description: 'stdio: executable to spawn.' },
        args: { type: 'array', items: { type: 'string' }, description: 'stdio: argument array (no shell).' },
        env: { type: 'object', description: 'stdio: extra env; a value may be a literal or a $VAR reference.' },
        cwd: { type: 'string', description: 'stdio: working directory.' },
        url: { type: 'string', description: 'streamable-http: server URL.' },
        headers: { type: 'object', description: 'streamable-http: extra headers.' },
        notes: { type: 'string', description: 'Optional USER-maintained note (never overwritten); surfaced in the deferred catalog.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return registerServer(args ?? {}, exec ?? {});
    },
  };

  async function registerServer(args, exec) {
    assertServerName(args.name);
    const tier = args.tier ?? 'on-demand';
    if (!isTier(tier)) throw new Error(`invalid tier "${tier}"`);
    const existingIndex = registry.entries.findIndex((entry) => isMcp(entry) && entry.name === args.name);
    const existing = existingIndex >= 0 ? registry.entries[existingIndex] : undefined;
    const transport = args.transport ?? existing?.transport;
    if (transport === undefined) throw new Error('`transport` is required when registering a new MCP server');
    if (transport === 'stdio' && !args.command && !existing?.command) throw new Error('stdio transport requires `command`');
    if (transport === 'streamable-http' && !args.url && !existing?.url) throw new Error('streamable-http transport requires `url`');

    const localChange = localExecutionChange(existing, args, transport);
    if (localChange !== null) await approveLocalExecution(exec, localChange);

    const needsTrial =
      tier === 'eager' ||
      args.transport !== undefined ||
      args.command !== undefined ||
      args.url !== undefined ||
      args.env !== undefined ||
      args.headers !== undefined ||
      args.args !== undefined ||
      args.cwd !== undefined;

    let snapshot = existing?.tools ?? [];
    let trialMeta = null;
    if (needsTrial) {
      const candidate = buildEntry(args, existing);
      const connection = await connectEntry(candidate, { timeoutMs: trialTimeoutMs, version: PLUGIN_VERSION, stdioMaxBufferSizeBytes });
      try {
        snapshot = snapshotOf(connection);
        trialMeta = connection;
      } finally {
        await connection.client.close();
      }
    }
    const entry = buildEntry(args, existing, snapshot);
    if (trialMeta !== null) applyServerMetadata(entry, trialMeta);
    if (existingIndex >= 0) registry.entries[existingIndex] = entry;
    else registry.entries.push(entry);
    await saveRegistry(dataDir, registry);
    if (needsTrial) eagerConnectFailed.delete(entry.name);
    if (tier !== 'eager') await disposeEverywhere(entry.name);
    await reconcile();
    return { text: `MCP "${entry.name}" ${existingIndex >= 0 ? 'updated' : 'registered'} (tier=${entry.tier}, ${snapshot.length} tool(s)).` };
  }

  const mcpLoad = {
    name: 'mcp_load',
    description:
      'Load (or hot-reload) one non-disabled MCP server for the current session and return its full tool definitions (names, descriptions, parameter schemas). Its tools also become callable directly for this session, exactly as if the search tool had returned them. With peek=true it only reads the latest snapshot or this session\'s active connection, without connecting.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Registered MCP server name.' },
        peek: { type: 'boolean', description: 'Default false. true = only inspect, never connect or reload.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const entry = entryByName(args.name);
      if (entry === undefined) throw new Error(`MCP "${args.name}" is not registered`);
      if (entry.tier === 'disabled') throw new Error(`MCP "${args.name}" is disabled`);
      if (args.peek === true) {
        const session = exec?.agent === undefined ? undefined : sessionFor(exec.agent);
        const tools = session?.runtime.connections.get(entry.name)?.tools ?? entry.tools ?? [];
        return { text: renderDefinitions(entry, tools) };
      }
      if (exec?.agent === undefined) throw new Error('mcp_load requires a session');
      const session = sessionFor(exec.agent);
      restoreDiscovery(session);
      try {
        await session.runtime.disposeEntry(entry.name);
        await ensureSessionEntry(session, entry);
        entry.lastLoadAt = new Date().toISOString();
        await saveRegistry(dataDir, registry);
        eagerConnectFailed.delete(entry.name);
        // Loading is discovery: the model just received every schema, so every
        // tool of the server is reachable from now on.
        const enabled = (entry.tools ?? []).filter((tool) => !disabledToolNames(entry).has(tool.name)).map((tool) => publicToolName(entry.name, tool.name));
        discover(session.state, enabled);
        evict(session.state, Math.max(maxDiscovered, enabled.length));
        return { text: renderDefinitions(entry, entry.tools) };
      } catch (error) {
        if (entry.tier === 'eager') eagerConnectFailed.add(entry.name);
        throw error;
      }
    },
  };

  function renderDefinitions(entry, tools) {
    const disabled = disabledToolNames(entry);
    const visible = (tools ?? []).filter((tool) => !disabled.has(tool.name));
    // Show each tool's ACTUAL model-facing name, not a template.
    //
    // The previous version interpolated a `<tool>` placeholder through
    // `publicToolName`, which hashes anything that breaks the function-name
    // contract — so the header read
    // `mcp__chrome-devtools___tool__77b88114da2b`. That string is not a tool
    // and cannot be corrected into one by the model; it is exactly the kind of
    // plausible-looking nonsense this plugin exists to remove.
    const example = visible.length > 0 ? publicToolName(entry.name, visible[0].name) : `mcp__${entry.name}__<tool>`;
    const lines = [
      `MCP "${entry.name}" (${entry.tier}) — the tools below are callable directly by their exact name, e.g. ${example}`,
      entry.serverDescription ? `description: ${entry.serverDescription}` : 'description: (no description)',
      entry.serverName ? `serverName: ${entry.serverName}` : '',
      entry.serverVersion ? `version: ${entry.serverVersion}` : '',
      entry.serverTitle ? `title: ${entry.serverTitle}` : '',
      entry.websiteUrl ? `website: ${entry.websiteUrl}` : '',
      entry.instructions ? `instructions: ${entry.instructions}` : '',
      entry.notes ? `notes: ${entry.notes}` : '',
      '',
      'Tools:',
      ...visible.map((tool) => {
        const publicName = publicToolName(entry.name, tool.name);
        // The public name is only worth showing when normalisation or hashing
        // changed it; otherwise it repeats the raw name the line already has.
        const alias = publicName === tool.name ? '' : `\n    callableAs: ${publicName}`;
        const schema = tool.inputSchema ? `\n    inputSchema: ${JSON.stringify(tool.inputSchema)}` : '';
        return `- ${tool.name}: ${tool.description ?? ''}${alias}${schema}`;
      }),
    ];
    return lines.filter((line) => line !== '').join('\n');
  }

  const mcpCallProjections = new WeakMap();
  const mcpCall = {
    name: 'mcp_call',
    description:
      'Invoke one tool of an on-demand MCP server through the bridge. The server must be loaded first via mcp_load; calling an unloaded server returns an error telling you to mcp_load first. Pass structured `args` only (never shell text, never a temp file). Once loaded, its tools are also callable directly as mcp__<server>__<tool>, which is the preferred form.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Registered MCP server name.' },
        tool: { type: 'string', description: 'Raw tool name as reported by mcp_load.' },
        args: { type: 'object', description: 'Structured JSON arguments matching the tool inputSchema.' },
      },
      required: ['name', 'tool'],
      additionalProperties: false,
    },
    output: createMcpResultOutput(undefined, (args) => args.tool),
    finalizeContent(exec, result) {
      return finalizeMcpResultContent(mcpCallProjections, exec, result);
    },
    async execute(args, exec) {
      // The model sometimes nests the tool call inside "args"; that used to slip
      // through as params.name=undefined and produce an opaque server-side
      // -32602. Reject early with the correct shape; never auto-unwrap.
      if (typeof args.tool !== 'string' || args.tool === '') {
        const nested =
          args.args !== null && typeof args.args === 'object' && !Array.isArray(args.args) && typeof args.args.tool === 'string' && args.args.tool !== '';
        throw new Error(
          nested
            ? `mcp_call parameter shape error: the tool name was nested inside "args" (args.tool="${args.args.tool}"). Correct shape: {"name":"<server name>","tool":"<raw tool name>","args":{...tool arguments...}} — "tool" is a TOP-LEVEL string field; only the tool's own arguments go inside "args".`
            : 'mcp_call requires a top-level "tool" string field. Correct shape: {"name":"<server name>","tool":"<raw tool name>","args":{...tool arguments...}}.',
        );
      }
      if (args.args !== undefined && (args.args === null || typeof args.args !== 'object' || Array.isArray(args.args))) {
        throw new Error(
          `mcp_call "args" must be an object holding the tool arguments (or omitted entirely for no-argument tools), got ${Array.isArray(args.args) ? 'an array' : JSON.stringify(args.args)}.`,
        );
      }
      const entry = entryByName(args.name);
      if (entry === undefined) throw new Error(`MCP "${args.name}" is not registered`);
      if (entry.tier === 'disabled') throw new Error(`MCP "${args.name}" is disabled`);
      if (disabledToolNames(entry).has(args.tool)) throw new Error(`MCP tool "${entry.name}/${args.tool}" is disabled`);
      if (exec?.agent === undefined) throw new Error('mcp_call requires a session');
      const session = sessionFor(exec.agent);
      const connection = session.runtime.connections.get(entry.name);
      if (connection === undefined) throw new Error(`MCP "${args.name}" is not loaded — call mcp_load first`);
      const target = Array.isArray(connection.tools) ? connection.tools.find((tool) => tool.name === args.tool) : undefined;
      const errorContext = { server: entry.name, inputSchema: target?.inputSchema };
      const result = await callTool(connection.client, args.tool, args.args, { timeoutMs: toolCallTimeoutMs, signal: exec.signal, errorInfo: errorContext });
      return settleMcpToolResult(ctx, exec, mcpCallProjections, result, args.tool, isErrorContextSuffix(errorContext, args.tool, args.args));
    },
  };

  // ── local command approval ──

  function followMustAsk(agent) {
    const policy = ctx.get('sandboxPolicy');
    if (policy === undefined || typeof policy.resolve !== 'function' || agent?.session === undefined) return true;
    return policy.resolve({ session: agent.session }).mode !== 'danger-full-access';
  }

  async function approveLocalExecution(exec, change) {
    if (localCommandApproval === 'always-allow') return;
    const approval = ctx.get('approval');
    // No approval service means this host has no ask channel: keep the previous
    // silent allow rather than blocking every registration.
    if (approval === undefined || typeof approval.request !== 'function') return;
    const mustAsk = localCommandApproval === 'always-ask' || followMustAsk(exec?.agent);
    if (!mustAsk) return;
    const agent = exec?.agent;
    if (agent?.session === undefined) throw new Error('local command approval has no session to ask; the entry was not saved and was not started');
    const outcome = await approval.request({
      agent,
      toolName: 'mcp_register',
      reason: localExecutionReason(change),
      ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
      ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
    });
    if (outcome !== 'allowed-once') throw new Error(`local command was not approved (${outcome}); the entry was not saved and was not started`);
  }

  // ── prompt: projection, catalog, PTC trimming ──

  /**
   * The names the model must not see in this assembly.
   *
   * A deny-list, never an allow-list: an assembly can carry tools this plugin
   * never indexed (another plugin's provider, a preset-scoped registration), and
   * an allow-list would delete them.
   */
  function hiddenTools(session) {
    const hidden = new Set();
    for (const [toolName, tier] of builtinTiers) {
      if (tier === 'disabled') hidden.add(toolName);
      else if (tier === 'on-demand' && !session.state.discovered.has(toolName)) hidden.add(toolName);
    }
    for (const entry of mcpEntries()) {
      if (entry.tier === 'eager') continue;
      for (const tool of entry.tools ?? []) {
        const publicName = publicToolName(entry.name, tool.name);
        if (entry.tier === 'disabled') hidden.add(publicName);
        else if (!session.state.discovered.has(publicName)) hidden.add(publicName);
      }
    }
    return hidden;
  }

  function catalogGroups(session) {
    const groups = [];
    for (const entry of mcpEntries()) {
      if (entry.tier !== 'on-demand') continue;
      const disabled = disabledToolNames(entry);
      const tools = (entry.tools ?? [])
        .filter((tool) => !disabled.has(tool.name))
        .map((tool) => ({ name: publicToolName(entry.name, tool.name), description: tool.description ?? '' }))
        .filter((tool) => !session.state.discovered.has(tool.name));
      const row = buildGroupRow({
        name: entry.name,
        description: entry.serverDescription ?? '',
        notes: entry.notes ?? '',
        tools,
        options: { toolDescriptionMaxLength, catalogDescriptionMaxLength, granularity: catalogGranularity },
      });
      if (row !== null) groups.push(row);
    }
    const deferredBuiltins = [];
    for (const [toolName, tier] of builtinTiers) {
      if (tier !== 'on-demand' || session.state.discovered.has(toolName)) continue;
      let description = '';
      try {
        description = ctx.tools.get(toolName)?.description ?? '';
      } catch {
        description = '';
      }
      deferredBuiltins.push({ name: toolName, description });
    }
    if (deferredBuiltins.length > 0) {
      groups.push(
        buildGroupRow({
          name: 'built-in',
          description: 'harness built-in tools currently set to on-demand',
          notes: '',
          tools: deferredBuiltins,
          // A built-in has no server-level identity, so its tools are always
          // listed: the name IS the whole purpose for these.
          options: { toolDescriptionMaxLength, catalogDescriptionMaxLength, granularity: 'tool' },
        }),
      );
    }
    return groups.filter((row) => row !== null);
  }

  function maskGuidance(assembly) {
    const sections = assembly.sections ?? [];
    if (!sections.some((section) => section?.name === GUIDANCE_SECTION_NAME)) return assembly;
    return { ...assembly, sections: sections.map((section) => (section?.name === GUIDANCE_SECTION_NAME ? { ...section, text: '' } : section)) };
  }

  const listeners = [];

  listeners.push(
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const resolved = await next();
      const agent = context?.agent;
      if (agent === undefined) return resolved;
      let session;
      try {
        session = sessionFor(agent);
        restoreDiscovery(session);
      } catch {
        // Assembly must never throw here: a throwing listener fails the whole
        // step. Falling through to the unmodified assembly is the safe answer.
        return resolved;
      }
      let projected = projectTools(resolved, hiddenTools(session));
      const groups = catalogGroups(session);
      if (groups.length === 0) {
        // Nothing is deferred, so the guidance paragraph would be teaching the
        // model to search a catalog that is not there. Clear its text instead of
        // removing the section: the renderer drops empty sections, and the
        // section list keeps its shape.
        return maskGuidance(projected);
      }
      const { revision } = indexFor(agent);
      const text = catalogCache.get(`${revision}:${session.state.version}:${catalogGranularity}`, () => renderCatalogText(groups, searchToolName));
      const sections = [...(projected.sections ?? [])];
      if (!sections.some((section) => section?.name === CATALOG_SECTION_NAME)) sections.push(promptSection(CATALOG_SECTION_NAME, text));
      projected = { ...projected, sections };
      if (trimPtcManual) {
        try {
          projected = await trimSdkSections(
            ctx,
            projected,
            context,
            { revision },
            (toolName) => tierOfName(toolName) === 'on-demand' && !session.state.discovered.has(toolName),
            caps,
          );
        } catch (error) {
          // Deferral is an optimisation, never a correctness mechanism: the
          // worst case must be today's behaviour, not a failed assembly.
          ctx.logger.warn(`toolsearch-manage: tools:sdk trim skipped: ${String(error?.message ?? error)}`);
        }
      }
      return projected;
    }),
  );

  // The guard is the execution-side half of the same decision. It is
  // synchronous by contract, which is what makes it safe under parallel tool
  // calls: no await sits between reading the discovery set and denying.
  listeners.push(
    ctx.tools.guard((execution) => {
      const agent = execution?.agent;
      const toolName = execution?.name;
      if (agent === undefined || typeof toolName !== 'string') return undefined;
      if (metaTools.has(toolName)) return undefined;
      const tier = tierOfName(toolName);
      if (tier === 'disabled') return guardDecision(toolName, 'disabled', searchToolName);
      if (tier !== 'on-demand') return undefined;
      const session = sessions.get(agent);
      if (session === undefined) return guardDecision(toolName, 'on-demand', searchToolName);
      restoreDiscovery(session);
      if (session.state.discovered.has(toolName)) {
        // Discovered: record the use so eviction drops the coldest instead of
        // the tool the model is actively calling. This is the only write path.
        touch(session.state, toolName);
        return undefined;
      }
      return guardDecision(toolName, 'on-demand', searchToolName);
    }),
  );

  // A new or removed tool changes the built-in inventory. (MCP tools are known
  // from the registry, so their arrival does not need a resync.)
  listeners.push(
    ctx.on('tools/change', () => {
      syncBuiltins();
    }),
  );

  const auditRunner =
    profile === '__test__'
      ? { kick() {}, read: async () => null, running: () => false, checked: () => false }
      : createAuditRunner(dataDir, join(dshHome(), 'sessions'), ctx.logger);

  // ── UI handlers ──

  const uiHandlers = buildUiHandlers();

  // ── effect-owned registrations (synchronous, before any await) ──

  const toolDisposers = [ctx.tools.register(searchTool), ctx.tools.register(mcpRegister), ctx.tools.register(mcpLoad), ctx.tools.register(mcpCall), ctx.tools.register(pluginCheckTool)];
  const systemPromptService = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined;

  // Self-update notice: replace the static guidance with a version that may
  // gain one update line once the throttled GitHub tag check resolves. The
  // section object supports `update(text)`; when it does not, the check still
  // runs and logs — the notice just waits for the next boot's section.
  const guidanceSection = systemPromptService?.section
    ? promptSection(GUIDANCE_SECTION_NAME, guidanceText(searchToolName), GUIDANCE_SECTION_ORDER)
    : null;
  const guidanceDisposer =
    guidanceSection !== null && typeof systemPromptService.section === 'function'
      ? systemPromptService.section(guidanceSection)
      : () => {};
  if (guidanceSection !== null) {
    void selfUpdateNotice({
      currentVersion: PLUGIN_VERSION,
      repo: 'yunsheng111/dsh-toolsearch-manage',
      stateFile: join(dataDir, 'self-update.json'),
    })
      .then((notice) => {
        if (notice === null) return;
        ctx.logger.info('toolsearch-manage: ' + notice);
        if (typeof guidanceSection.update === 'function') guidanceSection.update(guidanceText(searchToolName) + '\n\n' + notice);
      })
      .catch(() => {});
  }

  ctx.effect(() => () => {
    for (const dispose of [...toolDisposers, guidanceDisposer, ...listeners]) {
      try {
        dispose();
      } catch {
        /* a disposer that already ran is not an error */
      }
    }
    for (const agent of [...knownAgents]) {
      const session = sessions.get(agent);
      sessions.delete(agent);
      if (session !== undefined) void session.runtime.disposeAll();
    }
    knownAgents.clear();
  });

  // Optional faces. `ctx.inject` keeps the plugin active without them: a profile
  // with no `dsh-skill` loses only the skill drawer, and one with no web bundle
  // loses only the settings page.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (hostCtx) => {
      registerRecursiveSkillProvider(hostCtx, dataDir);
    });
    ctx.inject(['webServer'], (hostCtx) => {
      mountUi(hostCtx, uiHandlers, { dataDir, webServer: hostCtx.webServer });
    });
  }
  // The discovery projection is host-only (no `wire`): it is a restore seed, not
  // something the Client reads.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['sessionProjections'], (hostCtx) => {
      try {
        hostCtx.sessionProjections.register(discoveryProjection({ z, toolName: searchToolName, max: Math.max(maxDiscovered * 4, 100) }));
      } catch (error) {
        ctx.logger.warn(`toolsearch-manage: discovery projection not registered: ${String(error?.message ?? error)}`);
      }
    });
  }

  // ── startup ──

  const loaded = await loadRegistry(dataDir);
  registry = loaded.registry;
  if (loaded.migrated) {
    // Persist the migration immediately: a v1 file plus a v2 reader works, but a
    // half-migrated file is not worth the risk of a later crash.
    await saveRegistry(dataDir, registry);
    ctx.logger.info(`toolsearch-manage: migrated registry.json to version ${REGISTRY_VERSION} (${registry.entries.length} entries)`);
  }
  try {
    const settings = await loadSettings(dataDir);
    if (typeof settings.toolDescriptionMaxLength === 'number' && settings.toolDescriptionMaxLength >= 4) toolDescriptionMaxLength = settings.toolDescriptionMaxLength;
    if (settings.catalogGranularity === 'tool' || settings.catalogGranularity === 'server') catalogGranularity = settings.catalogGranularity;
    if (LOCAL_COMMAND_APPROVALS.has(settings.localCommandApproval)) localCommandApproval = settings.localCommandApproval;
    if (settings.uiPlacement === 'settings' || settings.uiPlacement === 'sidebar' || settings.uiPlacement === 'both') uiPlacement = settings.uiPlacement;
    if (Array.isArray(settings.lanHostAllowlist)) {
      try {
        lanHostAllowlist = normalizeLanHostAllowlist(settings.lanHostAllowlist);
      } catch {
        /* a corrupt allowlist must not block startup; the default is empty */
      }
    }
    if (settings.stdioMaxBufferSizeMb !== undefined) applyStdioMaxBufferSizeSetting(settings.stdioMaxBufferSizeMb);
    if (settings.builtinTiers && typeof settings.builtinTiers === 'object') {
      for (const [toolName, tier] of Object.entries(settings.builtinTiers)) if (isTier(tier)) builtinTiers.set(toolName, tier);
    }
  } catch {
    /* settings.json unreadable — keep the config defaults */
  }
  syncBuiltins();
  // A previous run may have written its block into the wrong profile — the exact
  // failure this plugin was built to fix, and one it can hit itself if the launch
  // signal changes. Cleaning up other profiles' stray blocks before reconciling
  // keeps a detection error self-correcting instead of permanent.
  await releaseForeignPatchBlocks();
  const imported = await reconcile();
  // Another writer can remove the block while this process is running, so one
  // startup reconcile is not enough. See watchPatchOwnership for the case that
  // actually happened here.
  watchPatchOwnership();
  // Warm-up is NOT awaited. It opens one connection per entry with no cached
  // snapshot, each bounded by `trialTimeoutMs` — three cold servers at 30 s each
  // is 90 s sitting inside `apply()`, and the desktop host fails `host-boot` on a
  // ~120 s watchdog, which drops the app into safe mode. That is not theoretical:
  // the previous plugin's history scan did exactly this twice.
  //
  // The catalog only needs the snapshots, and the catalog is read at assembly
  // time, long after boot. So the warm-up runs in the background and logs when it
  // lands; a session that assembles before it finishes simply catalogs what the
  // registry already knows.
  void warmSnapshots()
    .then((changed) => {
      if (changed) ctx.logger.info(`toolsearch-manage: snapshots warmed (${mcpEntries().filter((entry) => (entry.tools ?? []).length > 0).length} server(s) with tools)`);
    })
    .catch((error) => ctx.logger.warn(`toolsearch-manage: snapshot warm-up failed: ${String(error?.message ?? error)}`));
  ctx.logger.info(
    `toolsearch-manage: ready (${mcpEntries().length} MCP servers, ${builtinTiers.size} built-in tools, imported ${imported}, profile=${profile}, patch=${patchPath}, search=${searchToolName}, dataDir=${dataDir})`,
  );

  // ── handlers ──

  function buildUiHandlers() {
    const readSourceText = async (filePath, maxBytes) => {
      const { stat } = await import('node:fs/promises');
      const info = await stat(filePath);
      if (info.size > maxBytes) {
        const error = new Error(`file exceeds ${maxBytes} bytes`);
        error.code = 'CODE_TOO_LARGE';
        throw error;
      }
      return readFile(filePath, 'utf8');
    };
    const importContext = () => ({ platform: process.platform, home: homedir(), env: process.env, cwd: process.cwd() });

    const handlers = {
      // — capabilities —
      async listCapabilities(reveal) {
        const entries = mcpEntries().map((entry) => ({
          ...entryView(entry, reveal, { connectFailed: entry.tier === 'eager' && eagerConnectFailed.has(entry.name) }),
          kind: 'mcp',
          tools: (entry.tools ?? []).map((tool) => {
            const publicName = publicToolName(entry.name, tool.name);
            return {
              name: tool.name,
              publicName,
              description: tool.description ?? '',
              enabled: !disabledToolNames(entry).has(tool.name),
              tier: tierOfName(publicName),
            };
          }),
        }));
        let schemas = [];
        try {
          schemas = ctx.tools.schemas() ?? [];
        } catch {
          schemas = [];
        }
        const builtins = schemas
          .filter((schema) => typeof schema?.name === 'string' && !schema.name.startsWith('mcp__') && !metaTools.has(schema.name))
          .map((schema) => ({
            id: schema.name,
            kind: 'builtin',
            name: schema.name,
            tier: tierOfName(schema.name),
            description: schema.description ?? '',
          }));
        return { entries, builtins, metaTools: [...metaTools], rules: currentRules() };
      },
      async setTier(serverName, tier) {
        if (!isTier(tier)) throw new Error(`invalid tier "${tier}"`);
        const entry = entryByName(serverName);
        if (entry === undefined) throw new Error(`MCP "${serverName}" is not registered`);
        const wasEager = entry.tier === 'eager';
        if (tier === 'eager' && !wasEager) {
          // Switching to eager means "these tools are always in the table", so
          // the snapshot must exist before the switch takes effect.
          const connection = await connectEntry({ ...entry, tier }, { timeoutMs: trialTimeoutMs, version: PLUGIN_VERSION, stdioMaxBufferSizeBytes });
          try {
            entry.tools = snapshotOf(connection);
          } finally {
            await connection.client.close();
          }
          eagerConnectFailed.delete(serverName);
        }
        entry.tier = tier;
        entry.lastSyncAt = new Date().toISOString();
        await saveRegistry(dataDir, registry);
        if (tier === 'eager') {
          for (const session of liveSessions()) {
            try {
              await ensureSessionEntry(session, entry);
              for (const tool of entry.tools ?? []) discover(session.state, [publicToolName(entry.name, tool.name)]);
            } catch (error) {
              ctx.logger.error(`toolsearch-manage: eager start for "${entry.name}" failed: ${String(error?.message ?? error)}`);
            }
          }
        } else {
          eagerConnectFailed.delete(serverName);
          await disposeEverywhere(serverName);
        }
        await reconcile();
        return entryView(entry, false, {});
      },
      async setBuiltinTier(toolName, tier) {
        if (!isTier(tier)) throw new Error(`invalid tier "${tier}"`);
        if (metaTools.has(toolName)) throw new Error(`"${toolName}" is this plugin's own management tool and must stay eager`);
        builtinTiers.set(toolName, tier);
        const settings = await loadSettings(dataDir);
        settings.builtinTiers = Object.fromEntries(builtinTiers);
        await saveSettings(dataDir, settings);
        return { name: toolName, tier };
      },
      async setToolEnabled(serverName, toolName, enabled) {
        if (typeof toolName !== 'string' || toolName === '') throw new Error('tool name is required');
        if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
        const entry = entryByName(serverName);
        if (entry === undefined) throw new Error(`MCP "${serverName}" is not registered`);
        if (!(entry.tools ?? []).some((tool) => tool.name === toolName)) throw new Error(`MCP tool "${serverName}/${toolName}" is not in the latest tool snapshot`);
        const disabled = disabledToolNames(entry);
        if (enabled) disabled.delete(toolName);
        else disabled.add(toolName);
        entry.disabledTools = [...disabled];
        entry.lastSyncAt = new Date().toISOString();
        await saveRegistry(dataDir, registry);
        if (entry.tier === 'eager') {
          for (const session of liveSessions()) {
            const connection = session.runtime.connections.get(entry.name);
            if (connection !== undefined) registerEntryTools(session, entry, connection);
          }
        }
        return { ok: true };
      },
      async deleteMcp(serverName) {
        const index = registry.entries.findIndex((entry) => isMcp(entry) && entry.name === serverName);
        if (index < 0) throw new Error(`MCP "${serverName}" is not registered`);
        await disposeEverywhere(serverName);
        eagerConnectFailed.delete(serverName);
        retiredRowIds.add(entryRowId(registry.entries[index]));
        registry.entries.splice(index, 1);
        await saveRegistry(dataDir, registry);
        await reconcile();
        return { ok: true };
      },
      async peekMcp(serverName) {
        const entry = entryByName(serverName);
        if (entry === undefined) throw new Error(`MCP "${serverName}" is not registered`);
        if (entry.tier === 'disabled') throw new Error(`MCP "${serverName}" is disabled`);
        return { ok: true, text: renderDefinitions(entry, entry.tools ?? []) };
      },
      async refreshSnapshot(serverName) {
        const entry = entryByName(serverName);
        if (entry === undefined) throw new Error(`MCP "${serverName}" is not registered`);
        if (entry.tier === 'disabled') throw new Error(`MCP "${serverName}" is disabled`);
        const connection = await connectEntry(entry, { timeoutMs: trialTimeoutMs, version: PLUGIN_VERSION, stdioMaxBufferSizeBytes });
        try {
          entry.tools = snapshotOf(connection);
          applyServerMetadata(entry, connection);
          entry.lastLoadAt = new Date().toISOString();
          await saveRegistry(dataDir, registry);
          eagerConnectFailed.delete(entry.name);
          return { ok: true, text: renderDefinitions(entry, entry.tools) };
        } finally {
          try {
            await connection.client.close();
          } catch {
            /* already closed */
          }
        }
      },
      async registerServer(body) {
        // The UI action and the agent tool are the SAME operation, by design:
        // identical parameters, identical validation, one implementation.
        const result = await registerServer(body ?? {}, {});
        syncBuiltins();
        return result;
      },
      // — skills —
      async listSkills() {
        const skillsService = ctx.get('skills');
        if (skillsService === undefined) throw new Error('the skills service is not composed in this profile');
        const lookup = await skillLookup();
        const summaries = await skillsService.list(lookup);
        const views = [];
        for (const summary of summaries) {
          const definition = await resolveSkillPath(skillsService, summary.name, lookup);
          if (definition === undefined) continue;
          views.push({
            name: definition.name,
            description: definition.description ?? '',
            path: definition.path,
            directory: dirname(definition.path),
            source: definition.source ?? '',
            provider: definition.provider ?? '',
            modelInvocable: definition.invocation?.modelInvocable !== false,
            userInvocable: definition.invocation?.userInvocable !== false,
            readonly: isReadonlySkillPath(definition.path),
          });
        }
        views.sort((a, b) => a.path.localeCompare(b.path));
        return views;
      },
      async toggleSkill(skillName, enabled) {
        const skillsService = ctx.get('skills');
        if (skillsService === undefined) throw new Error('the skills service is not composed in this profile');
        const definition = await resolveSkillPath(skillsService, skillName, await skillLookup());
        if (definition === undefined) throw new Error(`skill "${skillName}" not found or not a bundle skill`);
        if (isReadonlySkillPath(definition.path)) throw new Error(`skill "${skillName}" is shipped/read-only and cannot be toggled`);
        const result = await setDisableModelInvocation(definition.path, !enabled);
        return { name: definition.name, path: definition.path, modelInvocable: result.modelInvocable, changed: result.changed };
      },
      async openSkill(skillName) {
        const skillsService = ctx.get('skills');
        if (skillsService === undefined) throw new Error('the skills service is not composed in this profile');
        const definition = await resolveSkillPath(skillsService, skillName, await skillLookup());
        if (definition === undefined) throw new Error(`skill "${skillName}" not found or not a bundle skill`);
        if (!openWithSystemEditor(definition.path)) throw new Error(`no default handler available to open ${definition.path}`);
        return { ok: true, path: definition.path };
      },
      async deleteSkill(skillName) {
        const skillsService = ctx.get('skills');
        if (skillsService === undefined) throw new Error('the skills service is not composed in this profile');
        const definition = await resolveSkillPath(skillsService, skillName, await skillLookup());
        if (definition === undefined) throw new Error(`skill "${skillName}" not found or not a bundle skill`);
        if (isReadonlySkillPath(definition.path)) throw new Error(`skill "${skillName}" is shipped/read-only and cannot be deleted`);
        return trashDirectory(dirname(definition.path), dataDir);
      },
      // — market + import —
      async listMarket() {
        return {
          catalog: builtinMcpCatalog(mcpEntries()),
          categories: MCP_CATEGORIES,
          categoryLabels: MCP_CATEGORY_LABELS,
        };
      },
      async installMarket(ids) {
        if (!Array.isArray(ids) || ids.length === 0) throw new Error('select at least one catalog entry');
        const added = [];
        const skipped = [];
        for (const id of ids) {
          const builtin = BUILTIN_MCP_SERVERS.find((candidate) => candidate.id === id);
          if (builtin === undefined) throw new Error(`unknown catalog entry "${id}"`);
          if (mcpEntries().some((server) => matchesBuiltinIdentity(server, builtin)) || entryByName(builtin.name) !== undefined) {
            skipped.push(id);
            continue;
          }
          registry.entries.push(marketEntry(builtin));
          added.push(id);
        }
        await saveRegistry(dataDir, registry);
        await reconcile();
        return { added, skipped };
      },
      async listImportSources() {
        const rows = await collectImportLocations(importContext(), readSourceText, 'global');
        return { sources: IMPORT_SOURCES.map((source) => ({ id: source.id, label: source.label })), rows };
      },
      async previewImport(sourceId) {
        return resolveImportLocation(importContext(), { sourceId, scope: 'global' }, readSourceText);
      },
      async applyImport(sourceId, names) {
        const row = await resolveImportLocation(importContext(), { sourceId, scope: 'global' }, readSourceText);
        if (row.error !== '') throw new Error(row.error);
        const wanted = Array.isArray(names) && names.length > 0 ? new Set(names) : undefined;
        const added = [];
        const skipped = [];
        for (const item of row.entries) {
          if (item.error !== null) {
            skipped.push({ name: item.name, reason: item.error });
            continue;
          }
          if (wanted !== undefined && !wanted.has(item.name)) continue;
          if (entryByName(item.spec.name) !== undefined) {
            skipped.push({ name: item.name, reason: 'a server with this name is already registered' });
            continue;
          }
          registry.entries.push(importedEntry(item.spec));
          added.push(item.name);
        }
        await saveRegistry(dataDir, registry);
        await reconcile();
        return { added, skipped, warnings: row.warnings };
      },
      async importJson(text) {
        const normalized = normalizeMcpImport(typeof text === 'string' ? JSON.parse(text) : text);
        const added = [];
        const skipped = [];
        for (const spec of normalized.servers) {
          if (entryByName(spec.name) !== undefined) {
            skipped.push({ name: spec.name, reason: 'already registered' });
            continue;
          }
          registry.entries.push(importedEntry(spec));
          added.push(spec.name);
        }
        await saveRegistry(dataDir, registry);
        await reconcile();
        return { added, skipped, warnings: normalized.warnings };
      },
      // — settings —
      async probePlugin(body) {
        const name = typeof body?.package === 'string' ? body.package.trim() : '';
        if (name === '') throw new Error('package 不能为空');
        return probePackage(name);
      },
      async auditNow() {
        return auditProfile(join(dshHome(), 'profiles', profile));
      },
      /**
       * 任务委派：把分析任务交给一个独立的 dsh headless 会话。环境三件套
       * （node24 / bin.js / MAGPIE key）与 plugin-guard CLI 同源；工作区固定
       * 默认工作区，DSH 的报告落盘约定由任务文本自带。
       */
      async delegateTask(body) {
        const text = typeof body?.task === 'string' ? body.task.trim() : '';
        if (text === '') throw new Error('task 不能为空');
        const { spawn } = await import('node:child_process');
        const { existsSync: ex, readFileSync: rf } = await import('node:fs');
        const { homedir: hd } = await import('node:os');
        const node24 = join(dshHome(), 'dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe');
        const binCandidates = [
          process.env.DSH_BIN,
          'D:/Program Files/nvm/node_global/node_modules/@deepseek-ai/dsh/lib/bin.js',
          'C:/Program Files/nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js',
        ].filter(Boolean);
        const bin = binCandidates.find((p) => ex(p));
        let key = process.env.MAGPIE_GATEWAY_KEY;
        if (!key) {
          try {
            key = rf(join(dshHome(), '.credentials.yaml'), 'utf8').match(/^\s*MAGPIE_GATEWAY_KEY:\s*(\S+)\s*$/m)?.[1]?.replace(/^['"]|['"]$/g, '');
          } catch { /* 无凭据文件 */ }
        }
        const missing = [];
        if (!ex(node24)) missing.push('宿主 node24');
        if (!bin) missing.push('dsh CLI bin.js（可设 DSH_BIN）');
        if (!key) missing.push('MAGPIE_GATEWAY_KEY');
        if (missing.length > 0) return { ok: false, error: '前置缺失：' + missing.join('、') };
        const workspace = join(hd(), 'Documents/deepseek-harness/default-workspace');
        const cwd = ex(workspace) ? workspace : join(dshHome());
        return new Promise((resolve) => {
          const child = spawn(node24, [bin, 'headless', text], {
            cwd,
            windowsHide: true,
            env: { ...process.env, MAGPIE_GATEWAY_KEY: key, CI: 'true' },
          });
          let out = '';
          const timer = setTimeout(() => { child.kill(); resolve({ ok: false, error: 'TIMEOUT（10 分钟）', output: out.slice(-600) }); }, 600_000);
          child.stdout.on('data', (d) => (out += d));
          child.stderr.on('data', (d) => (out += d));
          child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
          child.on('close', (code) => {
            clearTimeout(timer);
            resolve({
              ok: code === 0,
              error: code === 0 ? null : 'dsh exit ' + code,
              hint: code === 0 ? '任务完成，输出在工作区：' + workspace : undefined,
              output: code === 0 ? out.slice(-800) : out.slice(-400),
            });
          });
        });
      },
      async checkUpdate() {
        const r = await checkForUpdate(PLUGIN_VERSION);
        return { ...r, pluginVersion: PLUGIN_VERSION };
      },
      async applySelfUpdate(body) {
        const targetTag = typeof body?.targetTag === 'string' && /^v\d+\.\d+\.\d+$/.test(body.targetTag) ? body.targetTag : null;
        if (targetTag === null) throw new Error('targetTag 必须是 vX.Y.Z 形式');
        const profileDir = join(dshHome(), 'profiles', profile);
        const pre = preflightUpdate({ profileDir, targetTag });
        if (!pre.ok) return { ok: false, applied: false, blockers: pre.blockers };
        const r = await runUpdate({ profileDir, targetTag });
        if (r.ok !== true) {
          // EPERM is the one failure a running DSH can cause; everything else
          // is pnpm/network and retryable as-is.
          const conflict = /EPERM/i.test(r.output ?? '');
          return {
            ok: false,
            applied: false,
            error: r.error,
            output: (r.output ?? '').slice(-600),
            hint: conflict
              ? 'profile 文件被运行中的进程占用（EPERM）。重试一次；仍失败则退出 DSH 后用 update-to-tag 安装。'
              : 'pnpm 安装失败，可重试；持续失败时检查网络（GitHub 需可达）。',
          };
        }
        return {
          ok: true,
          applied: true,
          targetTag,
          hint: '已安装 ' + targetTag + '。重新打开设置页即可加载新版界面；插件代码由 HMR 热重载。',
        };
      },
      async getSettings() {
        return {
          pluginVersion: PLUGIN_VERSION,
          toolDescriptionMaxLength,
          catalogGranularity,
          localCommandApproval,
          uiPlacement,
          lanHostAllowlist: [...lanHostAllowlist],
          stdioMaxBufferSizeMb,
          searchToolName,
          profile,
          patchPath,
          rules: currentRules(),
          // Surfaced, not just logged: two deferred-tool searches visible at once
          // is a configuration the operator has to resolve, and a log line on a
          // host nobody watches is not a way to say so.
          searchConflict: searchToolConflictsWith(),
        };

        function searchToolConflictsWith() {
          if (searchToolName === (config.searchToolName ?? 'tool_search')) return undefined;
          try {
            const other = ctx.tools.get(config.searchToolName ?? 'tool_search');
            if (other === undefined) return undefined;
            return {
              preferredName: config.searchToolName ?? 'tool_search',
              registeredAs: searchToolName,
              description: String(other.description ?? '').slice(0, 200),
            };
          } catch {
            return undefined;
          }
        }
      },
      async setSettings(body) {
        const settings = await loadSettings(dataDir);
        if (body.toolDescriptionMaxLength !== undefined) {
          const n = Number(body.toolDescriptionMaxLength);
          if (!Number.isInteger(n) || n < 4 || n > 5000) throw new Error('toolDescriptionMaxLength must be an integer between 4 and 5000');
          toolDescriptionMaxLength = n;
          settings.toolDescriptionMaxLength = n;
        }
        if (body.catalogGranularity !== undefined) {
          if (body.catalogGranularity !== 'server' && body.catalogGranularity !== 'tool') throw new Error('catalogGranularity must be server or tool');
          catalogGranularity = body.catalogGranularity;
          settings.catalogGranularity = catalogGranularity;
          catalogCache.clear();
        }
        if (body.localCommandApproval !== undefined) {
          if (!LOCAL_COMMAND_APPROVALS.has(body.localCommandApproval)) throw new Error('localCommandApproval must be follow, always-ask, or always-allow');
          localCommandApproval = body.localCommandApproval;
          settings.localCommandApproval = body.localCommandApproval;
        }
        if (body.lanHostAllowlist !== undefined) {
          lanHostAllowlist = normalizeLanHostAllowlist(body.lanHostAllowlist);
          settings.lanHostAllowlist = [...lanHostAllowlist];
        }
        if (body.uiPlacement !== undefined) {
          if (body.uiPlacement !== 'settings' && body.uiPlacement !== 'sidebar' && body.uiPlacement !== 'both') {
            throw new Error('uiPlacement must be settings, sidebar, or both');
          }
          uiPlacement = body.uiPlacement;
          settings.uiPlacement = uiPlacement;
        }
        if (body.stdioMaxBufferSizeMb !== undefined) {
          const raw = body.stdioMaxBufferSizeMb;
          if (raw !== null && (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0)) {
            throw new Error('stdioMaxBufferSizeMb must be a positive integer (MB) or null for the SDK default');
          }
          applyStdioMaxBufferSizeSetting(raw);
          settings.stdioMaxBufferSizeMb = stdioMaxBufferSizeMb;
        }
        await saveSettings(dataDir, settings);
        return handlers.getSettings();
      },
      async getSessionAudit() {
        // This request IS the scan trigger, and the scan must not be awaited: it
        // takes tens of seconds and sits on the client's page-load path. The
        // client polls `scanning` instead.
        auditRunner.kick();
        if (auditRunner.running()) return { scanning: true };
        const record = await auditRunner.read();
        if (record === null) return { done: true, checked: auditRunner.checked() };
        return {
          done: true,
          checked: auditRunner.checked(),
          check: record.check === true,
          scanned: record.scanned,
          affected: record.affected,
          checkedAt: record.checkedAt,
        };
      },
      lanHostAllowlist() {
        return lanHostAllowlist;
      },
      /**
       * A browser-ready URL for this Harness UI, carrying the process launch
       * token.
       *
       * The token is minted per process and held only in memory
       * (`dsh-client-connection` keeps it in a WeakMap); it is deliberately not
       * in the environment, so a tool cannot obtain a usable UI URL on its own.
       * That is what makes it possible to verify a browser page from inside a
       * session without asking the user to copy one across.
       *
       * Gated on purpose, because it hands out a credential:
       *  - only a loopback peer may ask (the caller is already the machine);
       *  - the URL is the ordinary app URL plus the token, exactly what
       *    `dsh web` prints, so it grants no capability the operator does not
       *    already have at this terminal.
       */
      async loginUrl() {
        const connection = ctx.get('connection');
        if (connection === undefined || typeof connection.authenticatedUrl !== 'function') {
          throw new Error('this host does not expose connection.authenticatedUrl; open the URL printed by the launcher instead');
        }
        const server = ctx.get('webServer');
        if (server === undefined || typeof server.getOrigin !== 'function') {
          throw new Error('webServer is not composed in this profile');
        }
        const origin = server.getOrigin();
        return { ok: true, url: connection.authenticatedUrl(origin) };
      },
      prepareUninstall,
    };
    return handlers;
  }

  function currentRules() {
    return {
      eager: config.rules?.eager ?? [],
      'on-demand': config.rules?.['on-demand'] ?? [],
      disabled: config.rules?.disabled ?? [],
    };
  }

  /**
   * prepare-uninstall: flip managed shadow entries from `disabled: true` to an
   * enabled insert row, handing them back to the native client so the user's MCP
   * configuration survives uninstalling this plugin. A disabled-tier entry keeps
   * its flag, so the "off" choice survives too.
   */
  async function prepareUninstall() {
    let current;
    try {
      current = await readFile(patchPath, 'utf8');
    } catch {
      return { kind: 'error', text: `cannot read ${patchPath}` };
    }
    if (!current.includes(MANAGED_MARKER)) return { kind: 'success', text: 'No managed MCP block found — nothing to hand back.' };
    const { prefix, relocated, suffix } = splitPatchAroundManaged(current, MARKERS);
    const block = handoverBlockYaml(mcpEntries(), HANDOVER_MARKER);
    const next = stitchPatch(prefix, block, relocated, suffix);
    if (next !== current) await writePatch(patchPath, current, next);
    for (const entry of mcpEntries()) if (entry.tier === 'eager') await disposeEverywhere(entry.name);
    const count = mcpEntries().filter((entry) => entry.tier !== 'disabled').length;
    return {
      kind: 'success',
      text: `Handed ${count} MCP entry/entries back to native dsh-mcp-client. Remove the toolsearch-manage row from cordis.patch.yml to finish uninstalling.`,
    };
  }

  function marketEntry(builtin) {
    return mcpEntry({
      name: builtin.name,
      // A catalog entry starts on-demand: it was just installed, and its tools
      // should not consume the tool table before the operator has looked at it.
      tier: 'on-demand',
      transport: builtin.transport,
      command: builtin.command ?? null,
      args: builtin.args ?? [],
      env: builtin.env ?? {},
      cwd: builtin.cwd ?? null,
      url: builtin.url ?? null,
      headers: builtin.headers ?? {},
      systemEntryId: `mcp-${builtin.name}`,
    });
  }

  function importedEntry(spec) {
    return mcpEntry({
      name: spec.name,
      tier: 'on-demand',
      transport: spec.transport,
      command: spec.command ?? null,
      args: spec.args ?? [],
      env: spec.env ?? {},
      cwd: spec.cwd ?? null,
      url: spec.url ?? null,
      headers: spec.headers ?? {},
      toolCallTimeoutMs: spec.toolCallTimeoutMs,
      systemEntryId: `mcp-${spec.name}`,
    });
  }

  async function skillLookup() {
    const presets = ctx.get('agentPresets');
    if (presets === undefined || typeof presets.standingKeyFor !== 'function') return {};
    try {
      return { scope: await presets.standingKeyFor() };
    } catch {
      return {};
    }
  }
}

// ── module-scope helpers ──────────────────────────────────────────────────

/** A complete MCP registry entry with every field the readers expect. */
function mcpEntry(overrides) {
  const now = new Date().toISOString();
  return {
    id: overrides.name,
    kind: 'mcp',
    name: overrides.name,
    tier: overrides.tier ?? 'on-demand',
    transport: overrides.transport,
    command: overrides.command ?? null,
    args: overrides.args ?? [],
    env: overrides.env ?? {},
    cwd: overrides.cwd ?? null,
    url: overrides.url ?? null,
    headers: overrides.headers ?? {},
    toolCallTimeoutMs: overrides.toolCallTimeoutMs,
    notes: overrides.notes ?? '',
    systemEntryId: overrides.systemEntryId ?? `mcp-${overrides.name}`,
    managed: true,
    registeredAt: overrides.registeredAt ?? now,
    lastLoadAt: null,
    lastSyncAt: now,
    tools: overrides.tools ?? [],
    disabledTools: overrides.disabledTools ?? [],
    serverName: '',
    serverVersion: '',
    serverTitle: '',
    serverDescription: '',
    websiteUrl: '',
    instructions: '',
    capabilities: null,
    metaFetchedAt: null,
    ...(overrides.rawConfig !== undefined ? { rawConfig: overrides.rawConfig } : {}),
  };
}

function positiveInt(value, fallback) {
  return Number.isSafeInteger(value) && value >= 1 ? value : fallback;
}

function indexAfterLine(text, index) {
  const newline = text.indexOf('\n', index);
  return newline < 0 ? text.length : newline + 1;
}

/** A stable string digest; the cache key must not depend on JSON key order alone. */
function hash(text) {
  let h1 = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    h1 ^= text.charCodeAt(index);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return h1.toString(16);
}

export function assertServerName(value) {
  if (typeof value !== 'string' || !SERVER_NAME_PATTERN.test(value)) {
    throw new Error(`invalid MCP name "${value}" (must match [A-Za-z0-9_-]{1,32})`);
  }
}

/**
 * Classify a pending registration against the stored entry.
 *
 * A new stdio command, or a change to the program / args / env / cwd that will
 * actually be executed, is a local-command change. Tier, notes, a remote URL and
 * an unchanged resubmit are not.
 */
export function localExecutionChange(existing, args, transport) {
  if (transport !== 'stdio') return null;
  const next = {
    command: args.command !== undefined ? args.command : (existing?.command ?? null),
    args: args.args !== undefined ? args.args : (existing?.args ?? []),
    env: args.env !== undefined ? args.env : (existing?.env ?? {}),
    cwd: args.cwd !== undefined ? args.cwd : (existing?.cwd ?? null),
  };
  if (existing === undefined || existing.transport !== 'stdio') return { kind: 'add', ...next };
  const same =
    (existing.command ?? null) === next.command &&
    JSON.stringify(existing.args ?? []) === JSON.stringify(next.args) &&
    JSON.stringify(existing.env ?? {}) === JSON.stringify(next.env) &&
    (existing.cwd ?? null) === next.cwd;
  return same ? null : { kind: 'change', ...next };
}

/** The text shown in an approval prompt; names what will actually be executed. */
export function localExecutionReason(change) {
  const lines = [
    change.kind === 'add'
      ? 'A new local program will be registered. After saving, boot warm-up and every session may start it.'
      : 'An existing local program will be modified. After saving, boot warm-up and every session may start it.',
    `program: ${change.command}`,
    `args: ${JSON.stringify(change.args ?? [])}`,
  ];
  if (change.cwd) lines.push(`cwd: ${change.cwd}`);
  const envKeys = Object.keys(change.env ?? {});
  if (envKeys.length > 0) lines.push(`env keys: ${envKeys.join(', ')}`);
  return lines.join('\n');
}

export function buildEntry(args, existing, tools) {
  return mcpEntry({
    name: args.name,
    tier: args.tier ?? existing?.tier ?? 'on-demand',
    transport: args.transport ?? existing?.transport,
    command: args.command ?? existing?.command ?? null,
    args: args.args ?? existing?.args ?? [],
    env: args.env ?? existing?.env ?? {},
    cwd: args.cwd ?? existing?.cwd ?? null,
    url: args.url ?? existing?.url ?? null,
    headers: args.headers ?? existing?.headers ?? {},
    notes: args.notes ?? existing?.notes ?? '',
    systemEntryId: existing?.systemEntryId,
    registeredAt: existing?.registeredAt,
    tools: tools ?? existing?.tools ?? [],
    disabledTools: existing?.disabledTools ?? [],
    ...(existing?.serverName ? { serverName: existing.serverName } : {}),
    ...(existing?.serverVersion ? { serverVersion: existing.serverVersion } : {}),
    ...(existing?.serverTitle ? { serverTitle: existing.serverTitle } : {}),
    ...(existing?.serverDescription ? { serverDescription: existing.serverDescription } : {}),
    ...(existing?.websiteUrl ? { websiteUrl: existing.websiteUrl } : {}),
    ...(existing?.instructions ? { instructions: existing.instructions } : {}),
    ...(existing?.rawConfig !== undefined ? { rawConfig: existing.rawConfig } : {}),
  });
}

/**
 * Register the search tool under a free name.
 *
 * A duplicate name makes the host's registration throw, and registration happens
 * synchronously in `apply` — so one collision would stop the whole plugin from
 * loading. Renaming is strictly better than not loading, but it must be
 * announced: the catalog, the guard text and the UI all use the final name.
 *
 * A collision here is not a cosmetic detail: it means ANOTHER plugin also exposes
 * a deferred-tool search, so the model sees two tools claiming the same job with
 * different semantics. That is reported as a conflict the operator must resolve
 * (disable the other plugin's search, or accept the renamed entry) instead of
 * being papered over — the whole point of this package is that exactly one owner
 * decides tool visibility.
 */
export function chooseSearchToolName(ctx, preferred) {
  const candidates = [preferred, ...SEARCH_TOOL_CANDIDATES];
  let takenBy;
  try {
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || candidate === '') continue;
      if (ctx.tools.get(candidate) === undefined) {
        if (candidate !== preferred) {
          ctx.logger.warn(
            `toolsearch-manage: the search tool name "${preferred}" is already registered by another plugin${
              takenBy?.description ? ` ("${String(takenBy.description).slice(0, 80)}…")` : ''
            }; this plugin's own search tool registers as "${candidate}". Two deferred-tool searches are now visible to the model — disable one of them.`,
          );
        }
        return candidate;
      }
      takenBy = ctx.tools.get(candidate);
    }
  } catch {
    // No preflight available: keep the preferred name and let the host apply its
    // own rule. Inventing a different name would hide the entry the model knows.
    return preferred;
  }
  throw new Error(`toolsearch-manage: no free name for the search tool (tried ${candidates.join(', ')})`);
}

export function normalizeLanHostAllowlist(value) {
  if (!Array.isArray(value)) throw new Error('lanHostAllowlist must be an array of hostnames');
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('lanHostAllowlist entries must be hostnames');
    const host = item.trim().toLowerCase();
    if (host === '') continue;
    if (host.length > 253 || /[\s/\\:@]/.test(host) || host.includes('..')) throw new Error(`invalid LAN hostname "${item}"`);
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

/**
 * Skills living inside the DSH install or any package's `node_modules` are
 * shipped and read-only: the drawer may list and open them but never toggle or
 * delete them, which would corrupt the deployment or a third-party plugin.
 */
export function isReadonlySkillPath(path) {
  return /[\\/]app\.asar|[\\/]node_modules[\\/]/.test(String(path ?? ''));
}

const BUNDLE_SKILL_RE = /(^|[\\/])SKILL\.md$/i;

async function resolveSkillPath(skillsService, skillName, lookup) {
  const definition = await skillsService.get(skillName, lookup ?? {});
  if (definition === undefined || typeof definition.path !== 'string') return undefined;
  if (!BUNDLE_SKILL_RE.test(definition.path)) return undefined;
  return definition;
}

export { Config, apply, inject, name, PLUGIN_VERSION };
