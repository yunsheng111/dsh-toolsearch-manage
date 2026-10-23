// The browser half, exercised against the contract the host actually enforces.
//
// This file exists because the client bundle had no test at all, and that is how
// a real defect shipped twice: `apply()` registered three slots, but each
// `inject` callback returned `disposers.push(…)` — a NUMBER — instead of the
// disposer. The host calls that value on teardown and threw `TypeError:
// dispose is not a function`, which aborted the remaining registrations. The
// visible result was a rail icon that opened nothing and a settings page that
// never appeared.
//
// Run: node --test "test/*.test.mjs"

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, '..', 'client', 'client.js');

/**
 * Load the real bundle the way the host does: a `__ModuleLoader__.load` call
 * with a `factory(require)` that must yield `{ name, inject, apply }`.
 *
 * @param {{settings?: object}} [options] what `/settings` resolves to
 */
function loadPlugin(options = {}) {
  const source = readFileSync(bundlePath, 'utf8');
  let loaded;
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    Fragment: 'Fragment',
  };
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          loaded = definition;
        },
      },
    },
    React,
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ uiPlacement: 'both', builtins: [], entries: [], metaTools: [], ...options.settings }),
    }),
    location: { origin: 'http://localhost:0' },
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, appendChild() {}, set textContent(v) {} }),
      head: { appendChild() {} },
    },
    console,
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  assert.equal(typeof loaded?.factory, 'function', 'bundle did not call __ModuleLoader__.load');
  const plugin = loaded.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`bundle required an unexpected module: ${name}`);
  });
  return plugin;
}

/** A slot registry that enforces the host's disposer contract. */
function fakeSlots() {
  const registrations = [];
  return {
    registrations,
    slots: {
      inject(name, run) {
        const disposer = run();
        // The host treats the return value as a disposer. Anything else is a bug
        // that only shows up on teardown, far from the cause.
        assert.equal(
          typeof disposer,
          'function',
          `inject("${name}") must return a disposer function, got ${typeof disposer}`,
        );
        return disposer;
      },
      register(registration, Component) {
        registrations.push({ registration, Component });
        return () => {
          const index = registrations.findIndex((entry) => entry.registration === registration);
          if (index !== -1) registrations.splice(index, 1);
        };
      },
    },
  };
}

test('the bundle loads and declares the shape the host expects', () => {
  const plugin = loadPlugin();
  assert.equal(plugin.name, 'dsh-toolsearch-manage');
  // An array created inside the vm has that realm's Array prototype, so a strict
  // deepEqual against a host-realm array fails on identity. Compare the values.
  assert.equal([...plugin.inject].join(','), 'slots');
  assert.equal(typeof plugin.apply, 'function');
});

test('every inject callback returns a real disposer', () => {
  // The regression: returning `disposers.push(…)` gave a number, the host threw
  // on teardown, and every registration after it was skipped.
  const plugin = loadPlugin();
  const fake = fakeSlots();
  plugin.apply({ slots: fake.slots });
  assert.ok(fake.registrations.length >= 3, `expected at least 3 registrations, got ${fake.registrations.length}`);
});

test('seats are claimed synchronously so activation can see them', () => {
  // A registration made from a promise callback lands after the host's activation
  // step, and the seat is then never rendered.
  const plugin = loadPlugin();
  const fake = fakeSlots();
  plugin.apply({ slots: fake.slots });
  const names = fake.registrations.map((entry) => entry.registration.name);
  assert.ok(names.includes('sidebar.panellist'), `missing panellist seat: ${names.join(', ')}`);
  assert.ok(names.includes('main'), `missing main seat: ${names.join(', ')}`);
  assert.ok(names.includes('settings.section'), `missing settings seat: ${names.join(', ')}`);
});

test('the rail seat is an icon component, the main seat is the page', () => {
  // These are different seats with different owner props. Registering the page in
  // the icon seat is what put a whole panel into the left rail.
  const plugin = loadPlugin();
  const fake = fakeSlots();
  plugin.apply({ slots: fake.slots });
  const rail = fake.registrations.find((entry) => entry.registration.name === 'sidebar.panellist');
  const main = fake.registrations.find((entry) => entry.registration.name === 'main');
  assert.ok(rail && main);

  // The icon must render an SVG from { size, active } and nothing else.
  const icon = rail.Component({ size: 18, active: false });
  assert.equal(icon.type, 'svg');
  assert.equal(icon.props.width, 18);
  assert.equal(icon.props.height, 18);

  // The page must not be an SVG.
  const page = main.Component({});
  assert.notEqual(page.type, 'svg');
});

test('the settings seat label is the operator-facing name', () => {
  const plugin = loadPlugin();
  const fake = fakeSlots();
  plugin.apply({ slots: fake.slots });
  const settings = fake.registrations.find((entry) => entry.registration.name === 'settings.section');
  assert.equal(settings.registration.label, '工具检索');
  assert.equal(settings.registration.id, 'toolsearch');
});

test('the rail id matches the main key, which is how the host pairs them', () => {
  const plugin = loadPlugin();
  const fake = fakeSlots();
  plugin.apply({ slots: fake.slots });
  const rail = fake.registrations.find((entry) => entry.registration.name === 'sidebar.panellist');
  const main = fake.registrations.find((entry) => entry.registration.name === 'main');
  assert.equal(rail.registration.id, main.registration.key);
});
