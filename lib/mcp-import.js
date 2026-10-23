// Import normalization: another client''s MCP config → this plugin''s spec shape.
//
// Copied from `dsh-toolbox-ui@1.8.2` `lib/mcp-config.js` (MIT; see
// LICENSE-MIT-TOOLBOX-UI), keeping only the read/normalize half. The YAML
// document half stayed behind: this plugin''s patch layer (lib/patch.js) owns
// every write to cordis.patch.yml, and a second writer is the exact conflict
// this plugin exists to remove.
//
// One deliberate change: `defer` is no longer a recognized field. Tier is
// expressed by the registry now, so an imported `defer` must not become a
// second opinion — it is reported as unsupported instead of silently stored.

import { makeEnvExpression, makeExpression, isSafeExpression } from './env-expression.js';
import { CATEGORY_ORDER, CATEGORY_LABELS, MCP_CATALOG, MCP_COPY_FIELDS, catalogById } from './mcp-catalog.js';
import { hasOwn, setOwn } from './own-property.js';

export const MCP_PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client';
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_TIMER_DELAY_MS = 2147483647;

/** Fields this plugin projects into an mcp-client config. */
export const MANAGED_CONFIG_FIELDS = ['transport', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'toolCallTimeoutMs', 'failOnStartupError', 'reconnect'];

export const MCP_CATEGORIES = CATEGORY_ORDER;
export const MCP_CATEGORY_LABELS = CATEGORY_LABELS;
const INTERPOLATION = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/g;
const UNSUPPORTED_TEMPLATE = '不支持的变量表达式（只允许 ${VAR}、${VAR:-fallback} 与 ${env:VAR}）';

// 内置目录 = 市场目录的投影。以前这里是硬编码的 5 条，现在是 `lib/mcp-catalog.js`
// 的派生视图：目录加一条，内置清单与身份识别表同时跟上，不需要在两处各改一遍。
//
// `name`（写进配置的 serverName）取 id，是刻意的：id 一旦发布就不能改，而 serverName
// 决定工具名 `mcp__<serverName>__<tool>`，让两者同源就不会出现「目录改名导致老配置变孤儿」。
export const BUILTIN_MCP_SERVERS = MCP_CATALOG.map((entry) => {
  const server = {
    id: entry.id,
    label: entry.label,
    summary: entry.summary,
    access: entry.access,
    name: entry.id,
    transport: entry.transport,
  }
  // 文案字段（label/summary/access/vendor/categoryLabel 及各自 *En，见 build-catalog.mjs）：
  // 只跟着搬运，不参与任何判定——装/卸/识别身份都只看 id 与 endpoint，多带不影响它们。
  // 字段表由生成器随产物导出（MCP_COPY_FIELDS）：加一个可译字段只改生成器一处。
  // 漏搬的后果是字段被静默丢掉、英文界面漏出中文——jsdom 测不出来，真机才看得见，
  // 所以「builtin catalog carries every field the market UI reads」那条用例钉着它。
  for (const field of MCP_COPY_FIELDS) {
    for (const suffix of ['', 'En']) {
      const key = field + suffix
      if (entry[key] !== undefined) server[key] = entry[key]
    }
  }
  // 占位符提示（含英文）：args 派生的**显示**文案（「装完先改这里」），同样随语言切换。
  for (const key of ['placeholders', 'placeholdersEn']) {
    if (entry[key] !== undefined) server[key] = structuredClone(entry[key])
  }
  for (const field of ['url', 'headers', 'command', 'args']) {
    if (entry[field] !== undefined) server[field] = structuredClone(entry[field])
  }
  return server
})

/**
 * "Is this already-configured server one of the catalog entries?" — decided by
 * endpoint or package name, not by the local name alone, so a server the user
 * renamed to `my-exa` is still recognised as Exa and the market will not add a
 * duplicate.
 *
 * Derived from the catalog rather than hand-maintained: hosts come from `url`,
 * packages from the entry's `packages` (a stdio entry can derive them from
 * `args`), so adding a catalog row needs no second edit.
 */
export const BUILTIN_MCP_IDENTITIES = Object.fromEntries(MCP_CATALOG.map((entry) => {
  const hosts = []
  if (typeof entry.url === 'string') {
    try {
      hosts.push(new URL(entry.url).hostname.toLowerCase())
    } catch { /* an unparseable url claims no host; packages cover it */ }
  }
  // Explicit packages first; otherwise derive from args. Only non-flag arguments
  // are package names — `-y` and `--flag` are not.
  const packages = entry.packages ?? (entry.args || []).filter((arg) => typeof arg === 'string'
    && !arg.startsWith('-')
    && /^[@a-z0-9]/i.test(arg))
  return [entry.id, { hosts, packages }]
}))

/**
 * Does one configured server correspond to one catalog entry?
 *
 * The current implementation only knows the servers this plugin already holds;
 * a match is used to avoid offering a second copy of a catalog server that is
 * already registered under a different local name.
 */
export function matchesBuiltinIdentity(server, builtin) {
  const identity = BUILTIN_MCP_IDENTITIES[builtin.id]
  if (identity === undefined) return false
  if (server.transport === 'streamable-http' && typeof server.url === 'string') {
    try {
      if (identity.hosts.includes(new URL(server.url).hostname.toLowerCase())) return true
    } catch { /* fall through to the package test */ }
  }
  const tokens = [server.command, ...(Array.isArray(server.args) ? server.args : [])].filter((item) => typeof item === 'string')
  return identity.packages.some((pkg) => tokens.some((token) => token === pkg || token.endsWith(`/${pkg}`)))
}

/**
 * One catalog entry → a spec in the same shape {@link normalizeMcpImport}
 * returns, so the market and the importer feed the registry the same way.
 */
export function builtinSpec(builtin) {
  const spec = { name: builtin.name }
  for (const field of MANAGED_CONFIG_FIELDS) {
    if (builtin[field] !== undefined) spec[field] = structuredClone(builtin[field])
  }
  return spec
}

/**
 * The catalog in the shape the panel needs.
 *
 * The browser half is a prebuilt bundle and cannot import this module, so every
 * display field (category, vendor, homepage, required credentials) has to travel
 * with this response. A missing field shows as `undefined` in the panel, which no
 * server-side test would catch.
 *
 * @param {ReadonlyArray<object>} effectiveServers currently configured servers
 * @returns {object[]} catalog entries for the panel
 */
export function builtinMcpCatalog(effectiveServers) {
  return BUILTIN_MCP_SERVERS.map((builtin) => {
    const matches = effectiveServers.filter((server) => matchesBuiltinIdentity(server, builtin))
    const installedAs = [...new Set(matches.map((server) => server?.name ?? server?.serverName).filter(Boolean))]
    const source = catalogById().get(builtin.id) || {}
    return {
      id: builtin.id,
      label: builtin.label,
      summary: builtin.summary,
      access: builtin.access,
      name: builtin.name,
      transport: builtin.transport,
      configuration: builtinSpec(builtin),
      installed: installedAs.length > 0,
      installedAs,
      category: source.category,
      // The category label travels with the entry (generator-maintained Chinese
      // label + categoryLabelEn); looking it up here would be a second source of
      // truth for the same string.
      categoryLabel: source.categoryLabel,
      vendor: source.vendor,
      // English copy is optional: absent keys are omitted rather than written as
      // empty strings, because the panel's test is "is it there".
      ...Object.fromEntries(MCP_COPY_FIELDS.filter((field) => builtin[`${field}En`]).map((field) => [`${field}En`, builtin[`${field}En`]])),
      homepage: source.homepage,
      envKeys: source.envKeys || [],
      // Connection parameters (HOST/PORT/USER) are reported separately from
      // credentials: the panel says "fill in connection info" rather than "needs
      // a key" for something like a local Redis.
      configKeys: source.configKeys || [],
      // Entries whose args still contain a `<placeholder>` cannot work until
      // edited; the panel must say so instead of reporting a successful install.
      placeholders: source.placeholders || [],
      ...(source.placeholdersEn ? { placeholdersEn: source.placeholdersEn } : {}),
    }
  })
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Name-keyed maps go through the same primitives in lib/own-property.js
// (`__proto__` is a legal serverName here, and plain assignment silently drops
// it).

/**
 * `!!js \`…\`` 这一历史写法 → 受限表达式。`${process.env.X}` 是它唯一的变量语法；
 * 转出时一律走 `makeExpression`，因此产出的一定是「总值」表达式。
 */
function normalizeLegacyTemplate(value) {
  const legacy = /^!!js `([^`\\]*)`$/.exec(value)
  if (!legacy) return null
  const body = legacy[1]
  const pattern = /\$\{process\.env\.([A-Za-z_][A-Za-z0-9_]*)\}/g
  const tokens = []
  let cursor = 0
  let match
  let hasReference = false
  while ((match = pattern.exec(body))) {
    const literal = body.slice(cursor, match.index)
    if (literal.includes('${')) return null
    if (literal) tokens.push({ kind: 'literal', text: literal })
    tokens.push({ kind: 'env', name: match[1] })
    hasReference = true
    cursor = match.index + match[0].length
  }
  const tail = body.slice(cursor)
  if (!hasReference || tail.includes('${')) return null
  if (tail) tokens.push({ kind: 'literal', text: tail })
  return makeExpression(tokens)
}

function expressionValue(value) {
  if (typeof value !== 'string') return value
  if (value.startsWith('!!js ')) {
    if (isSafeExpression(value)) return value
    const normalized = normalizeLegacyTemplate(value)
    if (normalized) return normalized
    throw new Error('!!js 只允许受限的 process.env.NAME 环境变量表达式')
  }
  const reserved = /\$\{(?:workspaceFolder(?:Basename)?|userHome|pathSeparator|\/)\}/.exec(value)
  if (reserved) throw new Error(`${reserved[0]} 是其他客户端变量，DSH 不支持安全转换`)
  const exact = /^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?\}$/.exec(value)
  // 一律走 makeEnvExpression：它**总会**补上 `?? ""`（理由见 env-expression.js）。变量缺失
  // 只该让这一处退化成空字符串——服务器自己连不上、面板里看得见——而不能把宿主一起拖下水。
  if (exact) return makeEnvExpression(exact[1], exact[2])

  const tokens = []
  let cursor = 0
  let match
  INTERPOLATION.lastIndex = 0
  while ((match = INTERPOLATION.exec(value))) {
    const literal = value.slice(cursor, match.index)
    // 不回显出错片段：这段文本来自用户配置（含密钥），错误信息会被送进浏览器。
    if (literal.includes('${')) throw new Error(UNSUPPORTED_TEMPLATE)
    if (literal) tokens.push({ kind: 'literal', text: literal })
    tokens.push(match[2] === undefined ? { kind: 'env', name: match[1] } : { kind: 'fallback', name: match[1], fallback: match[2] })
    cursor = match.index + match[0].length
  }
  INTERPOLATION.lastIndex = 0
  const tail = value.slice(cursor)
  if (tail.includes('${')) throw new Error(UNSUPPORTED_TEMPLATE)
  if (!tokens.length) return value
  if (tail) tokens.push({ kind: 'literal', text: tail })
  return makeExpression(tokens)
}

function normalizeMap(value, field, warnings, serverName) {
  if (value === undefined) return undefined
  if (!isObject(value)) throw new Error(`${serverName}.${field} 必须是对象`)
  const result = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') setOwn(result, key, expressionValue(raw))
    else if (raw === null) {
      setOwn(result, key, '')
      warnings.push(`${serverName}.${field}.${key} 不是字符串，已转换为空字符串`)
    } else {
      setOwn(result, key, expressionValue(String(raw)))
      warnings.push(`${serverName}.${field}.${key} 不是字符串，已转换为字符串`)
    }
  }
  return result
}

function normalizeArgs(value, serverName, warnings) {
  if (value === undefined) return undefined
  if (Array.isArray(value)) {
    if (!value.every((item) => typeof item === 'string')) throw new Error(`${serverName}.args 必须全部是字符串`)
    return value.map(expressionValue)
  }
  if (typeof value === 'string') {
    warnings.push(`${serverName}.args 是字符串，已作为一个完整参数保留；DSH 不会按 shell 规则拆分`)
    return [value]
  }
  throw new Error(`${serverName}.args 必须是字符串数组`)
}

function warnUnsupported(raw, serverName, warnings) {
  const fatal = ['envFile', 'oauth', 'headersHelper']
  for (const field of fatal) if (hasOwn(raw, field)) throw new Error(`${serverName}.${field} 在 DSH MCP 配置中不支持，无法安全转换`)
  const clientOnly = ['alwaysAllow', 'autoApprove', 'disabledTools', 'sandbox', 'sandboxEnabled', 'dev']
  for (const field of clientOnly) if (hasOwn(raw, field)) warnings.push(`${serverName}.${field} 是其他客户端字段，DSH 不会保存或执行`)
  if (hasOwn(raw, 'directTools')) {
    if (hasOwn(raw, 'disabled')) warnings.push(`${serverName}.directTools 已忽略；显式 disabled 优先`)
    else if (raw.directTools === true) warnings.push(`${serverName}.directTools: true 已转换为 disabled: false（DSH 始终直接注册 MCP 工具）`)
    else if (raw.directTools === false) warnings.push(`${serverName}.directTools: false 已转换为 disabled: true（DSH 不支持间接工具模式）`)
    else warnings.push(`${serverName}.directTools 不是布尔值，已忽略`)
  }
  if (hasOwn(raw, 'timeout') && !hasOwn(raw, 'toolCallTimeoutMs')) warnings.push(`${serverName}.timeout 的单位因客户端而异，未自动转换；如需设置请使用 toolCallTimeoutMs`)
  // known 集合从两份字段常量**派生**（managed + 插件自有），不手抄：曾经这里把 10 个
  // managed 字段连字符串一个个列出来，与 MANAGED_CONFIG_FIELDS 是两份真相源——常量加了
  // 字段而这里忘了跟，用户导入时就会平白多一条"不是 DSH MCP 字段，已忽略"的假警告。
  const known = new Set([
    'serverName', 'name', 'type', 'serverUrl', 'server_url',
    'idleTimeoutMs', 'readyTimeoutMs', 'disabled', 'timeout', 'directTools', 'defer',
    ...MANAGED_CONFIG_FIELDS, ...fatal, ...clientOnly,
  ])
  for (const field of Object.keys(raw)) if (!known.has(field)) warnings.push(`${serverName}.${field} 不是 DSH MCP 字段，已忽略`)
}

function normalizeEntry(name, input, warnings) {
  if (!isObject(input)) throw new Error(`${name} 必须是对象`)
  const raw = isObject(input.transport) ? { ...input, ...input.transport } : input
  const serverName = String(raw.serverName || raw.name || name).trim()
  if (!SERVER_NAME_PATTERN.test(serverName)) throw new Error(`${serverName || name} 不符合 DSH serverName 格式：[A-Za-z0-9_-]{1,32}`)
  warnUnsupported(raw, serverName, warnings)
  const hasCommand = typeof raw.command === 'string' && raw.command.trim() !== ''
  const url = raw.url ?? raw.serverUrl ?? raw.server_url
  const hasUrl = typeof url === 'string' && url.trim() !== ''
  if (hasCommand && hasUrl) throw new Error(`${serverName} 同时包含 command 和 url，无法判断传输方式`)
  let transport = raw.type ?? (typeof raw.transport === 'string' ? raw.transport : undefined)
  if (!transport) transport = hasCommand ? 'stdio' : hasUrl ? 'streamable-http' : undefined
  const aliases = { http: 'streamable-http', streamableHttp: 'streamable-http', 'streamable-http': 'streamable-http', stdio: 'stdio', sse: 'sse', ws: 'ws', websocket: 'ws' }
  transport = aliases[transport] || transport
  if (transport === 'sse' || transport === 'ws') throw new Error(`${serverName} 的传输 ${transport} 不受当前 DSH MCP 配置支持；请先转换成 Streamable HTTP`)
  if (transport !== 'stdio' && transport !== 'streamable-http') throw new Error(`${serverName} 缺少可识别的 stdio 或 HTTP 传输类型`)

  const result = { name: serverName, transport }
  if (transport === 'stdio') {
    if (!hasCommand) throw new Error(`${serverName} 的 stdio 配置缺少 command`)
    result.command = expressionValue(raw.command.trim())
    const args = normalizeArgs(raw.args, serverName, warnings)
    if (args?.length) result.args = args
    const env = normalizeMap(raw.env, 'env', warnings, serverName)
    if (env && Object.keys(env).length) result.env = env
    if (raw.cwd !== undefined) {
      if (typeof raw.cwd !== 'string') throw new Error(`${serverName}.cwd 必须是字符串`)
      if (raw.cwd) result.cwd = expressionValue(raw.cwd)
    }
  } else {
    const normalizedUrl = hasUrl ? expressionValue(url.trim()) : ''
    if (!hasUrl) throw new Error(`${serverName} 的 HTTP 配置需要 http(s):// URL`)
    if (!normalizedUrl.startsWith('!!js ')) {
      let parsedUrl
      try {
        parsedUrl = new URL(normalizedUrl)
      } catch {
        throw new Error(`${serverName} 的 HTTP 配置需要有效的 http(s):// URL`)
      }
      if (!['http:', 'https:'].includes(parsedUrl.protocol) || !parsedUrl.hostname) throw new Error(`${serverName} 的 HTTP 配置需要有效的 http(s):// URL`)
    }
    result.url = normalizedUrl
    const headers = normalizeMap(raw.headers, 'headers', warnings, serverName)
    if (headers && Object.keys(headers).length) result.headers = headers
  }
  if (raw.toolCallTimeoutMs !== undefined) {
    if (!Number.isSafeInteger(raw.toolCallTimeoutMs) || raw.toolCallTimeoutMs < 1) throw new Error(`${serverName}.toolCallTimeoutMs 必须是正整数`)
    result.toolCallTimeoutMs = raw.toolCallTimeoutMs
  }
  if (raw.failOnStartupError !== undefined) {
    if (typeof raw.failOnStartupError !== 'boolean') throw new Error(`${serverName}.failOnStartupError 必须是布尔值`)
    result.failOnStartupError = raw.failOnStartupError
  }
  // `defer` used to be how a config said "these tools are on-demand". Tier now
  // lives in this plugin's registry, so storing an imported `defer` would give
  // one decision two owners — the exact conflict this plugin consolidates. Say
  // so instead of dropping it silently: the operator importing a config that
  // uses `defer` deserves to know where that setting went.
  if (raw.defer !== undefined) {
    warnings.push(`${serverName}.defer 已改由插件的 tier 表达，导入时不再保存；导入后请在能力面板把该服务器设为 on-demand`)
  }
  if (raw.reconnect !== undefined) {
    if (!isObject(raw.reconnect)) throw new Error(`${serverName}.reconnect 必须是对象`)
    const reconnect = {}
    const reconnectFields = ['enabled', 'initialDelayMs', 'maxDelayMs', 'maxAttempts']
    for (const key of reconnectFields) if (raw.reconnect[key] !== undefined) reconnect[key] = raw.reconnect[key]
    for (const key of Object.keys(raw.reconnect)) if (!reconnectFields.includes(key)) warnings.push(`${serverName}.reconnect.${key} 不是 DSH MCP 字段，已忽略`)
    for (const key of ['initialDelayMs', 'maxDelayMs']) {
      if (reconnect[key] !== undefined && (!Number.isFinite(reconnect[key]) || reconnect[key] <= 0)) throw new Error(`${serverName}.reconnect.${key} 必须是正数`)
      if (reconnect[key] !== undefined && reconnect[key] > MAX_TIMER_DELAY_MS) throw new Error(`${serverName}.reconnect.${key} 不能大于 ${MAX_TIMER_DELAY_MS}`)
    }
    if (reconnect.maxAttempts !== undefined && (!Number.isSafeInteger(reconnect.maxAttempts) || reconnect.maxAttempts < 1)) {
      throw new Error(`${serverName}.reconnect.maxAttempts 必须是正整数`)
    }
    if (reconnect.initialDelayMs !== undefined && reconnect.maxDelayMs !== undefined && reconnect.initialDelayMs > reconnect.maxDelayMs) {
      throw new Error(`${serverName}.reconnect.initialDelayMs 不能大于 maxDelayMs`)
    }
    if (reconnect.enabled !== undefined && typeof reconnect.enabled !== 'boolean') throw new Error(`${serverName}.reconnect.enabled 必须是布尔值`)
    result.reconnect = reconnect
  }
  if (raw.disabled !== undefined) {
    if (typeof raw.disabled !== 'boolean') throw new Error(`${serverName}.disabled 必须是布尔值`)
    result.disabled = raw.disabled
  } else if (raw.directTools === true) result.disabled = false
  else if (raw.directTools === false) result.disabled = true
  // 项目级连接的**空闲回收**策略（插件自己的字段，不下发给 mcp-client）：会话全部结束不等于
  // 「不再需要」，所以默认保留 5 分钟再回收；0 表示永不自动回收，显式拆除只能来自配置删除/改动、
  // 面板重建或插件卸载。它按 server 生效，属于项目配置面，因此**不**进 MANAGED_CONFIG_FIELDS
  // （那条清单是全局 profile patch 的投影面，写进去等于把它泄漏成全局字段）。
  if (raw.idleTimeoutMs !== undefined) {
    if (!Number.isSafeInteger(raw.idleTimeoutMs) || raw.idleTimeoutMs < 0) throw new Error(`${serverName}.idleTimeoutMs 必须是非负整数（0 = 不回收）`)
    if (raw.idleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`${serverName}.idleTimeoutMs 不能大于 ${MAX_TIMER_DELAY_MS}`)
    result.idleTimeoutMs = raw.idleTimeoutMs
  }
  // 挂载时等待这条连接就绪的**总预算**（毫秒，0 = 不等）。目的只有一个：让「首轮请求里就有工具」
  // 成为确定性结果，而不是一场竞态（mcp-client README 的第一条契约就是 tools appear before the
  // first turn）。超时不算失败：会话照常创建，面板按 fiber 状态如实显示「连接中/连接失败」。
  if (raw.readyTimeoutMs !== undefined) {
    if (!Number.isSafeInteger(raw.readyTimeoutMs) || raw.readyTimeoutMs < 0) throw new Error(`${serverName}.readyTimeoutMs 必须是非负整数（0 = 不等就绪）`)
    if (raw.readyTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`${serverName}.readyTimeoutMs 不能大于 ${MAX_TIMER_DELAY_MS}`)
    result.readyTimeoutMs = raw.readyTimeoutMs
  }
  return result
}

export function normalizeMcpImport(input) {
  if (!isObject(input)) throw new Error('JSON 根节点必须是对象')
  if (Array.isArray(input.inputs) && input.inputs.length) throw new Error('VS Code inputs 需要交互式取值，DSH 当前不支持安全转换')
  if (hasOwn(input, 'mcpServers') && hasOwn(input, 'servers')) throw new Error('JSON 同时包含 mcpServers 和 servers，无法确定应导入哪一组')
  let source = input.mcpServers ?? input.servers
  if (source === undefined && (input.command || input.url || input.serverUrl)) source = { [input.name || input.serverName || 'mcp-server']: input }
  if (!isObject(source)) throw new Error('JSON 中没有找到 mcpServers 或 servers 对象')
  const warnings = []
  const servers = Object.entries(source).map(([name, value]) => normalizeEntry(name, value, warnings))
  return { servers, warnings }
}

/**
 * 归一化之后同名的 serverName（`" a"` 与 `"a"` 会撞成同一个 `a`）。这里只做**检测**，
 * 处理策略留给边界，因为只有边界知道赌注是什么：
 * - 读一份配置文件（`.dsh/mcp.json`）→ 整份拒绝：文件自相矛盾，静默少一条更糟；
 * - 导入一批来源 / 粘贴 → 跳过重复项并逐条提示：不能让一条重名把其余条目挡在门外。
 */
export function duplicateServerNames(servers) {
  const seen = new Set()
  const duplicates = []
  for (const server of servers) {
    if (seen.has(server.name) && !duplicates.includes(server.name)) duplicates.push(server.name)
    seen.add(server.name)
  }
  return duplicates
}
