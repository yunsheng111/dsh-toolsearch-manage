#!/usr/bin/env node
// plugin-guard — DSH 插件预检 / profile 体检 / 任务委派的命令行入口。
//
// 三个子命令（对应原型图三个标签页）：
//   probe <npm包名> [-p profile]     装前预检：npm 元数据红灯检查
//   audit [-p profile]               装后体检：profile vs 宿主内置版本对照
//   delegate "任务内容" [-w 工作区]   把任务交给 dsh headless 处理，报告落在所选工作区
//
// 环境自检（headless 三坑的固化）：
//   node >= 24（低版本静默退出）· MAGPIE_GATEWAY_KEY（缺则从 ~/.dsh/.credentials.yaml 取）
//   · dsh CLI 位置（优先宿主 runtime 的 node24 跑全局 bin.js，不依赖 PATH）

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const GUARD = await import('../lib/plugin-check.js');

// ── 环境探测 ─────────────────────────────────────────────────────────────

/** 宿主 runtime 的 node 24（headless 的硬要求）；找不到返回 null。 */
function findRuntimeNode() {
  const candidates = [
    join(DSH_HOME, 'dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe'),
    join(DSH_HOME, 'dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node'),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

/** dsh CLI 的 bin.js（全局 npm 安装）。 */
function findDshBin() {
  const candidates = [
    process.env.DSH_BIN,
    'D:/Program Files/nvm/node_global/node_modules/@deepseek-ai/dsh/lib/bin.js',
    'C:/Program Files/nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js',
  ].filter(Boolean);
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

/** MAGPIE_GATEWAY_KEY：环境变量优先，缺则从凭据文件取（值就是明文短串）。 */
function resolveApiKey() {
  if (process.env.MAGPIE_GATEWAY_KEY) return process.env.MAGPIE_GATEWAY_KEY;
  try {
    const text = readFileSync(join(DSH_HOME, '.credentials.yaml'), 'utf8');
    const m = text.match(/^\s*MAGPIE_GATEWAY_KEY:\s*(\S+)\s*$/m);
    if (m) return m[1].replace(/^['"]|['"]$/g, '');
  } catch {
    /* 凭据文件不存在 */
  }
  return null;
}

// ── 子命令 ───────────────────────────────────────────────────────────────

async function cmdProbe(pkgName, profile) {
  const r = await GUARD.probePackage(pkgName);
  console.log(r.summary);
  if (r.peerNotes?.length) console.log(`ℹ️  peerDependencies 声明（宿主提供，正常）：${r.peerNotes.join(', ')}`);
  process.exitCode = r.status === 'fail' ? 2 : 0;
}

async function cmdAudit(profile) {
  const dir = join(DSH_HOME, 'profiles', profile);
  const r = GUARD.auditProfile(dir);
  console.log(r.summary);
  for (const p of r.packages ?? []) {
    console.log(`  ${p.package}@${p.version ?? ''}`);
    for (const reason of p.reasons ?? []) console.log(`    - ${reason}`);
  }
  process.exitCode = r.status === 'fail' ? 2 : 0;
}

function cmdDelegate(task, workspace, reportName) {
  const node24 = findRuntimeNode();
  const bin = findDshBin();
  const key = resolveApiKey();
  const missing = [];
  if (!node24) missing.push('宿主 runtime node24（~/.dsh/dsh-runtimes/.../node/bin）');
  if (!bin) missing.push('dsh CLI bin.js（可用 DSH_BIN 环境变量指定）');
  if (!key) missing.push('MAGPIE_GATEWAY_KEY（环境变量或 ~/.dsh/.credentials.yaml）');
  if (missing.length) {
    console.error(`✗ 委派前置缺失：\n  - ${missing.join('\n  - ')}`);
    process.exitCode = 1;
    return;
  }
  const cwd = existsSync(workspace) ? workspace : undefined;
  if (!cwd) {
    console.error(`✗ 工作区不存在：${workspace}`);
    process.exitCode = 1;
    return;
  }
  const fullTask = reportName
    ? `${task}\n\n（要求：分析过程只读，不要修改任何 profile 文件；把结论写入当前工作区的 ${reportName}。）`
    : task;
  console.log(`→ dsh headless 委派中…（工作区：${workspace}${reportName ? `，报告：${reportName}` : ''}）`);
  const child = spawn(node24, [bin, 'headless', fullTask], {
    cwd,
    env: { ...process.env, MAGPIE_GATEWAY_KEY: key },
    stdio: 'inherit',
  });
  child.on('close', (code) => {
    const report = reportName ? join(workspace, reportName) : null;
    if (report && existsSync(report)) console.log(`\n✓ 报告已落盘：${report}`);
    process.exitCode = code ?? 1;
  });
}

// ── 参数解析 ─────────────────────────────────────────────────────────────

function usage() {
  console.log(`用法：
  plugin-guard probe <npm包名> [-p profile]     装前预检（红灯=会拉宿主内部包进 profile）
  plugin-guard audit [-p profile]               装后体检（profile vs 宿主内置版本对照）
  plugin-guard delegate "任务" -w <工作区> [-r 报告文件名]
                                                把任务交给 dsh headless，工作区自选
环境变量：DSH_BIN（dsh bin.js 路径）· MAGPIE_GATEWAY_KEY · DSH_HOST_ASAR`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
let profile = 'desktop';
let workspace = join(homedir(), 'Documents/deepseek-harness/default-workspace');
let reportName = null;
let positional = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-p') profile = argv[++i];
  else if (a === '-w') workspace = argv[++i];
  else if (a === '-r') reportName = argv[++i];
  else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
  else positional.push(a);
}

switch (cmd) {
  case 'probe': {
    const pkg = positional[0];
    if (!pkg) { console.error('probe 需要 npm 包名'); process.exit(1); }
    await cmdProbe(pkg, profile);
    break;
  }
  case 'audit':
    await cmdAudit(profile);
    break;
  case 'delegate': {
    const task = positional.join(' ');
    if (!task) { console.error('delegate 需要任务内容'); process.exit(1); }
    cmdDelegate(task, workspace, reportName);
    break;
  }
  default:
    usage();
    process.exitCode = 1;
}
