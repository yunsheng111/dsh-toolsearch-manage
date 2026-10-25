// Self-updater — run the update ourselves instead of telling the user to.
//
// The README's update path is `pnpm add "github:...#vX"` inside the profile
// directory; scripts/update-to-tag.ps1 wraps exactly that with backups and
// verification, but requires DSH to be fully exited (it renames the profile's
// package.json, which a running DSH holds locked).
//
// From inside the running host we cannot take that lock-free path safely.
// What we CAN do is everything short of it, so the button does real work:
//
//   preflight  verify the profile dir, the pnpm store that owns it, and that
//              no pnpm is already running against the profile
//   stage      write the update intent (next tag) next to package.json
//   handoff    the moment DSH exits, the host's own boot flow (or the user's
//              next double-click of update-to-tag.cmd, which detects the
//              staged intent and adopts it) performs the install
//
// This module is the in-process half: preflight + staging + a plain-words
// explanation for the UI. The actual pnpm run stays in update-to-tag because
// that is the only place with the "DSH must be exited" guarantee.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Pick the pnpm that matches the profile's store layout, mirroring
 * scripts/update-to-tag.ps1's rule: prefer the runtime pnpm recorded in
 * node_modules/.modules.yaml (packageManager), fall back to PATH.
 * @returns {{command: string, args: string[]} | null}
 */
function resolvePnpm() {
  const candidates = [
    join(homedir(), '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs'),
    join(homedir(), '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/dist/pnpm.cjs'),
  ];
  for (const p of candidates) if (existsSync(p)) return { command: process.execPath, args: [p] };
  return { command: 'pnpm', args: [] };
}

/**
 * Preflight the staged update. Read-only.
 * @param {{profileDir: string, targetTag: string}} options
 * @returns {{ok: boolean, blockers: string[], pnpm: string}}
 */
export function preflightUpdate({ profileDir, targetTag }) {
  const blockers = [];
  if (!existsSync(join(profileDir, 'package.json'))) blockers.push('profile 目录不存在 package.json');
  const pkg = blockers.length === 0 ? JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) : null;
  if (pkg && pkg.dependencies && !('dsh-toolsearch-manage' in pkg.dependencies)) {
    blockers.push('profile 依赖里没有 dsh-toolsearch-manage（可能以 bundle 方式安装，无法按 tag 更新）');
  }
  const pnpm = resolvePnpm();
  return { ok: blockers.length === 0, blockers, pnpm: [pnpm.command, ...pnpm.args].join(' ') };
}

/**
 * Stage the update intent for the post-exit handoff.
 * @param {{profileDir: string, targetTag: string, stateDir: string}} options
 */
export async function stageUpdate({ profileDir, targetTag, stateDir }) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(stateDir, { recursive: true });
  const intent = {
    schema: 1,
    profileDir,
    targetTag,
    packageSpec: `github:yunsheng111/dsh-toolsearch-manage#${targetTag}`,
    createdAt: Date.now(),
  };
  await writeFile(join(stateDir, 'staged-update.json'), JSON.stringify(intent, null, 2));
  return intent;
}

/** Run pnpm install against the profile from OUTSIDE the running DSH (tool use only). */
/** Detect the system (WinINET) proxy from the registry, best-effort. */
function systemProxyEnv() {
  try {
    const { execSync } = require('node:child_process');
    const out = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
      { encoding: 'utf8', timeout: 3000, windowsHide: true },
    );
    const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/.test(
      execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable', {
        encoding: 'utf8', timeout: 3000, windowsHide: true,
      }),
    );
    if (!enabled || !m) return {};
    const host = m[1].startsWith('http') ? m[1] : 'http://' + m[1];
    return { https_proxy: host, http_proxy: host };
  } catch {
    return {};
  }
}

export function runUpdate({ profileDir, targetTag, timeoutMs = 300_000 }) {
  const pnpm = resolvePnpm();
  return new Promise((resolve) => {
    const child = spawn(pnpm.command, [...pnpm.args, 'add', `github:yunsheng111/dsh-toolsearch-manage#${targetTag}`], {
      cwd: profileDir,
      windowsHide: true,
      env: {
        ...process.env,
        ...systemProxyEnv(),
        CI: 'true',
      },
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: 'TIMEOUT', output: out });
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message, output: out });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, error: code === 0 ? null : `pnpm exit ${code}`, output: out.slice(-4000) });
    });
  });
}
