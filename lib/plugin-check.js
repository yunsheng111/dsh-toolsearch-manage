// Plugin health check — profile integrity probe, the fifth meta tool.
//
// The 2026-10-25 startup crash: a plugin's `optionalDependencies` pulled
// `@deepseek-ai/dsh-tools@0.1.2-rc.1` (a host-internal package) into the
// profile's node_modules. That stray copy shadowed the host's built-in
// implementation, failed to load (`@deepseek-ai/cordis` never installed), and
// took the required `tools` service down with it — 20 plugins stalled on boot.
//
// Two probes, both read-only, no plugin code executed:
//
//   PROBE  (pre-install)  fetch npm metadata for a candidate package and flag
//          any `@deepseek-ai/*` host-internal package in its real install
//          fields (`dependencies` / `optionalDependencies`). peerDependencies
//          entries are the normal "host provides this" declaration and never
//          trigger a download — not a finding.
//   AUDIT  (installed)    walk the booted profile's node_modules/@deepseek-ai,
//          diff each package against the versions the desktop host ships
//          (app.asar index), and verify every declared dependency resolves.
//          A version mismatch is shadow-hijack risk; an unresolvable
//          dependency is a guaranteed load crash.
//
// npm metadata is fetched with a short timeout and a mirror fallback; GitHub
// and local-path installs have no registry metadata, so PROBE degrades to a
// notice pointing at AUDIT, which works for any install source.

import { spawn } from 'node:child_process';
import { existsSync, openSync, readSync, closeSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const SCOPE = '@deepseek-ai';
const REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com'];

/** npm view with a hard timeout; mirrors are tried in order. Resolves null when unreachable. */
function npmViewJson(name, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const tryAt = (i) => {
      if (i >= REGISTRIES.length) return resolve(null);
      const child = spawn('npm', ['view', name, '--json', `--registry=${REGISTRIES[i]}`], {
        shell: true,
        windowsHide: true,
      });
      let out = '';
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      child.stdout.on('data', (chunk) => (out += chunk));
      child.on('error', () => finish(null));
      child.on('close', (code) => {
        if (settled) return;
        const text = out.trim();
        if (code === 0 && text.startsWith('{')) {
          try {
            finish(JSON.parse(text));
          } catch {
            finish(null);
          }
        } else {
          tryAt(i + 1);
        }
      });
    };
    tryAt(0);
  });
}

/**
 * Parse the asar header JSON, tolerating trailing pickle padding after the
 * JSON object (Electron pads the header to 4-byte boundaries).
 */
function parseHeaderJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    let depth = 0;
    let end = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    return JSON.parse(text.slice(0, end));
  }
}

/**
 * Read the desktop host's shipped @deepseek-ai/* versions straight from the
 * asar header — no extraction, no unpacked-dir assumptions. Best-effort: an
 * unreadable archive returns {} and AUDIT reports only missing dependencies.
 */
export function readHostVersions() {
  const candidates = [
    process.env.DSH_HOST_ASAR,
    'D:/DeepSeek Harness/resources/app.asar',
  ].filter(Boolean);
  for (const asarPath of candidates) {
    try {
      const fd = openSync(asarPath, 'r');
      try {
        const head = Buffer.alloc(16);
        readSync(fd, head, 0, 16, 0);
        // Pickle framing: [4] total payload, [8] string byte length, [12] its
        // char count. The JSON object spans [12] bytes from offset 16; the
        // remainder of [8] is pickle padding, and file offsets are relative to
        // 16 + [12].
        const jsonLen = head.readUInt32LE(12);
        const header = Buffer.alloc(jsonLen);
        readSync(fd, header, 0, jsonLen, 16);
        const index = parseHeaderJson(header.toString('utf8'));
        const base = 16 + jsonLen;
        const dir = index.files?.dsh?.files?.node_modules?.files?.[SCOPE]?.files;
        if (!dir) continue;
        const versions = {};
        for (const name of Object.keys(dir)) {
          const entry = dir[name]?.files?.['package.json'];
          // `unpacked: true` entries live in app.asar.unpacked/, not in the
          // archive (no offset); they are optional natives and not part of the
          // shadow-hijack comparison.
          if (!entry || entry.unpacked || entry.offset === undefined) continue;
          const buf = Buffer.alloc(entry.size);
          readSync(fd, buf, 0, entry.size, base + Number(entry.offset));
          versions[name] = JSON.parse(buf.toString('utf8')).version;
        }
        if (Object.keys(versions).length > 0) return versions;
      } finally {
        closeSync(fd);
      }
    } catch {
      // next candidate
    }
  }
  return {};
}

/**
 * PROBE — pre-install verdict for one npm package.
 * Returns findings for the plugin's UI and tool renderers.
 */
export async function probePackage(name) {
  const meta = await npmViewJson(name);
  if (meta === null) {
    return {
      status: 'unknown',
      summary: `无法获取 ${name} 的 npm 元数据（GitHub / 本地路径安装没有注册表元数据）。装完跑 AUDIT 模式体检即可。`,
      packages: [],
    };
  }
  const hijackFields = ['dependencies', 'optionalDependencies'];
  const findings = [];
  for (const field of hijackFields) {
    for (const dep of Object.keys(meta[field] ?? {})) {
      if (dep.startsWith(`${SCOPE}/`)) findings.push({ package: dep, via: field });
    }
  }
  const peers = Object.keys(meta.peerDependencies ?? {}).filter((dep) => dep.startsWith(`${SCOPE}/`));
  const version = meta.version ?? '(未知版本)';
  if (findings.length > 0) {
    return {
      status: 'fail',
      summary: `🔴 ${name}@${version} 会把宿主内部包真实安装进 profile：${findings.map((f) => `${f.package}（${f.via}）`).join('、')}。可能顶掉宿主内置实现导致启动失败（2026-10-25 崩溃同款机制）。`,
      packages: findings,
      peerNotes: peers,
    };
  }
  return {
    status: 'pass',
    summary: `✅ ${name}@${version} 不会向 profile 写入 @deepseek-ai/* 宿主内部包。`,
    packages: [],
    peerNotes: peers,
  };
}

/**
 * AUDIT — installed-profile integrity check.
 * `profileDir` is the booted profile the caller resolved (store.resolveProfile).
 */
export function auditProfile(profileDir) {
  const scopedDir = join(profileDir, 'node_modules', SCOPE);
  if (!existsSync(scopedDir)) {
    return {
      status: 'pass',
      summary: 'profile 的 node_modules 里没有 @deepseek-ai/* 包（无顶包风险）。',
      packages: [],
    };
  }
  const hostVersions = readHostVersions();
  const findings = [];
  for (const name of readdirSync(scopedDir)) {
    const pkgJson = join(scopedDir, name, 'package.json');
    if (!existsSync(pkgJson)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
    } catch {
      continue;
    }
    const hostVersion = hostVersions[name];
    const shadowed = hostVersion !== undefined && hostVersion !== pkg.version;
    const missing = [];
    const req = createRequire(pkgJson);
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      try {
        req.resolve(dep);
      } catch {
        missing.push(dep);
      }
    }
    if (shadowed || missing.length > 0) {
      const reasons = [];
      if (shadowed) reasons.push(`宿主内置 ${hostVersion}，profile 是 ${pkg.version}（顶包风险）`);
      for (const dep of missing) reasons.push(`依赖缺失：${dep}（一加载就崩）`);
      findings.push({ package: `${SCOPE}/${name}`, version: pkg.version, reasons });
    }
  }
  if (findings.length === 0) {
    return {
      status: 'pass',
      summary: '✅ profile 内 @deepseek-ai/* 包与宿主无版本冲突、依赖齐全。',
      packages: [],
    };
  }
  return {
    status: 'fail',
    summary: `🔴 ${findings.length} 个问题包，处理：删掉对应目录后对该 profile 重跑 pnpm install。`,
    packages: findings,
  };
}
