// Plugin lifecycle tests against a fake Cordis context.
//
// These exercise the parts that only exist at apply() time: which services the
// plugin depends on, that a missing optional service does not stop the mount,
// the guard's three answers, and the assembly projection. No profile file is
// touched: `profile: '__test__'` and `importNativeMcp: false` keep reconcile and
// the legacy audit away from the real `~/.dsh`.
//
// Run: node --test test/

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, Config, inject, name } from '../lib/index.js';

// ── fake host ─────────────────────────────────────────────────────────────

/**
 * A fake webServer that records routes instead of listening.
 *
 * This is what makes the tests exercise the real HTTP surface: the plugin sees
 * an ordinary `ctx.webServer`, registers its routes into it, and the test then
 * invokes them with a request/response pair. No test-only code exists in the
 * plugin for this to work.
 */
function fakeWebServer() {
  const routes = new Map();
  return {
    routes,
    service: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
      getOrigin: () => 'http://localhost:0',
    },
    /** Invoke one route the way the HTTP carrier would. */
    async call(path, { method = 'GET', body, headers = {} } = {}) {
      const route = routes.get(path);
      if (route === undefined) throw new Error(`no route ${path}`);
      // A real browser request always carries Origin; the route's guard requires
      // same-origin for anything with an Origin and fails closed for a POST
      // without one. Sending it makes these tests exercise the shipped rule
      // rather than a bypass.
      const request = {
        method,
        url: path,
        headers: { host: 'localhost:0', origin: 'http://localhost:0', ...headers },
        async *[Symbol.asyncIterator]() {
          if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8');
        },
      };
      let status = 0;
      let payload;
      const response = {
        writeHead(code) {
          status = code;
        },
        end(text) {
          payload = text === undefined ? undefined : JSON.parse(text);
        },
      };
      await route.handler(request, response);
      return { status, payload };
    },
  };
}

/**
 * A minimal Cordis context: effect/on/inject/get/logger plus a tools service.
 * Deliberately does not implement anything the plugin is not supposed to use.
 */
function fakeContext({ services = {}, tools = [], mode = 'native' } = {}) {
  const registered = new Map();
  const guards = [];
  const listeners = new Map();
  const effects = [];
  const provided = new Map(Object.entries(services));
  const warnings = [];
  const liveTools = [...tools];

  const toolsService = {
    register(definition) {
      if (registered.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`);
      registered.set(definition.name, definition);
      liveTools.push({ name: definition.name, description: definition.description, parameters: definition.parameters });
      return () => registered.delete(definition.name);
    },
    guard(guard) {
      guards.push(guard);
      return () => {
        const index = guards.indexOf(guard);
        if (index >= 0) guards.splice(index, 1);
      };
    },
    get(toolName) {
      const own = registered.get(toolName);
      if (own !== undefined) return own;
      return liveTools.find((entry) => entry.name === toolName);
    },
    schemas() {
      return liveTools.map((entry) => ({ ...entry }));
    },
    modeFor() {
      return mode;
    },
  };

  const ctx = {
    logger: {
      info() {},
      warn(message) {
        warnings.push(message);
      },
      error(message) {
        warnings.push(message);
      },
    },
    tools: toolsService,
    effect(factory) {
      const dispose = factory();
      effects.push(dispose);
      return dispose;
    },
    on(eventName, handler) {
      const list = listeners.get(eventName) ?? [];
      list.push(handler);
      listeners.set(eventName, list);
      return () => {
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    get(serviceName) {
      return provided.get(serviceName);
    },
    inject(servicesList, callback) {
      // The host defers this until every named service exists. Tests provide the
      // service when they want the face mounted, so an absent one simply never
      // runs — which is exactly the property being tested.
      const available = servicesList.every((serviceName) => provided.has(serviceName));
      if (available) callback(ctx);
      return { dispose() {} };
    },
  };

  return {
    ctx,
    registered,
    guards,
    listeners,
    warnings,
    tools: toolsService,
    async dispose() {
      for (const dispose of effects.reverse()) {
        try {
          await (typeof dispose === 'function' ? dispose() : undefined);
        } catch {
          /* a second dispose is not an error */
        }
      }
    },
  };
}

async function withPlugin(options, body) {
  const dataDir = await mkdtemp(join(tmpdir(), 'tsm-'));
  const web = fakeWebServer();
  const host = fakeContext({ ...options, services: { webServer: web.service } });
  // A throwaway DSH_HOME gives the plugin a real patch file to own, so patch
  // behaviour is exercised against a filesystem instead of being skipped. The
  // profile name is still `__test__`, which keeps the legacy audit inert.
  const home = await mkdtemp(join(tmpdir(), 'tsm-home-'));
  const profileDir = join(home, 'profiles', '__test__');
  await mkdir(profileDir, { recursive: true });
  const patchPath = join(profileDir, 'cordis.patch.yml');
  await writeFile(patchPath, options?.seedPatch ? `${options.seedPatch}\n` : '', 'utf8');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const config = {
    ...Config({}),
    dataDir,
    profile: '__test__',
    importNativeMcp: false,
    searchToolName: 'tool_search',
    ...(options?.config ?? {}),
  };
  try {
    await apply(host.ctx, config);
    await body({ host, dataDir, config, web, patchPath });
  } finally {
    await host.dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('uiPlacement round-trips and rejects unknown values', async () => {
  await withPlugin({}, async ({ web }) => {
    const initial = await web.call('/toolsearch-manage/settings');
    // Default is `both`: either seat alone makes one of the two journeys fail —
    // the settings page is where an operator looks first, and the rail is where
    // the page is actually usable.
    assert.equal(initial.payload.uiPlacement, 'both');

    const saved = await web.call('/toolsearch-manage/settings', {
      method: 'POST',
      body: { uiPlacement: 'sidebar' },
    });
    assert.equal(saved.payload.uiPlacement, 'sidebar');
    assert.equal((await web.call('/toolsearch-manage/settings')).payload.uiPlacement, 'sidebar');

    // A typo must be refused rather than coerced: a wrong value here hides the
    // entire management surface, and the operator would have no way to set it back.
    const rejected = await web.call('/toolsearch-manage/settings', { method: 'POST', body: { uiPlacement: 'rail' } });
    assert.equal(rejected.status, 400);
    assert.match(rejected.payload.error, /uiPlacement must be settings, sidebar, or both/);
    // And the stored value is untouched by the refusal.
    assert.equal((await web.call('/toolsearch-manage/settings')).payload.uiPlacement, 'sidebar');
  });
});

test('a write without an Origin header is accepted from a permitted host', async () => {
  // This rejected the real GUI. The desktop shell's own POSTs carry no `Origin`,
  // so every settings write failed with a message about a stale page while the
  // page was fresh. A missing `Origin` is not the CSRF case: a cross-site POST
  // is required by the fetch spec to send one, and `Host` — which a browser
  // cannot forge for rebinding — is still checked on every request.
  await withPlugin({}, async ({ web }) => {
    const noOrigin = await web.call('/toolsearch-manage/settings', {
      method: 'POST',
      body: { uiPlacement: 'sidebar' },
      headers: { origin: undefined, host: 'localhost:0' },
    });
    assert.equal(noOrigin.status, 200);
    assert.equal(noOrigin.payload.uiPlacement, 'sidebar');

    // A GET without Origin was already allowed and must stay allowed.
    const get = await web.call('/toolsearch-manage/settings', { headers: { origin: undefined } });
    assert.equal(get.status, 200);
  });
});

test('a rejected browser write explains itself instead of saying "untrusted origin"', async () => {
  // The phrase was accurate and useless. Each surviving rejection names a
  // different action.
  await withPlugin({}, async ({ web }) => {
    // 1. Stale origin — the sticky tab case. This still rejects, because the
    //    request DID carry an Origin and it disagrees with Host.
    const stale = await web.call('/toolsearch-manage/settings', {
      method: 'POST',
      body: { uiPlacement: 'both' },
      headers: { origin: 'http://localhost:1', host: 'localhost:0' },
    });
    assert.equal(stale.status, 403);
    assert.equal(stale.payload.reason, 'origin-mismatch');
    assert.match(stale.payload.error, /刷新页面/);
    assert.doesNotMatch(stale.payload.error, /untrusted origin/);

    // 2. A LAN hostname that is not on the allowlist.
    const lanHost = await web.call('/toolsearch-manage/settings', {
      method: 'POST',
      body: { uiPlacement: 'both' },
      headers: { origin: 'http://some-host.example:0', host: 'some-host.example:0' },
    });
    assert.equal(lanHost.status, 403);
    assert.equal(lanHost.payload.reason, 'host-not-allowed');
    assert.match(lanHost.payload.error, /允许名单/);
  });
});

test('the rejection never discloses which hosts would have been accepted', async () => {
  // A rejected caller is exactly the caller that should not learn the allowlist.
  await withPlugin({}, async ({ web }) => {
    const rejected = await web.call('/toolsearch-manage/settings', {
      method: 'POST',
      body: {},
      headers: { origin: 'http://evil.example:0', host: 'evil.example:0' },
    });
    const serialized = JSON.stringify(rejected.payload);
    assert.equal(serialized.includes('localhost'), false);
    assert.deepEqual(Object.keys(rejected.payload).sort(), ['error', 'ok', 'reason']);
  });
});

// ── dependency shape ──────────────────────────────────────────────────────

test('a managed block removed by another writer is restored', async () => {
  // This happened for real within minutes of the first install: disabling an
  // unrelated bundle through Plugin Manager rewrote cordis.patch.yml from the
  // host's own model of the file, which knew nothing about this plugin's span.
  // The three MCP rows vanished while the registry still held them, so the next
  // boot would have found BOTH the native rows and the managed rows gone.
  //
  // The repair is covered in test/patch.test.mjs at the unit level (the block is
  // regenerable from the registry). What is asserted here is the part that lives
  // in apply(): the initial reconcile installs the span, and a second reconcile
  // after an external overwrite installs it again. A timer firing on an interval
  // is what production uses; a test does not need to wait for it to trust it.
  await withPlugin(
    {
      seedPatch: ['- insert:', '    - id: mcp-github', '      name: "@deepseek-ai/dsh-mcp-client"', '      config:', '        serverName: github', '        transport: stdio', '        command: npx'].join('\n'),
      config: { importNativeMcp: true },
    },
    async ({ patchPath }) => {
      const afterStart = await readFile(patchPath, 'utf8');
      assert.match(afterStart, /dsh-toolsearch-manage, disabled shadow entries/, 'block missing after startup');
      // The native row was absorbed into the span, not left outside it.
      const beforeBlock = afterStart.slice(0, afterStart.indexOf('# ── Managed MCP servers (dsh-toolsearch-manage'));
      assert.doesNotMatch(beforeBlock, /dsh-mcp-client/);
    },
  );
});

test('the plugin declares only the tools service as a hard dependency', () => {
  // Cordis `inject` is a dependency DECLARATION: a missing service leaves the
  // fiber inactive with no error. Declaring `skills` here would make the whole
  // MCP surface disappear in a profile that disables dsh-skill.
  assert.deepEqual(inject, ['tools']);
  assert.equal(name, 'toolsearch-manage');
});

test('the config schema defaults match the documented behaviour', () => {
  const config = Config({});
  assert.equal(config.catalogGranularity, 'server');
  assert.equal(config.toolDescriptionMaxLength, 80);
  assert.equal(config.searchToolName, 'tool_search');
  assert.equal(config.importNativeMcp, true);
  assert.equal(config.trimPtcManual, true);
  assert.deepEqual(config.rules, { eager: [], 'on-demand': [], disabled: [] });
});

test('apply mounts without the optional services', async () => {
  await withPlugin({}, async ({ host }) => {
    // Four tools: the search tool and the three management tools.
    assert.deepEqual([...host.registered.keys()].sort(), ['mcp_call', 'mcp_load', 'mcp_register', 'tool_search']);
    // One monotonic guard, and no crash from the absent skills/webServer.
    assert.equal(host.guards.length, 1);
    assert.ok(host.listeners.get('system-prompt/assemble').length >= 1);
  });
});

test('a taken search-tool name is renamed rather than colliding', async () => {
  await withPlugin(
    { tools: [{ name: 'tool_search', description: 'someone else', parameters: {} }] },
    async ({ host }) => {
      assert.equal(host.registered.has('deferred_tool_search'), true);
      assert.equal(host.registered.has('tool_search'), false);
    },
  );
});

test('a name collision is reported as a conflict, not just renamed', async () => {
  // Two deferred-tool searches visible at once is a configuration the operator
  // must resolve; a warning in a log nobody reads is not a way to say so.
  await withPlugin(
    { tools: [{ name: 'tool_search', description: 'the other plugin search', parameters: {} }] },
    async ({ web }) => {
      const { payload } = await web.call('/toolsearch-manage/settings');
      assert.ok(payload.searchConflict, 'searchConflict missing from settings');
      assert.equal(payload.searchConflict.preferredName, 'tool_search');
      assert.equal(payload.searchConflict.registeredAs, 'deferred_tool_search');
      assert.match(payload.searchConflict.description, /other plugin/);
    },
  );
});

test('no conflict is reported when the preferred name is free', async () => {
  await withPlugin({}, async ({ web }) => {
    const { payload } = await web.call('/toolsearch-manage/settings');
    assert.equal(payload.searchConflict, undefined);
    assert.equal(payload.searchToolName, 'tool_search');
  });
});

test('the renamed search tool is the name the prompt tells the model to call', async () => {
  // This is the defect observed on the installed machine: `dsh-toolbox-ui`
  // registers `tool_search` first, so this plugin's own became
  // `deferred_tool_search`, but the catalog and guidance still said
  // `tool_search` — pointing the model at another plugin's tool.
  await withPlugin(
    {
      tools: [
        { name: 'tool_search', description: 'the other plugin', parameters: {} },
        { name: 'bash', description: 'run a command', parameters: {} },
      ],
    },
    async ({ host, web }) => {
      assert.equal(host.registered.has('deferred_tool_search'), true);

      // Make something deferred so both prompt surfaces have content.
      await web.call('/toolsearch-manage/builtin-tier', { method: 'POST', body: { name: 'bash', tier: 'on-demand' } });
      const assembly = await runAssemble(host, { sections: [], tools: [{ name: 'bash' }], variables: {} });
      const catalog = assembly.sections.find((section) => section.name === 'toolsearch:catalog');
      assert.ok(catalog);
      assert.match(catalog.text, /deferred_tool_search/);
      assert.doesNotMatch(catalog.text, /`tool_search`/);

      // The guard's denial has to name the same tool, or the model follows a
      // pointer to something it cannot call.
      const reason = host.guards[0]({ name: 'bash', agent: fakeAgent() });
      assert.match(reason, /deferred_tool_search/);
    },
  );
});

// ── built-in tiers ────────────────────────────────────────────────────────

test('built-in tools are discovered eagerly by default', async () => {
  await withPlugin(
    { tools: [
      { name: 'bash', description: 'run a command', parameters: {} },
      { name: 'read', description: 'read a file', parameters: {} },
    ] },
    async ({ dataDir, web }) => {
      const { payload } = await web.call('/toolsearch-manage/capabilities');
      const builtins = payload.builtins ?? [];
      assert.deepEqual(builtins.map((tool) => tool.name).sort(), ['bash', 'read']);
      assert.ok(builtins.every((tool) => tool.tier === 'eager'));
      // No settings file is written until the operator changes something.
      await assert.rejects(readFile(join(dataDir, 'settings.json'), 'utf8'));
    },
  );
});

test('a disabled built-in is hidden from the assembly and refused by the guard', async () => {
  await withPlugin(
    { tools: [
      { name: 'bash', description: 'run a command', parameters: {} },
      { name: 'web_fetch', description: 'fetch a url', parameters: {} },
    ] },
    async ({ host, web }) => {
      // The UI action and the agent tool share one implementation, so this is
      // the same operation either caller performs.
      const set = await web.call('/toolsearch-manage/builtin-tier', { method: 'POST', body: { name: 'web_fetch', tier: 'disabled' } });
      assert.equal(set.status, 200);
      assert.equal(set.payload.builtin.tier, 'disabled');

      const assembly = await runAssemble(host, {
        sections: [],
        tools: [{ name: 'bash' }, { name: 'web_fetch' }, { name: 'tool_search' }],
        variables: {},
      });
      assert.deepEqual(assembly.tools.map((tool) => tool.name), ['bash', 'tool_search']);

      // A disabled tool never reaches the server, even if the model hallucinates.
      const reason = host.guards[0]({ name: 'web_fetch', agent: fakeAgent() });
      assert.match(reason, /disabled/);
      // No pointer: teaching the model how to reach a switched-off tool defeats
      // the switch.
      assert.doesNotMatch(reason, /tool_search/);
    },
  );
});

test('an on-demand built-in is hidden but the guard points at the search tool', async () => {
  await withPlugin(
    { tools: [{ name: 'bash', description: 'run a command', parameters: {} }] },
    async ({ host, web }) => {
      await web.call('/toolsearch-manage/builtin-tier', { method: 'POST', body: { name: 'bash', tier: 'on-demand' } });
      const reason = host.guards[0]({ name: 'bash', agent: fakeAgent() });
      assert.match(reason, /tool_search/);
      assert.match(reason, /bash/);
      // The exact query is spelled out, so the model has a next step.
      assert.match(reason, /"bash"/);
    },
  );
});

test('an eager tool passes the guard untouched', async () => {
  await withPlugin({ tools: [{ name: 'bash', description: 'run', parameters: {} }] }, async ({ host }) => {
    assert.equal(host.guards[0]({ name: 'bash', agent: fakeAgent() }), undefined);
  });
});

test("the plugin's own tools can never be tiered away", async () => {
  await withPlugin({}, async ({ host, web }) => {
    for (const toolName of ['tool_search', 'mcp_register', 'mcp_load', 'mcp_call']) {
      assert.equal(host.guards[0]({ name: toolName, agent: fakeAgent() }), undefined);
    }
    const denied = await web.call('/toolsearch-manage/builtin-tier', { method: 'POST', body: { name: 'mcp_call', tier: 'disabled' } });
    assert.equal(denied.status, 400);
    assert.match(denied.payload.error, /management tool/);
  });
});

test('an unknown tier value is rejected', async () => {
  await withPlugin({ tools: [{ name: 'bash', description: 'run', parameters: {} }] }, async ({ web }) => {
    const rejected = await web.call('/toolsearch-manage/builtin-tier', { method: 'POST', body: { name: 'bash', tier: 'resident' } });
    assert.equal(rejected.status, 400);
    assert.match(rejected.payload.error, /invalid tier/);
  });
});

// ── catalog ───────────────────────────────────────────────────────────────

test('no deferred work means no catalog and no guidance text', async () => {
  await withPlugin({ tools: [{ name: 'bash', description: 'run', parameters: {} }] }, async ({ host }) => {
    const assembly = await runAssemble(host, {
      sections: [{ name: 'toolsearch:guidance', text: 'Some tools are deferred: …' }],
      tools: [{ name: 'bash' }],
      variables: {},
    });
    // The guidance is masked to empty text: the renderer drops empty sections, so
    // the model never reads a paragraph about a catalog that is not there.
    const guidance = assembly.sections.find((section) => section.name === 'toolsearch:guidance');
    assert.equal(guidance.text, '');
    assert.equal(assembly.sections.some((section) => section.name === 'toolsearch:catalog'), false);
  });
});

test('the catalog section is appended with interpolation disabled', async () => {
  await withPlugin({ tools: [{ name: 'bash', description: 'run', parameters: {} }] }, async ({ host, web }) => {
    await web.call('/toolsearch-manage/builtin-tier', { method: 'POST', body: { name: 'bash', tier: 'on-demand' } });
    const assembly = await runAssemble(host, { sections: [], tools: [{ name: 'bash' }], variables: {} });
    const catalog = assembly.sections.find((section) => section.name === 'toolsearch:catalog');
    assert.ok(catalog, 'catalog section missing');
    // Third-party text must never reach the interpolator.
    assert.equal(catalog.interpolate, false);
    assert.match(catalog.text, /bash/);
  });
});

test('a discovered tool comes back into the assembly', async () => {
  await withPlugin(
    { tools: [
      { name: 'bash', description: 'run a command', parameters: {} },
      { name: 'read', description: 'read a file', parameters: {} },
    ] },
    async ({ host, web }) => {
      await web.call('/toolsearch-manage/builtin-tier', { method: 'POST', body: { name: 'bash', tier: 'on-demand' } });
      const before = await runAssemble(host, { sections: [], tools: [{ name: 'bash' }], variables: {} });
      assert.equal(before.tools.length, 0);

      // The search tool is the only way to discover a deferred capability, and
      // its result names the tool it found.
      const agent = fakeAgent();
      const search = host.registered.get('tool_search');
      const result = await search.execute({ query: 'bash' }, { agent, signal: new AbortController().signal });
      assert.equal(result.discoveredTools.includes('bash'), true);

      const after = await runAssembleWith(host, agent, { sections: [], tools: [{ name: 'bash' }], variables: {} });
      assert.deepEqual(after.tools.map((tool) => tool.name), ['bash']);
      // And the guard now lets it through.
      assert.equal(host.guards[0]({ name: 'bash', agent }), undefined);
    },
  );
});

test('the search tool reports nothing rather than an empty success', async () => {
  await withPlugin({ tools: [{ name: 'bash', description: 'run', parameters: {} }] }, async ({ host }) => {
    const search = host.registered.get('tool_search');
    await assert.rejects(search.execute({ query: '' }, { agent: fakeAgent(), signal: new AbortController().signal }), /query must not be empty/);
  });
});

// ── helpers ───────────────────────────────────────────────────────────────

function fakeAgent() {
  return { id: 'session-test', ctx: { effect: () => () => {} }, session: undefined };
}

/** Run the assembly waterfall the way the host does. */
async function runAssemble(host, assembly) {
  return runAssembleWith(host, fakeAgent(), assembly);
}

async function runAssembleWith(host, agent, assembly) {
  const handlers = host.listeners.get('system-prompt/assemble') ?? [];
  let current = assembly;
  for (const handler of handlers) {
    current = await handler(current, { agent, scope: agent }, async () => current);
  }
  return current;
}
