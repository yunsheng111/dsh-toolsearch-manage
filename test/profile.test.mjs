// Which profile's `cordis.patch.yml` this plugin owns.
//
// This is separated from `lib/store.js` because it is the one decision whose
// failure is silent and cross-cutting: with the wrong answer the plugin rewrites
// ANOTHER profile's patch, imports nothing from its own, and leaves a managed
// block in a profile it does not belong to. `dsh-skill-mcp-manager@1.2.2` failed
// exactly this way on this machine (it read `--profile`, which the desktop host
// never passes).
//
// Run: node --test "test/*.test.mjs"

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveProfile, argvProfileDir, patchPathFor } from '../lib/store.js';

/** A throwaway home with the named profiles created. */
async function withHome(profiles, body) {
  const home = await mkdtemp(join(tmpdir(), 'tsm-profile-'));
  try {
    for (const name of profiles) await mkdir(join(home, 'profiles', name), { recursive: true });
    await body(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const savedEnv = {
  DSH_PROFILE: process.env.DSH_PROFILE,
  DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
};

function clearEnv() {
  delete process.env.DSH_PROFILE;
  delete process.env.DSH_PROFILE_DIR;
}

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('argvProfileDir reads the desktop host positional argument', () => {
  // The real desktop launch line, abbreviated:
  //   <electron> --expose-internals <…>/dsh-desktop-host/lib/index.js <dsh> <profileDir> …
  const install = String.raw`D:\[MSK_CUSTOM]\resources\app.asar\dsh`;
  const profileDir = String.raw`C:\Users\me\.dsh\profiles\desktop`;
  const argv = [
    'electron.exe',
    '--expose-internals',
    String.raw`D:\[MSK_CUSTOM]\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js`,
    install,
    profileDir,
    String.raw`D:\[MSK_CUSTOM]\resources\runtime\primary-runtime`,
  ];
  assert.equal(argvProfileDir(String.raw`C:\Users\me\.dsh\profiles`, argv), 'desktop');
});

test('argvProfileDir ignores deeper paths and non-profile dirs', () => {
  const profiles = String.raw`C:\u\.dsh\profiles`;
  // A file inside a profile is not a profile name.
  assert.equal(argvProfileDir(profiles, ['x', String.raw`C:\u\.dsh\profiles\desktop\cordis.patch.yml`]), undefined);
  // A different home is not ours.
  assert.equal(argvProfileDir(profiles, ['x', String.raw`C:\other\.dsh\profiles\web`]), undefined);
  // `profiles` appearing twice in an install path must not confuse the prefix.
  assert.equal(
    argvProfileDir(profiles, ['x', String.raw`C:\u\.dsh\profiles-archive\profiles\desktop`, String.raw`C:\u\.dsh\profiles\web`]),
    'web',
  );
});

test('an explicit config profile always wins', async () => {
  await withHome(['desktop', 'web'], async (home) => {
    assert.equal(resolveProfile({ profile: 'desktop' }, { home }), 'desktop');
    // Even when the directory is missing: an explicit choice is the operator's.
    assert.equal(resolveProfile({ profile: 'custom' }, { home }), 'custom');
  });
});

test('the positional profile directory beats a stale environment default', async () => {
  clearEnv();
  try {
    await withHome(['desktop', 'web'], async (home) => {
      // This is the desktop-host case that broke: no --profile, and the fallback
      // used to produce `web`.
      const argv = ['electron', '--expose-internals', 'host.js', 'install', join(home, 'profiles', 'desktop')];
      assert.equal(resolveProfile({}, { home, argv }), 'desktop');
    });
  } finally {
    restoreEnv();
  }
});

test('a stale DSH_PROFILE naming a missing profile is rejected', async () => {
  clearEnv();
  process.env.DSH_PROFILE = 'ghost';
  try {
    await withHome(['desktop'], async (home) => {
      // `ghost` does not exist under this home, so the only real profile wins.
      assert.equal(resolveProfile({}, { home, argv: ['host.js'] }), 'desktop');
    });
  } finally {
    restoreEnv();
  }
});

test('the only existing profile is chosen when nothing else decides', async () => {
  clearEnv();
  try {
    await withHome(['desktop'], async (home) => {
      assert.equal(resolveProfile({}, { home, argv: ['host.js'] }), 'desktop');
    });
    // Two profiles and no signal: keep the historical default rather than guess.
    await withHome(['desktop', 'web'], async (home) => {
      assert.equal(resolveProfile({}, { home, argv: ['host.js'] }), 'web');
    });
  } finally {
    restoreEnv();
  }
});

test('DSH_PROFILE is honoured when the profile exists', async () => {
  clearEnv();
  process.env.DSH_PROFILE = 'desktop';
  try {
    await withHome(['desktop', 'web'], async (home) => {
      assert.equal(resolveProfile({}, { home, argv: ['host.js'] }), 'desktop');
    });
  } finally {
    restoreEnv();
  }
});

test('--profile is honoured for a CLI launch', async () => {
  clearEnv();
  try {
    await withHome(['desktop', 'web'], async (home) => {
      assert.equal(resolveProfile({}, { home, argv: ['dsh', '--profile', 'desktop'] }), 'desktop');
    });
  } finally {
    restoreEnv();
  }
});

test('patchPathFor composes the profile patch path', async () => {
  await withHome(['desktop'], async (home) => {
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    try {
      const path = patchPathFor({}, { home, argv: ['host.js', join(home, 'profiles', 'desktop')] });
      assert.equal(path, join(home, 'profiles', 'desktop', 'cordis.patch.yml'));
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
    }
  });
});
