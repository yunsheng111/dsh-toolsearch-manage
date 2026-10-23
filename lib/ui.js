// Host-side UI bridge: the HTTP routes the browser settings page talks to, plus
// the `/skills` and `/mcp` human commands and the cross-platform file helpers.
//
// This module is pure in the same sense as the rest: it holds no MCP or skill
// state. The caller binds handler closures over its live registry, so the UI can
// only ever see and change what the plugin itself owns.
//
// Two contracts that are easy to get wrong and expensive to debug:
//   - `webServer` is provided lazily by the web-app bundle. A synchronous
//     `ctx.get('webServer')` returns undefined and no route registers at all —
//     the browser then gets the SPA fallback instead of JSON. The caller must
//     acquire it through `ctx.inject(['webServer'], …)`.
//   - `webServer.register` throws on a duplicate `(kind, path)` pair. A GET and a
//     POST for the same path must therefore be ONE registration that dispatches
//     on `request.method`.

import { spawn } from 'node:child_process';
import { hostname as machineHostname, homedir } from 'node:os';
import { isIP } from 'node:net';
import { join, basename, dirname } from 'node:path';
import { mkdir, rename, appendFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROUTE_PREFIX = '/toolsearch-manage';

// ── HTTP helpers ──────────────────────────────────────────────────────────

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

function sendHtml(response, html) {
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'text/html; charset=utf-8',
  });
  response.end(html);
}

function sendJavaScript(response, source) {
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'text/javascript; charset=utf-8',
  });
  response.end(source);
}

/**
 * Read one of the preview page's vendored scripts.
 *
 * The relative path is a COMPILE-TIME constant at each call site, and the join is
 * confined to this package's own `node_modules`; no request input reaches it, so
 * there is no traversal surface.
 *
 * @param {string} relative e.g. `react/umd/react.production.min.js`
 * @returns {string}
 */
function readVendorAsset(relative) {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, '..', 'node_modules', relative), 'utf8');
}

/**
 * The HTML shell for {@link mountUi}'s `/preview` route.
 *
 * Loads React from the Host's own module table shape (`require('react')` is what
 * the bundle expects) and mounts the plugin's real `apply()` against a one-slot
 * fake registry, so the component tree under test is exactly the shipped one.
 *
 * The bundle is fetched from the Host at `/plugins/??<id>/client.js`, which is
 * the same URL the real page uses — the point is to verify the served bytes, not
 * a copy on disk.
 */
function previewPage() {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>工具检索 · 设置页预览</title>
<style>
  :root {
    --dsw-alias-bg-base: #16181d; --dsw-alias-bg-raised: #1e2128; --dsw-alias-bg-overlay: #24282f;
    --dsw-alias-label-primary: #e6e8eb; --dsw-alias-label-secondary: #9aa0aa; --dsw-alias-label-tertiary: #6b7280;
    --dsw-alias-border: #2e333c; --dsw-alias-brand-primary: #4c8dff; --dsw-alias-brand-primary-hover: #6ba1ff;
    --dsw-alias-fill-hover: #262b33; --dsw-alias-danger: #f2555a; --dsw-alias-success: #3fb950;
  }
  body { margin:0; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary);
         font:14px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  #shell { max-width: 980px; margin: 0 auto; padding: 24px 20px 60px; }
  #boot { padding: 40px 0; color: var(--dsw-alias-label-secondary); }
  #err { white-space: pre-wrap; font-family: ui-monospace, Consolas, monospace; color: var(--dsw-alias-danger); font-size:12px; }
</style>
</head>
<body data-client-url="plugins/??dsh-toolsearch-manage/client.js">
<div id="shell">
  <h1 style="font-size:18px;margin:0 0 4px">工具检索 · 设置页预览</h1>
  <p style="margin:0 0 20px;color:var(--dsw-alias-label-secondary);font-size:12px">
    渲染宿主实际下发的 client bundle，调用真实的插件 HTTP 路由。这是预览外壳，不是真实设置页。
  </p>
  <div id="root"><div id="boot">正在加载 bundle…</div></div>
  <pre id="err"></pre>
</div>
<script src="/toolsearch-manage/preview/react.js"></script>
<script src="/toolsearch-manage/preview/react-dom.js"></script>
<script>
const err = document.getElementById('err');
function fail(where, e) { err.textContent = where + ': ' + (e && e.stack || e); }

const MODULE_URL = document.documentElement.dataset.clientUrl;
window.__ModuleLoader__ = {
  load({ id, factory }) {
    let mod;
    try {
      mod = factory((name) => {
        if (name === 'react') return window.React;
        throw new Error('unexpected require: ' + name);
      });
    } catch (e) { return fail('factory threw', e); }

    // A one-slot fake registry: enough to mount settings.section.
    const registrations = [];
    const ctx = {
      slots: {
        inject(_slot, run) { run(); },
        register(options, Component) { registrations.push({ options, Component }); return () => {}; },
      },
    };
    try { mod.apply(ctx); } catch (e) { return fail('apply threw', e); }

    const first = registrations[0];
    if (!first) {
      document.getElementById('root').innerHTML =
        '<p style="color:var(--dsw-alias-danger)">bundle 没有在 settings.section 上注册任何东西</p>';
      return;
    }
    const root = document.getElementById('root');
    root.innerHTML = '';
    try {
      window.ReactDOM.createRoot(root).render(window.React.createElement(first.Component, { close() {} }));
    } catch (e) { return fail('render threw', e); }
    document.title = first.options.label + ' · 预览';
  },
};

// Load the bundle from the URL the Host actually serves. The rev is appended by
// the Host; omitting it is still served.
const s = document.createElement('script');
s.src = MODULE_URL;
s.onerror = () => fail('bundle fetch failed', MODULE_URL);
document.head.appendChild(s);
</script>
</body>
</html>`;
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin === undefined || host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Host header without the port. Bracketed IPv6 (`[::1]:port`) keeps the address
 * inside the brackets; a bare hostname is returned as-is.
 */
export function requestHostname(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.trim() === '') return undefined;
  const host = hostHeader.trim();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end <= 1) return undefined;
    return host.slice(1, end);
  }
  const colon = host.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) return host.slice(0, colon);
  return host;
}

/**
 * Local names and literal IPs are allowed without being listed; a LAN hostname
 * must be on the allowlist. Comparison is case-insensitive.
 */
export function hostPermitted(hostHeader, allowlist) {
  const hostname = requestHostname(hostHeader);
  if (hostname === undefined) return false;
  const folded = hostname.toLowerCase();
  if (folded === 'localhost' || folded === machineHostname().toLowerCase()) return true;
  if (isIP(hostname) !== 0) return true;
  const allowed = new Set(
    (Array.isArray(allowlist) ? allowlist : [])
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item !== ''),
  );
  return allowed.has(folded);
}

/**
 * Browser-originated writes must come from a permitted host, and — when the
 * request carries an `Origin` — from the same origin.
 *
 * **A missing `Origin` is not a rejection.** It used to be, and that rejected the
 * real GUI: the desktop shell's own POSTs travel without `Origin`, so every
 * settings write failed with a message about a stale page while the page was
 * perfectly fresh. Observed in the wild as "还是有问题" after the previous fix.
 *
 * The reasoning that makes this safe:
 *  - The attack that `Origin` guards against is a *cross-site* write, and a
 *    cross-site `fetch`/form POST always carries `Origin` (the spec requires it
 *    for non-GET). So a request without `Origin` is not the CSRF case.
 *  - `Host` is the header a browser cannot forge for rebinding, and it is still
 *    checked on every request, with or without `Origin`.
 *  - This route set is not reachable cross-origin by anything else: the response
 *    to a cross-origin `fetch` would also have to pass CORS, which these routes
 *    never grant.
 *
 * The three rejections stay separate because each needs a different action:
 *  - `origin-mismatch`  → reload the page (its port is stale)
 *  - `host-not-allowed` → add the hostname to the LAN allowlist
 *  - `write-required`   → wrong HTTP method for a write-only route
 *
 * The response carries no server-side detail (no port, no configured allowlist):
 * a rejected caller is exactly the caller that should not learn which hostnames
 * would have been accepted.
 */
function browserGuard(request, response, allowlist) {
  if (!hostPermitted(request.headers.host, allowlist)) {
    sendRejection(response, {
      reason: 'host-not-allowed',
      error: '这个主机名不在局域网允许名单里。要从此地址访问，请在本页的「局域网主机允许名单」中加上它。',
    });
    return false;
  }
  if (request.headers.origin !== undefined && !sameOrigin(request)) {
    sendRejection(response, {
      reason: 'origin-mismatch',
      error: '页面与服务器不同源，写入被拒绝。最常见的原因是 DSH 重启后端口变了、而页面还是旧的——刷新页面即可。',
    });
    return false;
  }
  return true;
}

function sendRejection(response, { reason, error }) {
  sendJson(response, 403, { ok: false, reason, error });
}

async function readJsonBody(request, maxBytes = 4 << 20) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error('request body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// ── cross-platform file operations ────────────────────────────────────────

/**
 * Open a file with the OS default handler. Fire-and-forget: the launcher
 * detaches and is never awaited, so a hanging editor cannot stall the route.
 */
export function openWithSystemEditor(path) {
  let command;
  if (process.platform === 'win32') command = 'explorer.exe';
  else if (process.platform === 'darwin') command = 'open';
  else command = 'xdg-open';
  try {
    const child = spawn(command, [path], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function tryRecycleBinWindows(absPath) {
  return new Promise((resolve) => {
    const script = [
      'Add-Type -AssemblyName Microsoft.VisualBasic',
      `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(${psQuote(absPath)}, 'OnlyErrorDialogs', 'SendToRecycleBin')`,
    ].join('; ');
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function tryTrashMac(absPath) {
  try {
    await rename(absPath, join(homedir(), '.Trash', `${basename(absPath)}-${Date.now()}`));
    return true;
  } catch {
    return false;
  }
}

function tryGioTrash(absPath) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('gio', ['trash', absPath], { stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function logTrash(dataDir, absPath, method, dest) {
  try {
    await appendFile(join(dataDir, 'trash.log'), `${JSON.stringify({ ts: new Date().toISOString(), path: absPath, method, dest: dest ?? null })}\n`, 'utf8');
  } catch {
    /* the audit log is best-effort */
  }
  return { ok: true, method, dest: dest ?? null };
}

/**
 * Delete a whole SKILL directory.
 *
 * Tries the platform recycle bin first (Windows → Recycle Bin, macOS →
 * ~/.Trash, Linux → gio trash), then falls back to the plugin's own trash
 * directory so a delete is always recoverable and never silently drops data.
 */
export async function trashDirectory(absPath, dataDir) {
  if (process.platform === 'win32') {
    if (await tryRecycleBinWindows(absPath)) return logTrash(dataDir, absPath, 'recycle-bin');
  } else if (process.platform === 'darwin') {
    if (await tryTrashMac(absPath)) return logTrash(dataDir, absPath, 'trash');
  } else if (await tryGioTrash(absPath)) {
    return logTrash(dataDir, absPath, 'recycle-bin');
  }
  const trashDir = join(dataDir, 'trash');
  await mkdir(trashDir, { recursive: true });
  const dest = join(trashDir, `${basename(absPath)}-${Date.now()}`);
  await rename(absPath, dest);
  return logTrash(dataDir, absPath, 'plugin-trash', dest);
}

// ── secret masking ────────────────────────────────────────────────────────

function isSensitiveKey(key) {
  return /(token|secret|password|passwd|auth|credential|api[_-]?key|access[_-]?key|private[_-]?key)/i.test(key);
}

function maskSecretValue(value) {
  const text = String(value ?? '');
  if (text.length === 0) return '';
  // A `$VAR` reference is an indirection, not a secret — show it verbatim.
  if (text.startsWith('$')) return text;
  return '••••••';
}

function maskEnv(env, reveal) {
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) out[key] = reveal || !isSensitiveKey(key) ? String(value) : maskSecretValue(value);
  return out;
}

function maskHeaders(headers, reveal) {
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) out[key] = reveal ? String(value) : maskSecretValue(value);
  return out;
}

function maskUrl(url, reveal) {
  if (url === undefined || url === null || url === '') return url;
  if (reveal) return url;
  try {
    const parsed = new URL(url);
    if (parsed.search) parsed.search = '?<redacted>';
    return parsed.toString();
  } catch {
    return '<redacted>';
  }
}

/**
 * One registry entry as the browser may see it.
 *
 * Secrets are masked unless `reveal` is true, and a `$VAR` reference is never
 * masked at all: it is an indirection, so showing it leaks nothing while hiding
 * it would make the value look empty.
 */
export function entryView(entry, reveal, state = {}) {
  const disabledTools = new Set(Array.isArray(entry.disabledTools) ? entry.disabledTools : []);
  const tools = Array.isArray(entry.tools) ? entry.tools : [];
  return {
    id: entry.id,
    kind: entry.kind ?? 'mcp',
    name: entry.name,
    tier: entry.tier,
    transport: entry.transport,
    command: entry.command ?? null,
    args: entry.args ?? [],
    env: maskEnv(entry.env, reveal),
    cwd: entry.cwd ?? null,
    url: maskUrl(entry.url, reveal),
    headers: maskHeaders(entry.headers, reveal),
    notes: entry.notes ?? '',
    managed: entry.managed ?? false,
    registeredAt: entry.registeredAt ?? null,
    lastLoadAt: entry.lastLoadAt ?? null,
    toolCount: tools.length,
    disabledToolCount: tools.filter((tool) => disabledTools.has(tool.name)).length,
    serverName: entry.serverName ?? '',
    serverVersion: entry.serverVersion ?? '',
    serverTitle: entry.serverTitle ?? '',
    serverDescription: entry.serverDescription ?? '',
    websiteUrl: entry.websiteUrl ?? '',
    instructions: entry.instructions ?? '',
    connectFailed: state.connectFailed === true,
  };
}

// ── route + command mounting ──────────────────────────────────────────────

/**
 * Mount the routes and the two human commands.
 *
 * @param {object} ctx the context that owns the registrations
 * @param {object} handlers handler closures bound to the live plugin state
 * @param {{dataDir: string, webServer?: object}} options
 */
export function mountUi(ctx, handlers, { dataDir, webServer }) {
  const disposers = [];
  const server = webServer ?? ctx.get('webServer');
  if (server !== undefined) {
    const allowlist = () => handlers.lanHostAllowlist?.() ?? [];

    /** Register one path, dispatching GET and POST through a single handler. */
    const route = (path, handle) => {
      disposers.push(
        server.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}${path}`,
          handler: async (request, response) => {
            try {
              if (!browserGuard(request, response, allowlist())) return;
              const body = request.method === 'POST' ? await readJsonBody(request) : {};
              const result = await handle({ method: request.method, body, request }, response);
              // A handler that wrote the response itself (HTML routes) returns
              // undefined; anything else is serialized as JSON.
              if (result !== undefined) sendJson(response, 200, result);
            } catch (error) {
              sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
            }
          },
        }),
      );
    };

    route('/capabilities', async ({ method, request }) => {
      if (method !== 'GET') return { ok: false, error: 'GET only' };
      return handlers.listCapabilities(String(request.url ?? '').includes('reveal=1'));
    });
    route('/tier', async ({ method, body }) => {
      if (method !== 'POST') return { ok: false, error: 'POST only' };
      return { ok: true, entry: await handlers.setTier(body.name, body.tier) };
    });
    route('/builtin-tier', async ({ method, body }) => {
      if (method !== 'POST') return { ok: false, error: 'POST only' };
      return { ok: true, builtin: await handlers.setBuiltinTier(body.name, body.tier) };
    });
    route('/tool-enabled', async ({ method, body }) => {
      if (method !== 'POST') return { ok: false, error: 'POST only' };
      return { ok: true, entry: await handlers.setToolEnabled(body.name, body.tool, body.enabled) };
    });
    route('/delete', async ({ method, body }) => {
      if (method !== 'POST') return { ok: false, error: 'POST only' };
      return handlers.deleteMcp(body.name);
    });
    route('/peek', async ({ method, body }) => {
      if (method !== 'POST') return { ok: false, error: 'POST only' };
      return body.peek === true ? handlers.peekMcp(body.name) : handlers.refreshSnapshot(body.name);
    });
    route('/register', async ({ method, body }) => {
      if (method !== 'POST') return { ok: false, error: 'POST only' };
      return handlers.registerServer(body);
    });
    route('/skills', async ({ method }) => {
      if (method !== 'GET') return { ok: false, error: 'GET only' };
      return { skills: await handlers.listSkills() };
    });
    route('/skills/toggle', async ({ method, body }) => {
      if (method !== 'POST') return { ok: false, error: 'POST only' };
      return { ok: true, skill: await handlers.toggleSkill(body.name, body.enabled === true) };
    });
    route('/skills/open', async ({ method, body }) => {
      if (method !== 'POST') return { ok: false, error: 'POST only' };
      return handlers.openSkill(body.name);
    });
    route('/skills/delete', async ({ method, body }) => {
      if (method !== 'POST') return { ok: false, error: 'POST only' };
      return handlers.deleteSkill(body.name);
    });
    route('/market', async ({ method }) => {
      if (method !== 'GET') return { ok: false, error: 'GET only' };
      return handlers.listMarket();
    });
    route('/market/install', async ({ method, body }) => {
      if (method !== 'POST') return { ok: false, error: 'POST only' };
      return handlers.installMarket(body.ids);
    });
    route('/import/sources', async ({ method }) => {
      if (method !== 'GET') return { ok: false, error: 'GET only' };
      return handlers.listImportSources();
    });
    route('/import/preview', async ({ method, body }) => {
      if (method !== 'POST') return { ok: false, error: 'POST only' };
      return handlers.previewImport(body.sourceId);
    });
    route('/import/apply', async ({ method, body }) => {
      if (method !== 'POST') return { ok: false, error: 'POST only' };
      return handlers.applyImport(body.sourceId, body.names);
    });
    route('/import/json', async ({ method, body }) => {
      if (method !== 'POST') return { ok: false, error: 'POST only' };
      return handlers.importJson(body.text);
    });
    route('/settings', async ({ method, body }) => {
      if (method === 'GET') return handlers.getSettings();
      if (method === 'POST') return handlers.setSettings(body);
      return { ok: false, error: 'GET or POST' };
    });
    route('/session-audit', async ({ method }) => {
      if (method !== 'GET') return { ok: false, error: 'GET only' };
      return handlers.getSessionAudit();
    });
    route('/login-url', async ({ method }) => {
      if (method !== 'GET') return { ok: false, error: 'GET only' };
      return handlers.loginUrl();
    });
    // A standalone preview of the settings page, served OUTSIDE the Host's index
    // auth fence (only `/` is fenced; plugin routes are not).
    //
    // It exists because the real Harness UI cannot be automated: its session
    // cookie is `HttpOnly; SameSite=Strict`, so a headless browser that has the
    // launch token still ends up at 401 after the 303, and JavaScript cannot
    // write that cookie. Without this page the only way to see whether the
    // settings section renders is to ask a human to look, which is how a broken
    // component ships.
    //
    // It renders the SAME bundle the Host serves (fetched from the Host, not a
    // second copy), against the same HTTP routes the real page uses, so what it
    // shows is what the real page shows. It is a development aid: it adds no
    // capability — every route it calls is already reachable without the fence.
    route('/preview', async ({ method }, response) => {
      if (method !== 'GET') return { ok: false, error: 'GET only' };
      sendHtml(response, previewPage());
      return undefined;
    });
    // The React the preview page needs. The Host injects React into its own main
    // bundle instead of exposing a module URL, so a standalone page must bring
    // its own copy; these are this plugin's devDependencies, served read-only.
    // Resolved from the plugin's own node_modules, never from a caller-supplied
    // path, so this cannot be walked into arbitrary files.
    route('/preview/react.js', async ({ method }, response) => {
      if (method !== 'GET') return { ok: false, error: 'GET only' };
      sendJavaScript(response, readVendorAsset('react/umd/react.production.min.js'));
      return undefined;
    });
    route('/preview/react-dom.js', async ({ method }, response) => {
      if (method !== 'GET') return { ok: false, error: 'GET only' };
      sendJavaScript(response, readVendorAsset('react-dom/umd/react-dom.production.min.js'));
      return undefined;
    });
  }

  const commands = ctx.get('commands');
  if (commands !== undefined) {
    disposers.push(
      commands.register({
        name: 'skills',
        description: 'List every managed skill (bundle SKILL.md) with its path and model-invocation state',
        handler: async () => {
          const skills = await handlers.listSkills();
          const text =
            skills.length === 0
              ? 'No managed skills found.'
              : `Managed skills (${skills.length}):\n${skills.map((skill) => `- ${skill.name} [${skill.modelInvocable ? 'on' : 'off'}] ${skill.path}`).join('\n')}`;
          return { kind: 'success', text };
        },
      }),
    );
    disposers.push(
      commands.register({
        name: 'mcp',
        description: 'List every registered MCP server with tier and tool count. `/mcp prepare-uninstall` hands them back to the native client.',
        handler: async (invocation) => {
          const raw = String(invocation?.rawInput ?? '').trim();
          if (raw === 'prepare-uninstall') {
            if (typeof handlers.prepareUninstall !== 'function') return { kind: 'error', text: 'prepare-uninstall is not available' };
            return handlers.prepareUninstall();
          }
          if (raw !== '') return { kind: 'error', text: 'usage: /mcp lists servers; /mcp prepare-uninstall hands managed entries back to the native client.' };
          const snapshot = await handlers.listCapabilities(false);
          const list = snapshot.entries ?? [];
          const builtins = snapshot.builtins ?? [];
          const lines = [`MCP servers (${list.length}):`, ...list.map((entry) => `- ${entry.name} [${entry.tier}] — ${entry.toolCount} tool(s)`)];
          const nonEager = builtins.filter((tool) => tool.tier !== 'eager');
          if (nonEager.length > 0) {
            lines.push('', `Built-in tools not eager (${nonEager.length}):`, ...nonEager.map((tool) => `- ${tool.name} [${tool.tier}]`));
          }
          return { kind: 'success', text: lines.join('\n') };
        },
      }),
    );
  }

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
  });

  return disposers;
}
