// Ported from dsh-skill-mcp-manager (MIT). Modified for this plugin; see NOTICE.
// Persistent state: the capability registry and this plugin's own settings.
//
// registry.json is the authority for every capability entry the plugin owns:
//   { version: 2, entries: [{ kind: 'mcp' | 'builtin' | 'skill', ... }] }
//
// Version 1 (the previous plugin's format) held MCP servers only and had no
// `kind` field. The migration is deliberately one-way and total: every v1 entry
// becomes `kind: 'mcp'`, because "unknown kind" must never reach a code path
// that decides whether to spawn a subprocess. The version bump is the only
// format change, and `entryKind` treats a missing kind as `'mcp'` as well, so a
// half-written file still opens.
//
// `builtin` entries carry NO connection configuration. Their tool inventory is
// re-synchronized from `ctx.tools.schemas()` on every start; only the operator's
// decision (tier, per-tool disables) persists.

import { homedir } from 'node:os';
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

export const REGISTRY_VERSION = 2;

const KINDS = new Set(['mcp', 'builtin', 'skill']);

/** The kind of one entry; a v1 entry (no `kind`) is an MCP server. */
export function entryKind(entry) {
  const kind = entry?.kind;
  return typeof kind === 'string' && KINDS.has(kind) ? kind : 'mcp';
}

/** Only MCP entries own a connection. Every connection path must test this. */
export function isMcp(entry) {
  return entryKind(entry) === 'mcp';
}

export function resolveDataDir(config) {
  const raw = config.dataDir && config.dataDir.trim() !== '' ? config.dataDir : join(dshHome(), 'toolsearch-manage');
  return raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
}

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/**
 * The profile this process actually booted.
 *
 * This decides which `cordis.patch.yml` this plugin owns, and getting it wrong
 * is not a small bug: the plugin then rewrites ANOTHER profile's file, imports
 * nothing from its own, and leaves a managed block behind in a profile it does
 * not belong to. The previous implementation got exactly that wrong on this
 * machine, so detection is now layered and checked against the filesystem
 * instead of trusting one signal.
 *
 * Signals, strongest first:
 *
 *  1. `config.profile` — an explicit choice always wins.
 *  2. **A positional argument naming an existing profile directory.** The
 *     desktop host launches
 *     `… dsh-desktop-host/lib/index.js <install> <profileDir> …`, so the profile
 *     arrives as a positional path and `--profile` never appears. This is the
 *     case that broke: without it the fallback produced `web` on a desktop
 *     install.
 *  3. `DSH_PROFILE`.
 *  4. `--profile <name>` — the CLI form.
 *  5. `DSH_PROFILE_DIR`.
 *  6. **The only profile directory present**, when exactly one exists. A
 *     single-profile install has no ambiguity left to resolve.
 *  7. `web`, the historically assumed default.
 *
 * Candidates from 2–5 are accepted only when `<home>/profiles/<name>` exists, so
 * a stale environment variable cannot point the writer at a profile that is not
 * there. `verifyProfiles: false` skips that check; only the tests need it, since
 * they run against a throwaway home.
 *
 * @param {{profile?: string}} config
 * @param {{home?: string, verifyProfiles?: boolean, argv?: string[]}} [options]
 * @returns {string}
 */
export function resolveProfile(config, options = {}) {
  const explicit = typeof config?.profile === 'string' ? config.profile.trim() : '';
  if (explicit !== '') return explicit;

  const home = options.home ?? dshHome();
  const verify = options.verifyProfiles !== false;
  const argv = options.argv ?? process.argv;
  const profilesDir = join(home, 'profiles');
  const exists = (name) => {
    if (typeof name !== 'string' || name === '') return false;
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return false;
    if (!verify) return true;
    try {
      return statSync(join(profilesDir, name)).isDirectory();
    } catch {
      return false;
    }
  };

  // 2. Positional profile directory (`…/profiles/<name>`).
  const positional = argvProfileDir(profilesDir, argv);
  if (positional !== undefined && exists(positional)) return positional;

  // 3. DSH_PROFILE.
  const fromEnv = typeof process.env.DSH_PROFILE === 'string' ? process.env.DSH_PROFILE.trim() : '';
  if (fromEnv !== '' && exists(fromEnv)) return fromEnv;

  // 4. `--profile <name>`.
  const flag = argv.indexOf('--profile');
  if (flag !== -1 && flag + 1 < argv.length && !argv[flag + 1].startsWith('-')) {
    const fromFlag = argv[flag + 1];
    if (exists(fromFlag)) return fromFlag;
  }

  // 5. DSH_PROFILE_DIR.
  const fromDir = typeof process.env.DSH_PROFILE_DIR === 'string' ? process.env.DSH_PROFILE_DIR.trim() : '';
  if (fromDir !== '') {
    const name = basename(fromDir);
    if (exists(name)) return name;
  }

  // 6. The only profile directory present.
  if (verify) {
    try {
      const names = readdirSync(profilesDir).filter((name) => exists(name));
      if (names.length === 1) return names[0];
    } catch {
      /* no profiles directory: fall through to the historical default */
    }
  }

  return 'web';
}

/**
 * The `<name>` of any argv token shaped like `<…>/profiles/<name>`.
 *
 * Compares normalized path prefixes rather than running a regex over the raw
 * string, so an install path that itself contains `profiles`, or a mixed
 * separator, cannot yield a bogus name.
 */
export function argvProfileDir(profilesDir, argv = process.argv) {
  const wanted = normalizeForCompare(profilesDir).replace(/\/+$/, '');
  for (const token of argv) {
    if (typeof token !== 'string' || token === '' || token.startsWith('-')) continue;
    const candidate = normalizeForCompare(token).replace(/\/+$/, '');
    if (!candidate.startsWith(`${wanted}/`)) continue;
    const rest = candidate.slice(wanted.length + 1);
    // The token must name a directory directly under `profiles`, not a file
    // somewhere deeper in the tree.
    if (rest === '' || rest.includes('/')) continue;
    return rest;
  }
  return undefined;
}

function normalizeForCompare(value) {
  return String(value).replace(/\\/g, '/').toLowerCase();
}

/** Absolute path of the patch file this plugin is the single writer of. */
export function patchPathFor(config, options) {
  return join(dshHome(), 'profiles', resolveProfile(config, options), 'cordis.patch.yml');
}

export function emptyRegistry() {
  return { version: REGISTRY_VERSION, entries: [] };
}

function migrate(data) {
  if (data === null || typeof data !== 'object' || !Array.isArray(data.entries)) {
    throw new Error('registry.json has an invalid shape (expected { version, entries })');
  }
  const version = Number.isSafeInteger(data.version) ? data.version : 1;
  const entries = data.entries
    .filter((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({ ...entry, kind: entryKind(entry) }));
  return { version: REGISTRY_VERSION, entries, migratedFrom: version };
}

/**
 * Load the registry, migrating a v1 file in memory.
 *
 * @returns {{registry: {version: number, entries: object[]}, migrated: boolean}}
 */
export async function loadRegistry(dataDir) {
  let text;
  try {
    text = await readFile(join(dataDir, 'registry.json'), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { registry: emptyRegistry(), migrated: false };
    throw error;
  }
  const migrated = migrate(JSON.parse(text));
  return { registry: { version: migrated.version, entries: migrated.entries }, migrated: migrated.migratedFrom !== REGISTRY_VERSION };
}

export async function saveRegistry(dataDir, registry) {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, 'registry.json');
  const tmp = `${file}.tmp-${process.pid}`;
  const body = { version: REGISTRY_VERSION, entries: registry.entries };
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

export async function loadSettings(dataDir) {
  try {
    const text = await readFile(join(dataDir, 'settings.json'), 'utf8');
    const data = JSON.parse(text);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return {};
    return data;
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw error;
  }
}

export async function saveSettings(dataDir, settings) {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, 'settings.json');
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

// Keep the newest `keep` backups named `${prefix}<timestamp>`; unrelated files
// in the directory are left alone.
export async function pruneBackups(directory, prefix, keep = 5) {
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  const backups = names
    .filter((item) => item.startsWith(prefix))
    .map((item) => ({ item, stamp: Number(item.slice(prefix.length)) }))
    .filter((item) => Number.isFinite(item.stamp))
    .sort((a, b) => a.stamp - b.stamp);
  for (const item of backups.slice(0, Math.max(0, backups.length - keep))) {
    try {
      await unlink(join(directory, item.item));
    } catch {
      /* a backup that already disappeared is pruned */
    }
  }
}

/** Write a patch file with a timestamped backup, pruning to the newest five. */
export async function writePatch(patchPath, current, next) {
  if (next === current) return false;
  await writeFile(`${patchPath}.bak-${Date.now()}`, current, 'utf8');
  await writeFile(patchPath, next, 'utf8');
  await pruneBackups(dirname(patchPath), `${basename(patchPath)}.bak-`);
  return true;
}
