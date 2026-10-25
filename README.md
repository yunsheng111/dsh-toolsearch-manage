# dsh-toolsearch-manage

**工具检索与管理 (ToolSearch & Management)** —— DSH 宿主插件，是**工具可见性的唯一所有者**。

> **当前版本** `0.2.4` · 安装锁定 tag `v0.2.4`
> 未发布到 npm，从 GitHub 安装；命令见 [安装](#安装)。

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

本包**未发布到 npm**，从 GitHub 安装。

### 给别人 / 新机器

```bash
cd ~/.dsh/profiles/<your-profile>          # 例如 desktop 或 web
pnpm add "github:yunsheng111/dsh-toolsearch-manage#v0.2.4"
```

**装 tag，不要跟 `main`**：`main` 是移动目标，tag 才指向验证过的那份代码。`pnpm-lock.yaml` 会记下解析到的 commit，同一份 lockfile 在任何机器上装出同一份代码。

安装后**必须重启 DSH**（Desktop 要真正退出进程，关窗口可能只是隐藏）。插件是宿主侧代码，重启才会加载新副本。

### 本机开发

```bash
cd ~/.dsh/profiles/desktop && pnpm add "link:D:/dsh-plugin"
```

`link:` 让源码改动在重启后立刻生效，适合迭代。**但 `link:` 不能用来分发**，别人拿不到这个路径。

### 通过插件管理器

`plugin_manager` 的 `install_bundle`，`target` 传 `github:yunsheng111/dsh-toolsearch-manage` 或本地目录绝对路径。这是 Desktop 面板「插件」页背后的同一个入口。

### 更新

```bash
pnpm add "github:yunsheng111/dsh-toolsearch-manage#<new-commit>"
```

然后重启。

### 一键升级脚本（Windows）

`scripts/update-to-tag.cmd` 把上面的「锁定 tag 安装」和随后的校验打包成一步，**双击即可**：

```
scripts\update-to-tag.cmd
scripts\update-to-tag.cmd -Tag v0.2.4 -Profile desktop
```

它会先确认 DSH 已完全退出（否则 `pnpm` 会因文件被占用报 `[EPERM]`），备份 `package.json` / `pnpm-lock.yaml` / `cordis.patch.yml`，安装指定 tag，再校验四项：依赖声明、锁定 commit、许可证署名行、`NOTICE`。全过程写入 `~/.dsh/logs/toolsearch-manage-update-<时间戳>.log`。

> `-Profile` 省略时自动检测：`DSH_PROFILE` → 唯一的 profile 目录；有多个时必须指定。
> 直接双击 `.ps1` 不行（Windows 默认用记事本打开，且执行策略会拦截），所以要经 `.cmd` 启动。
> **不要从 DSH 的终端面板里运行**，那时 DSH 必然在运行，脚本会拒绝执行并说明原因。

### 安装后确认

装好并重启后应看到：

- 左侧栏出现放大镜图标（可在「设置 → 工具检索 → 显示位置」关掉）
- 设置里有「工具检索」页，五个页签：能力 / 市场 / 导入 / 技能 / 设置
- 工具表里出现 `tool_search`、`mcp_register`、`mcp_load`、`mcp_call`

### 卸载

```bash
cd ~/.dsh/profiles/<your-profile>
pnpm remove dsh-toolsearch-manage
```

卸载前建议先跑 `/mcp prepare-uninstall`，把托管块里的 MCP 行交还给原生 `@deepseek-ai/dsh-mcp-client`，否则那些服务器会跟着插件一起消失。


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

本包以 MIT 发布（见 `LICENSE`）。

它包含三个上游项目的衍生代码。三者的许可证**都允许**修改、再分发与商用，条件是保留署名——所以本包可以按 MIT 发布，但下列义务必须履行：

| 上游 | 许可证 | 版权人 | 许可证全文 |
|---|---|---|---|
| `dsh-skill-mcp-manager@1.2.2` | MIT | alone-tree | `LICENSE` |
| `dsh-toolbox-ui@1.8.2` | MIT | dsh-toolbox-ui contributors | `LICENSE-MIT-TOOLBOX-UI` |
| `@daweifu/capability-menu@0.1.6` | Apache-2.0 | Dawei Fu | `LICENSE-APACHE-CAPABILITY-MENU` |

**`NOTICE` 列出了每个上游被搬运的模块与被修改的内容**——那是这套许可证义务的正式载体，改代码前请先读它。两个 MIT 上游要求版权声明随「软件的实质部分」一起传播；Apache-2.0 第 4(b) 条要求标记被修改的文件、第 4(d) 条要求传播 NOTICE。

代码层面的落实：**19 个衍生文件的头部都有来源标注**（`// Ported from … (LICENSE). Modified for this plugin; see NOTICE.`）。这条注释是许可证要求，不是普通注释——搬运或大改这些文件时不要删掉它，否则下一次同步上游就分不清哪些是原样代码、哪些是本仓的改动，署名义务也会断掉。

### 你需要知道的边界

- **MIT 与 Apache-2.0 都是宽松许可**，不要求你开源自己的修改，也不要求同许可证。你可以在本包之上闭源分发或商用。
- **Apache-2.0 部分不是 copyleft**（不是 GPL）。它只要求署名、保留许可证与 NOTICE、标记修改，不要求公开源码。
- 上述是依据许可证原文的核对，**不构成法律意见**。商用或大规模分发前请自行确认。

