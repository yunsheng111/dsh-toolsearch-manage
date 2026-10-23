# dsh-toolsearch-manage

**工具检索与管理 (ToolSearch & Management)** —— DSH 宿主插件，是**工具可见性的唯一所有者**。

它把原本散在三个插件里、且互相抢写同一份 `cordis.patch.yml` 的能力收成一个包：

- **档位**：MCP 工具、内置工具（`bash` / `read` / `web_fetch` …）、本插件自己的管理工具，统一分 `eager` / `on-demand` / `disabled` 三档。
- **连接**：MCP 服务器按 DSH 会话隔离，子代理与双会话并发不打架。
- **patch**：profile `cordis.patch.yml` 里的 MCP 行只有这一个写者，托管块由注册表整体重生成。
- **检索**：`tool_search` 返回延迟工具的完整 schema 并使其立即可直接调用；提示词里带一份延迟目录。

---

## 为什么不用三个包

`dsh-skill-mcp-manager`、`@daweifu/capability-menu`、`dsh-toolbox-ui` 都会改写**同一批** `@deepseek-ai/dsh-mcp-client` 行，各有各的写函数，且无锁。实测单方改写不会破坏 YAML（`yaml@2.9.1` 对真实文件 byte-identical 往返），**问题在语义**：后写的覆盖先写的，A 加的服务器、B 重写托管块时看不见、C 删了 A 刚加的行。

把三个写者收成一个，是集成最硬的技术理由。

## 三个档位

| 档位 | 工具表 | 模型怎么调用 |
|---|---|---|
| `eager` | 可见（含完整 schema） | 直接调 |
| `on-demand` | **隐藏** | `tool_search` 取回 schema（取回即可直调），或 `mcp_load` 拿定义后用 `mcp_call` |
| `disabled` | 隐藏 | 拒绝，且**不给找回指引** |

`disabled` 压过一切规则，包括显式的 `eager`；精确名压过通配（面板上点一条不会被宽泛规则反盖）；本插件自己的四个管理工具恒 `eager`。

## 模型可见的两条路径

```
eager 工具 ────────────────────────────────► 工具表（全量 schema）
on-demand 工具 ──► tool_search ──► schema + 立即变可调用
                    （命中即建连）
提示词里另有一段 <capability_catalog>：只有名字与用途，没有 schema。
```

`tool_search` 支持三种查询：`select:<name>[,<name>]` 精确取、`+<server> <words>` 限定服务器、纯关键词 BM25（名字 + 描述 + 参数名，中文按二元组切分）。

## 安装

```bash
# 本机开发（改源码后重启 DSH 即生效）
cd ~/.dsh/profiles/desktop && pnpm add "link:D:/dsh-plugin"
```

正式形态用 `plugin_manager` 的 `install_bundle`，`target` 指向本目录的绝对路径。

装完在 **设置 → 工具检索** 里看到五个页签：能力 / 市场 / 导入 / 技能 / 设置。

## 配置（profile 的 `cordis.patch.yml`）

```yaml
- id: toolsearch-manage
  name: dsh-toolsearch-manage
  config:
    catalogGranularity: server   # server | tool
    toolDescriptionMaxLength: 80
    importNativeMcp: true
    trimPtcManual: true
    maxResults: 10
    maxDiscovered: 20
    rules:
      disabled: ['web_fetch']
      on-demand: ['server:chrome-devtools:*']
```

| 键 | 默认 | 说明 |
|---|---|---|
| `catalogGranularity` | `server` | `server` 每台 MCP 服务器一行（本机 63 工具下约 401 字符）；`tool` 每个工具一行（约 6,926 字符） |
| `toolDescriptionMaxLength` | 80 | 仅 `tool` 粒度使用的描述上限 |
| `catalogDescriptionMaxLength` | 300 | 服务器级描述上限 |
| `importNativeMcp` | `true` | 是否吸收 patch 里已有的 MCP 行 |
| `searchToolName` | `tool_search` | 备选 `deferred_tool_search` / `mcp_tool_search`（名字被占时自动改用） |
| `maxResults` | 10 | 单次检索返回上限。10 而不是 5：实测 top5 漏掉 serena 33% 的核心工具，top10 补齐 |
| `maxDiscovered` | 20 | 已发现集上限。它约束的是"模型当前面对多少可选工具"，常驻 10–15 + 20 ≈ 32 正落在准确率退化带下沿 |
| `stem` | `true` | s 词干化（只归单复数；Porter 会过度归并，实测名次更差） |
| `trimPtcManual` | `true` | PTC 下裁 `tools:sdk` 手册，避免"延迟加载反而更贵" |
| `rules` | 空 | 给没有条目的工具用；语法 `server:<name>` / `server:<name>:*` / 通配 / 精确名 |

面板改的档位存在 `~/.dsh/toolsearch-manage/registry.json`（MCP）与 `settings.json`（内置工具），**不会被配置里的 `rules` 覆盖** —— 一次点击被一条规则悄悄推翻，和面板坏了没有区别。

## 数据文件

| 路径 | 内容 |
|---|---|
| `~/.dsh/toolsearch-manage/registry.json` | MCP 注册表（`version: 2`，每条形如 `{ kind: 'mcp', name, tier, … }`） |
| `~/.dsh/toolsearch-manage/settings.json` | 面板设置与内置工具档位 |
| `~/.dsh/toolsearch-manage/trash.log` | 删除技能的审计记录 |
| `~/.dsh/profiles/<profile>/cordis.patch.yml` | 托管块（`Managed MCP servers (dsh-toolsearch-manage, …)`），写前留 `.bak-<ts>`，只留最近 5 份 |

## 从旧插件迁移

- **注册表**：`dsh-skill-mcp-manager` 的 `~/.dsh/skill-mcp-manager/registry.json` 是 v1（无 `kind`），本插件读到即就地升成 v2，缺 `kind` 的条目一律当 `mcp`。**没有自动搬目录**：两个包的数据目录不同，需要时把旧目录内容拷到 `~/.dsh/toolsearch-manage/`。
- **patch 托管块**：旧块的标记串不同（写的是 `dsh-skill-mcp-manager`），本插件不认。切过来时先跑一次 `/mcp prepare-uninstall`（旧插件把条目交还原生），再装本插件让它重新接管；或者手工把旧块删掉。
- **`defer` 字段**：不再是 patch 字段。导入时遇到只给提示、不保存；导入后到面板把该服务器设成 `on-demand`。

## 设计约束（改代码前读 `AGENTS.md`）

几条最容易踩的：

- `inject` **只声明 `tools`**。Cordis 的 `inject` 是依赖声明，缺失服务时 fiber 静默不激活、不报错 —— 把 `skills` 放进去会让禁用了 `dsh-skill` 的 profile 连 MCP 面一起消失。
- 遮罩做在 `system-prompt/assemble`（deny-list），执行拒绝做在 `tools.guard`。不用 `tools.restrict`：它对 scope-local 工具抛错，且每次改档位都要重注册。
- 目录段的 `interpolate: false` 不可省。段里是 MCP 服务器的自述文本，一个 `{{…}}` 就让每一轮组装抛错。
- PTC 下遮罩对 `tools:sdk` 是 no-op，必须裁；裁剪前先自检 `render(全集) === 宿主原文`，不过就放弃（最坏 = 不裁）。

## 许可

MIT（见 `LICENSE`）。搬自上游的部分：

- 基座 `dsh-skill-mcp-manager@1.2.2`（MIT）
- `dsh-toolbox-ui@1.8.2`（MIT，见 `LICENSE-MIT-TOOLBOX-UI`）
- `@daweifu/capability-menu@0.1.6`（Apache-2.0，见 `LICENSE-APACHE-CAPABILITY-MENU`）

每个搬来的函数上方都有来源说明。
