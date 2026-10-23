# AGENTS — dsh-toolsearch-manage

面向未来 AI / 人类开发者。改代码前先读这份文件。

## 项目是什么

**工具检索与管理 (ToolSearch & Management)** —— DSH 宿主级插件，是**工具可见性的唯一所有者**。它把原本散在三个插件里、且互相抢写同一份 `cordis.patch.yml` 的能力收成一个包。

四条职责：

| 职责 | 说明 |
|---|---|
| **档位** | 每个工具（MCP 工具、内置工具、本插件自己的管理工具）分三档：`eager`（工具表可见、可直接调用）/ `on-demand`（工具表隐藏、检索后可直接调用）/ `disabled`（隐藏且拒绝调用） |
| **连接** | MCP 服务器**按会话隔离**，不共享。有状态服务器不会串台 |
| **patch** | 本插件是 profile `cordis.patch.yml` 里 MCP 行的**唯一写者**，托管块由注册表整体重生成 |
| **检索** | `tool_search` 返回延迟工具的完整 schema 并使其可直接调用；提示词里带一份延迟目录 |

## 为什么要一个包

三个插件（`dsh-skill-mcp-manager` / `@daweifu/capability-menu` / `dsh-toolbox-ui`）都会改写**同一批** `@deepseek-ai/dsh-mcp-client` 行，各有各的写函数，且无锁。实测单方改写不会破坏格式（`yaml@2.9.1` 对真实文件是 byte-identical 往返），**问题在语义**：后写的覆盖先写的，谁也不知道另外两家改了什么。

## 目录结构

```
lib/index.js          宿主主模块：apply、三件套工具、检索工具、assemble 投影、guard、UI handlers
lib/policy.js         档位纯函数层：规则解析、classify 七步优先级、guard 文案、projectTools
lib/catalog.js        目录渲染：两级粒度、interpolate:false、双槽文本缓存
lib/search.js         检索引擎：tokenize（CJK 二元组）、s 词干化、BM25、select:/+server 语法
lib/discovery.js      发现集：LRU + 有界投影 fold（native 与 PTC 两条路径）
lib/ptc.js            PTC 适配：裁 tools:sdk 手册（前提自检，失败即放弃）
lib/store.js          registry.json / settings.json、v1→v2 迁移、profile 检测、备份轮转
lib/patch.js          patch 单写者：托管块生成、原生行吸收、托管块外行移除
lib/mcp-connection.js 传输与连接：ResilientStdioTransport、每会话实例、加载锁
lib/mcp-result.js     MCP 结果投影：与宿主 dsh-mcp-client 同一套正文与图片准入
lib/mcp-import.js     导入归一化：其他客户端配置 → 本插件 spec；市场目录投影
lib/mcp-import-sources.js 11 种客户端的固定路径与格式转换
lib/mcp-catalog.js    47 条 MCP 市场纯数据（由 toolbox-ui 的生成器产物搬来）
lib/skill.js          递归 skill provider + frontmatter 启停
lib/session-audit.js  历史会话审核（只读，一次性）
lib/stdio-transport.js stdio 传输（超限响应合成为 JSON-RPC 错误而不断连）
lib/child-env.js      本地工具环境：密钥与 DSH_ 不继承，$NAME 整段展开
lib/ui.js             HTTP 路由 + /skills /mcp 命令 + 跨平台 open/trash + 密钥打码
client/client.js      浏览器端（__ModuleLoader__.load 单文件 bundle，纯 JS React）
test/*.test.mjs       单元 + 生命周期测试（node --test）
```

## 架构

### Host ↔ Client

- 打包插件：Host 走 `lib/index.js`，Client 走 `dsh.client` 声明的 `client/client.js`（`__ModuleLoader__.load({id, factory})`，只 `require("react")`）。
- **RPC = 同源 HTTP 路由**：Host 用 `ctx.webServer.register({kind:"exact", path, handler})`，Client 用 `fetch("/toolsearch-manage/...")`。
  - `webServer` 是**惰性服务**：必须 `ctx.inject(["webServer"], …)` 等待，同步 `ctx.get("webServer")` 会拿到 `undefined` → 路由不注册 → 浏览器拿到 SPA fallback 而非 JSON。
  - `webServer.register` 对重复 `(kind, path)` 抛错：**GET 和 POST 不能各注册一条同 path 路由**，合并成一条、handler 内按 `request.method` 分发（见 `/settings`）。
- 路由的准入规则（`browserGuard`）：**`Host` 每次请求都校验**（localhost / 本机名 / IP 字面量恒允许，局域网主机名走设置里的允许名单）；**带 `Origin` 时必须同源**；**不带 `Origin` 的写入放行**。
  - 最后这条是修过的缺陷：原先「POST 无 `Origin` 就拒绝」把真实 GUI 挡在门外——桌面端自己的 POST 不带 `Origin`，于是每次设置写入都失败，报错却提示「刷新页面」。
  - 现在这样判断安全：跨站 `fetch`/表单 POST 按规范**必须**带 `Origin`，所以「无 `Origin`」不是 CSRF 场景；而 `Host` 是浏览器无法伪造成任意值的头，仍是 rebinding 的主防线。
  - 拒绝分三种原因（`origin-mismatch` / `host-not-allowed` / `write-required`），各给可操作文案，且**不回传**端口与允许名单内容。


### 数据

- `~/.dsh/toolsearch-manage/registry.json` —— 权威注册表 `{ version: 2, entries: [{ kind, … }] }`。
- `~/.dsh/toolsearch-manage/settings.json` —— 插件设置（`builtinTiers`、`toolDescriptionMaxLength`、`catalogGranularity`、`localCommandApproval`、`lanHostAllowlist`、`stdioMaxBufferSizeMb`）。
- `~/.dsh/profiles/<profile>/cordis.patch.yml` —— 被 reconcile 的 patch：全部 MCP 行收敛进托管块，由注册表整体重生成，每条目一行 `disabled: true`。

### 每次启动顺序（apply → startup）

1. `loadRegistry` —— v1 文件就地迁移成 v2（缺 `kind` 的条目一律 `mcp`）。
2. 读 settings.json。
3. `syncBuiltins()` —— 从 `ctx.tools.schemas()` 同步内置工具名与档位（只增删名字，从不覆盖用户档位）。
4. `reconcile()` —— 吸收 + 托管块重生成 + 块外被认领行移除。
5. `warmSnapshots()` —— 无快照的条目一次性试连抓工具表与服务器元信息，不留下运行实例。
6. eager 实例在各会话首次 `assemble` 时于该会话 `agent.ctx` 上启动。

## 关键设计决策（改动前务必遵守）

- **profile 检测是分级+落盘校验的**（`lib/store.js` `resolveProfile`）。它决定本插件拥有哪个 `cordis.patch.yml`，错了的后果是**改写别的 profile**、自己的一个都不导入、还在别人那儿留一块托管标记。`dsh-skill-mcp-manager@1.2.2` 就错在这：桌面端的 profile 是 argv 的**位置参数**（`… dsh-desktop-host/lib/index.js <install> <profileDir> …`），它只读 `--profile`，于是回退到 `web`。现在的顺序是：显式 config → argv 里的 `<home>/profiles/<name>` → `DSH_PROFILE` → `--profile` → `DSH_PROFILE_DIR` → **唯一的 profile 目录** → `web`，且 2–5 的候选必须在磁盘上真实存在。另有 `releaseForeignPatchBlocks()` 在每次启动时清掉自己错写进别的 profile 的托管块，使检测错误可自愈而不是永久化。

- **检索工具名是运行期值，不能硬编码进文案**。本机上 `dsh-toolbox-ui` 先注册了 `tool_search`，本插件于是注册成 `deferred_tool_search`；而目录与引导文案里写死了 `tool_search`，模型会被指向别人的工具。现在 `guidanceText(name)` 与 `renderCatalogText(rows, name)` 都收参数，`test/plugin.test.mjs` 有一条端到端用例钉住"文案里的名字 == 实际注册的名字"。

- **`inject` 只声明 `tools`**。Cordis 的 `inject` 是**依赖声明**：服务缺失时 fiber 只是保持未激活，**不报错**。宿主源码原文：`cannot get required service "…" in inactive context`。宿主内置的 `dsh-skill` 可被用户禁用，一旦把 `skills` 放进 `inject`，那些 profile 会连 MCP 面一起**静默消失**且日志里什么都没有。所以 `skills` / `webServer` / `systemPrompt` / `sessionProjections` 全部走 `ctx.inject` 或 `ctx.get`。

- **遮罩做在 `system-prompt/assemble`，执行拒绝做在 `tools.guard`**。理由（来自 toolbox-ui 的设计文档，已核对宿主源码）：`prepareExecution` 的 `guardReason` 跑在 `dispatchToolBody` 抛 `ToolNotFoundError` **之前**，所以被遮罩的工具同样能拿到带指引的拒绝；反过来若用 `tools.restrict`，scope-local 的工具会抛错，且每次改档位都要重注册（触发 `tools/change` 与前缀失效）。

- **遮罩是 deny-list，不是 allow-list**。一次 assembly 可能带着本插件从未索引的工具（别的插件的 provider、preset 作用域注册），allow-list 会把它们静默删掉。

- **`on-demand` 与 `disabled` 的文案必须不同**：`on-demand` 给出确切查询词（模型已经知道工具存在，只差 schema）；`disabled` 只拒绝、**不给指引**（教模型怎么找回被关掉的能力等于取消那个开关）。

- **检索即连接**：`tool_search` 命中某服务器时必须先建连再返回。`on-demand` 服务器没有注册工具，直接回 schema 会让模型去调一个不存在的工具。

- **发现集两份状态，刻意分开**：运行期状态按 Agent（`WeakMap`，带 LRU tick），投影状态按 Session（纯 JSON、有界，只当恢复种子）。混成一份会让投影跟着 LRU 抖动（宿主按引用变化触发下游工作），也会让运行期状态变成"一会话多 agent 共享"。

- **PTC 下 `tools:sdk` 必须裁**，否则遮罩是 no-op、倒贴字符。修法：装配时重渲染子集。**前提自检 `render(全集) === 宿主原文` 必须先过**，任何一步不成立就返回宿主原文（最坏 = 今天，不会更坏）。判据读 `ctx.tools.modeFor(scope)`，**`native` 与 `ptc` 都活着**，只有 `both` 是 inert —— 写成"非 native 就 inert"会把 PTC 整个关掉。

  用**宿主真实渲染器**实测（`test/ptc.test.mjs`，不是 mock）：63 个工具的全量手册 11,547 字符，裁掉 40 个后 5,367 字符，**净省 6,180** —— 这正是当初"装插件反而多花 3,181 字符"的正面反转。另有一条用例钉住"宿主文本已被别的插件改过 → premise-mismatch → 拒绝覆盖"：前提自检的真正用途是**防覆盖别人写的东西**，不只是防版本漂移。


- **`interpolate: false` 不可省**：目录段里是 MCP 服务器的自述文本，提示词渲染器默认会对 `{{name}}` 做插值，一个 `{{…}}` 就让每一轮组装抛错。

- **托管块外零残留**：`reconcile` 只重写 `MANAGED_MARKER`…`MANAGED_END_MARKER` 之间；块外被注册表认领的 MCP 行从原位置移除（空的 `- insert:` 块一并清理），未认领行与非 MCP 内容 byte-for-byte 保留。写前 `.bak-<ts>` 备份，只留最近 5 份。

- **重复 loader id 拒绝写盘**：`managedBlockYaml` 抛错、调用方只记日志、文件一个字节都不动。写进去的后果是**下一次启动**失败，且离这里很远。

- **`defer` 不再是 patch 字段**：档位由注册表表达。导入时遇到 `defer` 只产生一条提示、不保存；写 patch 时从 `rawConfig` 里剥掉。否则一个决定有两个所有者。

- **`rawConfig` 优先**：原生行带来的、本插件不建模的字段（`reconnect`、超时）在交还原生时原样保留，丢字段等于静默改变服务器行为。

- **本地程序审批**：登记/修改 stdio 命令前先问（`follow` 跟随会话权限、`always-ask`、`always-allow`）。没有 approval 服务的宿主上保持原来的静默允许，而不是把所有登记都挡死。

- **实测口径**：`catalogGranularity: 'server'` 在本机 63 工具下约 401 字符；`'tool'` 在描述截 80 字符下约 6,926 字符。默认 `server`。

## 编码约定

- **纯 JavaScript**：Host 与 Client 都不经过 TS/JSX/bundler。Client 用 `React.createElement`，**禁止 JSX / TypeScript / import / require**（唯一外部依赖是 `require("react")`）。
- 模块为 ESM（`type: module`）。
- 错误处理：handler 抛错 → 路由层统一 `400 {ok:false,error}`；拒绝/校验失败用 `throw`，不返回 200 的 `{ok:false}`。
- 注释写**为什么**，不写**是什么**。踩过的坑要带上后果（"否则 X 会静默变成 Y"），否则下一个人会把它"优化"掉。

## 开发 / 测试 / 安装

```bash
pnpm install                      # 依赖（含 devDependency @deepseek-ai/dsh-tools，仅测试用）
node --check lib/index.js         # 逐个模块做语法检查
node --test "test/*.test.mjs"     # 全部测试
```

- `test/policy.test.mjs` —— 纯决策层：规则优先级、guard 文案、目录渲染、检索排序、发现集 fold、patch 写入。不碰宿主。
- `test/ptc.test.mjs` —— M3 用**宿主真实渲染器**（`@deepseek-ai/dsh-tools` 的 `renderToolsSdk` / `renderToolsSdkPy`）验证前提自检与裁剪收益，不是 mock。
- `test/profile.test.mjs` —— profile 检测：桌面端位置参数、陈旧环境变量、唯一目录回退；用临时 home，不碰真实 profile。
- `test/plugin.test.mjs` —— 用假 Context + 假 webServer 走真实 `apply()`：依赖面、缺可选服务不阻塞挂载、guard 三种回答、assemble 投影、发现后回归、检索工具重命名后的文案一致性。`profile: '__test__'` + `importNativeMcp: false` 保证不碰真实 profile。

安装到当前 profile：

```bash
# 本机开发用 link:（改源码后重启 DSH 即生效）
cd ~/.dsh/profiles/desktop && pnpm add "link:D:/dsh-plugin"
```

或走 `plugin_manager` 的 `install_bundle`（正式形态，从工作区目录安装）。

## 常见坑

- **启动看门狗约 120 秒**：`apply()` 发生在启动早期，"await 慢操作"和"setTimeout 之后跑"**都落在这个窗口里**，超时即进安全模式。启动路径只做必要且快的事；任何重活挂到明确晚于 boot 的事件上（本插件的重扫描是第一个 UI 请求触发的）。
- **`file:` 依赖是拷贝**：改源码后重启 DSH 完全无效。开发期用 `link:`。
- **测试不能碰真实 profile**：`profile` 用 `"__test__"`、`importNativeMcp: false`，否则 reconcile 会读写真实 `cordis.patch.yml`。
- **bundle 自动挂载 + 用户补丁里的旧 insert 行 = 组合起不来**：包里自带的 `cordis.patch.yml` 会自动 insert 挂载行；从手写挂载升上来的 profile 若还留着同 id 的 insert 行，组合里出现两行同 id，重启失败。用户补丁里应改成同 id 的**纯配置覆盖行**。
- **`ctx.effect` 里的清理要能重复执行**：HMR 与 dispose 可能各跑一次，第二次不能抛。
- **本插件的 `client.js` 不能 require 宿主 Client 包**：`dsh.client.inject` 只排激活顺序，`@deepseek-ai/dsh-client-ui-primitives` 这类包会随时改，纯 JS 侧没有类型检查，一个抛错的组件会把整个 slot 条目打空。

## 上游来源与许可

- 基座（MCP 连接、三件套、patch 托管块、stdio 传输、MCP 结果投影、skill provider、session-audit）：`dsh-skill-mcp-manager@1.2.2`，MIT，见 `LICENSE`。
- 档位规则解析与 classify 优先级（`lib/policy.js` 的 `parseRule` / `compileGlob` / `classify`）、`interpolate: false` 与 `tools:sdk` 裁剪判据（`lib/ptc.js` / `lib/catalog.js`）、检索与发现集（`lib/search.js` / `lib/discovery.js`）、市场目录与跨客户端导入（`lib/mcp-catalog.js` / `lib/mcp-import*.js`）：`dsh-toolbox-ui@1.8.2`（MIT，见 `LICENSE-MIT-TOOLBOX-UI`）与 `@daweifu/capability-menu@0.1.6`（Apache-2.0，见 `LICENSE-APACHE-CAPABILITY-MENU`）。

**19 个衍生文件的头部都有一行来源标注**：

```js
// Ported from dsh-toolbox-ui (MIT). Modified for this plugin; see NOTICE.
```

这是**许可证要求的署名**，不是普通注释：

- 两个 MIT 上游要求版权声明随「软件的实质部分」传播；
- Apache-2.0 第 4(b) 条要求标记被修改的文件。

改这些文件时**保留那行标注**。删掉它的后果有两层：许可证义务断掉；以及下一次同步上游时分不清哪些是原样搬运、哪些是本仓的改动。

`NOTICE` 是这套义务的正式载体，逐项写明了每个上游被搬了哪些模块、被改了什么。**新增衍生代码或大幅改写既有衍生文件时，同步更新 `NOTICE` 的 Modified 部分。** `NOTICE` 已列入 `package.json` 的 `files`，所以它会随 npm 包一起发布，而不只是留在仓库里。

