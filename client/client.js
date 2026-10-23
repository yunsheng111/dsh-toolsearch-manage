window.__ModuleLoader__.load({ id: "dsh-toolsearch-manage", factory: (require) => {

  // Plain-JS client bundle (no JSX, no TypeScript, no bundler). Registers one
  // "工具检索" settings page with five tabs: capabilities, market, import,
  // skills, settings. Every request is same-origin HTTP against the routes
  // lib/ui.js mounts; there is no other Host API surface.
  //
  // Only React is required from the module table. Styles use the host theme
  // tokens (`--dsw-alias-*`) exclusively, so light/dark switching works without
  // this plugin knowing about it.

  const React = require("react");
  const h = React.createElement;
  const { useState, useEffect, useCallback } = React;

  const name = "dsh-toolsearch-manage";
  const inject = ["slots"];
  const API = "/toolsearch-manage";
  // The sidebar entry id. The host pairs a `sidebar.panellist` id with the
  // `main` panel of the same key, so both registrations must use this one value.
  const PANEL_ID = "toolsearch-manage";

  // ── fetch ────────────────────────────────────────────────────────────────
  async function getJson(path) {
    const res = await fetch(path, { cache: "no-store" });
    const data = await res.json().catch(() => ({ ok: false, error: "HTTP " + res.status }));
    if (!res.ok) throw rejError(res, data);
    return data;
  }

  async function postJson(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({ ok: false, error: "HTTP " + res.status }));
    if (!res.ok || data.ok === false) throw rejError(res, data);
    return data;
  }

  /**
   * Build an Error from a rejected response, keeping the machine-readable
   * `reason` when the Host supplies one.
   *
   * A 403 has several causes that need different actions, and the previous
   * message collapsed all of them into one phrase that read like a permissions
   * problem. The text is already actionable server-side; this keeps the code
   * attached so the UI can react to it.
   */
  function rejError(res, data) {
    const error = new Error(data && data.error ? data.error : "HTTP " + res.status);
    if (data && typeof data.reason === "string") error.reason = data.reason;
    return error;
  }

  const cx = (...parts) => parts.filter(Boolean).join(" ");
  const errText = (error) => String(error && error.message ? error.message : error);

  const TIERS = [
    { value: "eager", label: "常驻", hint: "工具表里可见，直接调用" },
    { value: "on-demand", label: "按需", hint: "工具表里隐藏，检索后可直接调用" },
    { value: "disabled", label: "禁用", hint: "隐藏且拒绝调用" },
  ];

  // ── primitives ───────────────────────────────────────────────────────────

  function Switch(props) {
    const checked = props.checked === true;
    return h("button", {
      type: "button",
      role: "switch",
      "aria-checked": checked ? "true" : "false",
      className: cx("tsm-switch", checked && "is-on"),
      disabled: props.disabled === true,
      onClick: () => props.onChange(!checked),
    }, h("span", { className: "tsm-switch__knob" }));
  }

  function Badge(props) {
    return h("span", { className: cx("tsm-badge", props.tone ? "tsm-badge--" + props.tone : "") }, props.children);
  }

  function Notice(props) {
    if (!props.children) return null;
    return h("div", { className: cx("tsm-notice", props.kind ? "tsm-notice--" + props.kind : ""), role: "status" },
      h("span", { className: "tsm-notice__text" }, props.children),
      props.onDismiss ? h("button", { type: "button", className: "tsm-notice__close", title: "关闭", onClick: props.onDismiss }, "\u00d7") : null,
    );
  }

  function Empty(props) {
    return h("div", { className: "tsm-empty" }, props.children);
  }

  // A three-way tier control. Radio semantics: exactly one of three, always.
  function TierPicker(props) {
    return h("div", { className: "tsm-tiers", role: "radiogroup", "aria-label": props.label ?? "档位" },
      TIERS.map((tier) => h("button", {
        key: tier.value,
        type: "button",
        role: "radio",
        "aria-checked": props.value === tier.value ? "true" : "false",
        title: tier.hint,
        disabled: props.disabled === true,
        className: cx("tsm-tier", props.value === tier.value && "is-active", "tsm-tier--" + tier.value),
        onClick: () => {
          if (props.value !== tier.value) props.onChange(tier.value);
        },
      }, tier.label)),
    );
  }

  function Tab(props) {
    return h("button", {
      type: "button",
      role: "tab",
      "aria-selected": props.active ? "true" : "false",
      className: cx("tsm-tab", props.active && "is-active"),
      onClick: props.onClick,
    }, props.label, props.count !== undefined ? h("span", { className: "tsm-tab__count" }, String(props.count)) : null);
  }

  function kv(key, value) {
    return h("div", { className: "tsm-kv", key },
      h("span", { className: "tsm-kv__k" }, key),
      h("span", { className: "tsm-kv__v" }, value === null || value === undefined || value === "" ? "\u2014" : String(value)),
    );
  }

  // ── capabilities ─────────────────────────────────────────────────────────

  function ToolRow(props) {
    const tool = props.tool;
    const [busy, setBusy] = useState(false);
    return h("li", { className: cx("tsm-tool", !tool.enabled && "is-disabled") },
      h("span", { className: cx("tsm-tool__tier", "is-" + tool.tier) }, tool.tier),
      h("span", { className: "tsm-tool__name" }, tool.publicName),
      h("span", { className: "tsm-tool__desc" }, tool.description),
      h("span", { className: "tsm-tool__action" },
        h(Switch, {
          checked: tool.enabled,
          disabled: busy,
          onChange: async (next) => {
            setBusy(true);
            try {
              await props.onToggle(tool.name, next);
            } finally {
              setBusy(false);
            }
          },
        }),
      ),
    );
  }

  function ServerRow(props) {
    const entry = props.entry;
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [output, setOutput] = useState("");
    const [confirming, setConfirming] = useState(false);

    const run = async (fn) => {
      setBusy(true);
      try {
        await fn();
      } catch (error) {
        setOutput(errText(error));
      } finally {
        setBusy(false);
      }
    };

    return h("li", { className: "tsm-row" },
      h("div", { className: "tsm-row__main" },
        h("div", { className: "tsm-row__top" },
          h("span", { className: "tsm-row__name" }, entry.name),
          h(Badge, { tone: entry.tier === "eager" ? "success" : entry.tier === "disabled" ? "muted" : "info" }, entry.tier),
          entry.connectFailed ? h(Badge, { tone: "error" }, "连接失败") : null,
          h("span", { className: "tsm-row__meta" }, entry.toolCount + " 个工具" + (entry.disabledToolCount ? " · " + entry.disabledToolCount + " 个已单独禁用" : "")),
          entry.transport ? h("span", { className: "tsm-row__meta" }, entry.transport) : null,
        ),
        entry.serverDescription ? h("div", { className: "tsm-row__desc" }, entry.serverDescription) : null,
        entry.websiteUrl ? h("div", { className: "tsm-row__meta" }, entry.websiteUrl) : null,
        h("div", { className: "tsm-row__actions" },
          h(TierPicker, {
            value: entry.tier,
            label: entry.name + " 的档位",
            disabled: busy,
            onChange: (tier) => run(() => props.onTier(entry.name, tier)),
          }),
          h("button", { type: "button", className: "tsm-btn tsm-btn--ghost", onClick: () => setOpen(!open) }, open ? "收起" : "详情"),
          h("button", {
            type: "button",
            className: "tsm-btn tsm-btn--ghost",
            disabled: busy,
            onClick: () => run(async () => {
              const data = await postJson(API + "/peek", { name: entry.name, peek: true });
              setOutput(data.text || "");
              setOpen(true);
            }),
          }, "查看定义"),
          h("button", {
            type: "button",
            className: "tsm-btn tsm-btn--ghost",
            disabled: busy,
            onClick: () => run(async () => {
              const data = await postJson(API + "/peek", { name: entry.name, peek: false });
              setOutput(data.text || "");
              setOpen(true);
              await props.onRefresh();
            }),
          }, "刷新快照"),
          confirming
            ? h("span", { className: "tsm-confirm" },
                h("span", { className: "tsm-row__meta" }, "确认删除？"),
                h("button", {
                  type: "button",
                  className: "tsm-btn tsm-btn--danger",
                  disabled: busy,
                  onClick: () => run(async () => {
                    await props.onDelete(entry.name);
                    setConfirming(false);
                  }),
                }, "删除"),
                h("button", { type: "button", className: "tsm-btn tsm-btn--ghost", onClick: () => setConfirming(false) }, "取消"),
              )
            : h("button", { type: "button", className: "tsm-btn tsm-btn--danger", onClick: () => setConfirming(true) }, "删除"),
        ),
        open
          ? h("div", { className: "tsm-detail" },
              kv("id", entry.id),
              entry.command ? kv("command", entry.command) : null,
              (entry.args || []).length ? kv("args", (entry.args || []).join(" ")) : null,
              entry.url ? kv("url", entry.url) : null,
              Object.keys(entry.env || {}).length ? kv("env", Object.keys(entry.env).join(", ")) : null,
              Object.keys(entry.headers || {}).length ? kv("headers", Object.keys(entry.headers).join(", ")) : null,
              kv("registeredAt", entry.registeredAt),
              kv("lastLoadAt", entry.lastLoadAt),
              (entry.tools || []).length
                ? h("ul", { className: "tsm-tools" },
                    entry.tools.map((tool) => h(ToolRow, {
                      key: tool.publicName,
                      tool,
                      onToggle: (toolName, enabled) => props.onToolToggle(entry.name, toolName, enabled),
                    })),
                  )
                : h("div", { className: "tsm-row__meta" }, "尚无工具快照：点「刷新快照」连接一次服务器。"),
              output ? h("pre", { className: "tsm-output" }, output) : null,
            )
          : null,
      ),
    );
  }

  function CapabilitiesPanel() {
    const [data, setData] = useState(null);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(async () => {
      setLoading(true);
      setError("");
      try {
        setData(await getJson(API + "/capabilities"));
      } catch (err) {
        setError(errText(err));
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => {
      refresh();
    }, [refresh]);

    const setTier = async (serverName, tier) => {
      setNotice("");
      try {
        await postJson(API + "/tier", { name: serverName, tier });
        await refresh();
        setNotice("已把 " + serverName + " 设为 " + tier);
      } catch (err) {
        setError(errText(err));
      }
    };

    const setBuiltinTier = async (toolName, tier) => {
      setNotice("");
      try {
        await postJson(API + "/builtin-tier", { name: toolName, tier });
        await refresh();
        setNotice("已把内置工具 " + toolName + " 设为 " + tier);
      } catch (err) {
        setError(errText(err));
      }
    };

    const setToolEnabled = async (serverName, toolName, enabled) => {
      setNotice("");
      try {
        await postJson(API + "/tool-enabled", { name: serverName, tool: toolName, enabled });
        await refresh();
      } catch (err) {
        setError(errText(err));
      }
    };

    const remove = async (serverName) => {
      setNotice("");
      try {
        await postJson(API + "/delete", { name: serverName });
        await refresh();
        setNotice("已删除 " + serverName);
      } catch (err) {
        setError(errText(err));
      }
    };

    if (loading && data === null) return h(Empty, null, "正在读取能力清单…");
    if (data === null) return h(Notice, { kind: "error" }, error);

    const entries = data.entries || [];
    const builtins = data.builtins || [];
    const nonEager = builtins.filter((tool) => tool.tier !== "eager");

    return h("div", { className: "tsm" },
      h(Notice, { kind: "error", onDismiss: () => setError("") }, error),
      h(Notice, { kind: "success", onDismiss: () => setNotice("") }, notice),
      h("div", { className: "tsm-head" },
        h("h3", { className: "tsm-title" }, "MCP 服务器"),
        h("div", { className: "tsm-head__meta" },
          h("span", { className: "tsm-count" }, entries.length + " 个"),
          h("button", { type: "button", className: "tsm-btn tsm-btn--ghost", onClick: refresh }, "刷新"),
        ),
      ),
      entries.length === 0
        ? h(Empty, null, "还没有登记 MCP 服务器。到「市场」装一个，或到「导入」从其他客户端带过来。")
        : h("ul", { className: "tsm-list" },
            entries.map((entry) => h(ServerRow, {
              key: entry.name,
              entry,
              onTier: setTier,
              onToolToggle: setToolEnabled,
              onDelete: remove,
              onRefresh: refresh,
            })),
          ),
      h("div", { className: "tsm-head" },
        h("h3", { className: "tsm-title" }, "内置工具"),
        h("span", { className: "tsm-count" }, builtins.length + " 个 · " + nonEager.length + " 个非常驻"),
      ),
      h("p", { className: "tsm-hint" },
        "宿主自带工具（bash、read、edit 等）也在这里分档。设为「禁用」会让它从工具表消失并拒绝调用；设为「按需」会隐藏它，模型仍可用检索工具找回。"),
      builtins.length === 0
        ? h(Empty, null, "没有读到内置工具。")
        : h("ul", { className: "tsm-tools tsm-tools--grid" },
            builtins.map((tool) => h("li", { key: tool.name, className: "tsm-builtin" },
              h("div", { className: "tsm-builtin__main" },
                h("span", { className: "tsm-tool__name" }, tool.name),
                h("span", { className: "tsm-tool__desc" }, tool.description),
              ),
              h(TierPicker, {
                value: tool.tier,
                disabled: (data.metaTools || []).includes(tool.name),
                label: tool.name + " 的档位",
                onChange: (tier) => setBuiltinTier(tool.name, tier),
              }),
            )),
          ),
      h("div", { className: "tsm-head" }, h("h3", { className: "tsm-title" }, "本插件自己的工具")),
      h("ul", { className: "tsm-tools" },
        (data.metaTools || []).map((toolName) => h("li", { key: toolName, className: "tsm-tool" },
          h("span", { className: "tsm-tool__tier is-eager" }, "eager"),
          h("span", { className: "tsm-tool__name" }, toolName),
          h("span", { className: "tsm-tool__desc" }, "管理工具，恒常驻（禁用它们等于关掉管理面）"),
        )),
      ),
    );
  }

  // ── market ───────────────────────────────────────────────────────────────

  function MarketPanel() {
    const [data, setData] = useState(null);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [category, setCategory] = useState("");
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState([]);
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(async () => {
      try {
        setData(await getJson(API + "/market"));
      } catch (err) {
        setError(errText(err));
      }
    }, []);

    useEffect(() => {
      refresh();
    }, [refresh]);

    if (data === null) return error ? h(Notice, { kind: "error" }, error) : h(Empty, null, "正在读取市场目录…");

    const labels = data.categoryLabels || {};
    const catalog = (data.catalog || []).filter((item) => {
      if (category && item.category !== category) return false;
      if (query === "") return true;
      const needle = query.toLowerCase();
      return [item.id, item.label, item.summary, item.vendor].some((field) => typeof field === "string" && field.toLowerCase().includes(needle));
    });

    const toggle = (id) => {
      setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
    };

    const install = async () => {
      setBusy(true);
      setNotice("");
      setError("");
      try {
        const result = await postJson(API + "/market/install", { ids: selected });
        await refresh();
        setSelected([]);
        setNotice(
          "已加入 " + result.added.length + " 个服务器" +
            (result.skipped.length ? "，跳过 " + result.skipped.length + " 个（已存在）" : "") +
            "。它们默认是「按需」档，可在「能力」页调整。",
        );
      } catch (err) {
        setError(errText(err));
      } finally {
        setBusy(false);
      }
    };

    return h("div", { className: "tsm" },
      h(Notice, { kind: "error", onDismiss: () => setError("") }, error),
      h(Notice, { kind: "success", onDismiss: () => setNotice("") }, notice),
      h("p", { className: "tsm-hint" },
        "目录条目全部可追到官方文档或官方仓库。免密服务装完即可用；需要密钥的条目装完要补环境变量。宿主不支持 OAuth 交互授权，因此只支持 OAuth 的远端服务不在目录里。"),
      h("div", { className: "tsm-filters" },
        h("input", {
          className: "tsm-input tsm-input--wide",
          placeholder: "搜索目录（名字、用途、提供方）",
          value: query,
          onChange: (event) => setQuery(event.target.value),
        }),
        h("select", {
          className: "tsm-select",
          value: category,
          onChange: (event) => setCategory(event.target.value),
        },
          h("option", { value: "" }, "全部类别"),
          (data.categories || []).map((id) => h("option", { key: id, value: id }, labels[id] || id)),
        ),
        h("button", { type: "button", className: "tsm-btn", disabled: busy || selected.length === 0, onClick: install },
          selected.length === 0 ? "选择要装的服务" : "安装 " + selected.length + " 个"),
      ),
      catalog.length === 0
        ? h(Empty, null, "没有匹配的目录条目。")
        : h("ul", { className: "tsm-list" },
            catalog.map((item) => h("li", { key: item.id, className: "tsm-row" },
              h("div", { className: "tsm-row__main" },
                h("div", { className: "tsm-row__top" },
                  h("span", { className: "tsm-row__name" }, item.label),
                  h(Badge, { tone: "muted" }, labels[item.category] || item.category),
                  item.vendor ? h("span", { className: "tsm-row__meta" }, item.vendor) : null,
                  item.installed ? h(Badge, { tone: "success" }, "已配置") : null,
                  (item.envKeys || []).length ? h(Badge, { tone: "info" }, "需密钥: " + item.envKeys.join(", ")) : h(Badge, { tone: "success" }, "免密可用"),
                ),
                h("div", { className: "tsm-row__desc" }, item.summary),
                h("div", { className: "tsm-row__meta" }, item.access),
                item.homepage ? h("a", { className: "tsm-link", href: item.homepage, target: "_blank", rel: "noreferrer" }, "官方文档") : null,
              ),
              h("div", { className: "tsm-row__actions" },
                item.installed
                  ? h("span", { className: "tsm-row__meta" }, "已配置为 " + (item.installedAs || []).join(", "))
                  : h(Switch, { checked: selected.includes(item.id), onChange: () => toggle(item.id) }),
              ),
            )),
          ),
    );
  }

  // ── import ───────────────────────────────────────────────────────────────

  function ImportPanel() {
    const [sources, setSources] = useState(null);
    const [preview, setPreview] = useState(null);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [pasted, setPasted] = useState("");
    const [chosen, setChosen] = useState([]);
    const [busy, setBusy] = useState(false);

    const loadSources = useCallback(async () => {
      try {
        setSources(await getJson(API + "/import/sources"));
      } catch (err) {
        setError(errText(err));
      }
    }, []);

    useEffect(() => {
      loadSources();
    }, [loadSources]);

    const openSource = async (sourceId) => {
      setBusy(true);
      setError("");
      setPreview(null);
      setChosen([]);
      try {
        const row = await postJson(API + "/import/preview", { sourceId });
        setPreview(row);
        setChosen((row.entries || []).filter((item) => !item.error).map((item) => item.name));
      } catch (err) {
        setError(errText(err));
      } finally {
        setBusy(false);
      }
    };

    const applyPreview = async () => {
      if (preview === null) return;
      setBusy(true);
      setError("");
      try {
        const result = await postJson(API + "/import/apply", { sourceId: preview.sourceId, names: chosen });
        setNotice("已导入 " + result.added.length + " 个服务器" + (result.skipped.length ? "，跳过 " + result.skipped.length + " 个" : "") + "。默认按需档。");
        setPreview(null);
        await loadSources();
      } catch (err) {
        setError(errText(err));
      } finally {
        setBusy(false);
      }
    };

    const applyJson = async () => {
      setBusy(true);
      setError("");
      try {
        const result = await postJson(API + "/import/json", { text: pasted });
        setNotice("已导入 " + result.added.length + " 个服务器" + (result.skipped.length ? "，跳过 " + result.skipped.length + " 个" : "") + "。");
        if ((result.warnings || []).length) setError(result.warnings.join("\n"));
        setPasted("");
      } catch (err) {
        setError(errText(err));
      } finally {
        setBusy(false);
      }
    };

    const rows = sources === null ? [] : sources.rows || [];

    return h("div", { className: "tsm" },
      h(Notice, { kind: "error", onDismiss: () => setError("") }, error),
      h(Notice, { kind: "success", onDismiss: () => setNotice("") }, notice),
      h("p", { className: "tsm-hint" },
        "路径只由宿主按固定文件名拼出，浏览器永远不传路径进来。识别出的条目逐条归一化：一条不支持不会让整份配置读不出来。"),
      h("div", { className: "tsm-head" }, h("h3", { className: "tsm-title" }, "从其他客户端导入")),
      sources === null
        ? h(Empty, null, "正在扫描本机配置…")
        : rows.length === 0
          ? h(Empty, null, "本机没有发现可导入的客户端配置。")
          : h("ul", { className: "tsm-list" },
              rows.map((row) => h("li", { key: row.key, className: "tsm-row" },
                h("div", { className: "tsm-row__main" },
                  h("div", { className: "tsm-row__top" },
                    h("span", { className: "tsm-row__name" }, row.label),
                    h(Badge, { tone: "muted" }, row.scope),
                    h("span", { className: "tsm-row__meta" }, row.displayPath),
                  ),
                  row.error ? h("div", { className: "tsm-row__desc" }, row.error) : null,
                  h("div", { className: "tsm-row__meta" }, (row.entries || []).length + " 条 MCP 配置"),
                ),
                h("div", { className: "tsm-row__actions" },
                  h("button", { type: "button", className: "tsm-btn", disabled: busy, onClick: () => openSource(row.sourceId) }, "预览"),
                ),
              )),
            ),
      preview !== null
        ? h("div", { className: "tsm-preview" },
            h("div", { className: "tsm-head" },
              h("h3", { className: "tsm-title" }, "预览：" + preview.label),
              h("button", { type: "button", className: "tsm-btn tsm-btn--ghost", onClick: () => setPreview(null) }, "取消"),
            ),
            preview.error ? h(Notice, { kind: "error" }, preview.error) : null,
            h("ul", { className: "tsm-list" },
              (preview.entries || []).map((item) => h("li", { key: item.name, className: "tsm-row" },
                h("div", { className: "tsm-row__main" },
                  h("div", { className: "tsm-row__top" },
                    h("span", { className: "tsm-row__name" }, item.name),
                    item.error ? h(Badge, { tone: "error" }, "不支持") : h(Badge, { tone: "success" }, item.spec ? item.spec.transport : "ok"),
                  ),
                  item.error ? h("div", { className: "tsm-row__desc" }, item.error) : null,
                  (item.warnings || []).length ? h("div", { className: "tsm-row__meta" }, item.warnings.join("；")) : null,
                ),
                item.error
                  ? null
                  : h(Switch, {
                      checked: chosen.includes(item.name),
                      onChange: () => setChosen((current) => (current.includes(item.name) ? current.filter((value) => value !== item.name) : [...current, item.name])),
                    }),
              )),
            ),
            h("div", { className: "tsm-row__actions" },
              h("button", { type: "button", className: "tsm-btn", disabled: busy || chosen.length === 0, onClick: applyPreview }, "导入所选 " + chosen.length + " 条"),
            ),
          )
        : null,
      h("div", { className: "tsm-head" }, h("h3", { className: "tsm-title" }, "粘贴 JSON 配置")),
      h("p", { className: "tsm-hint" },
        '支持 {"mcpServers": {...}}、{"servers": {...}}，或单条 {"command"|"url": ...}。含 VS Code ${input:…} 的配置会被拒绝（需要交互取值）。'),
      h("textarea", {
        className: "tsm-textarea",
        rows: 8,
        placeholder: '{ "mcpServers": { "my-server": { "command": "npx", "args": ["-y", "some-mcp"] } } }',
        value: pasted,
        onChange: (event) => setPasted(event.target.value),
      }),
      h("div", { className: "tsm-row__actions" },
        h("button", { type: "button", className: "tsm-btn", disabled: busy || pasted.trim() === "", onClick: applyJson }, "导入"),
      ),
    );
  }

  // ── skills ───────────────────────────────────────────────────────────────

  function SkillsPanel() {
    const [skills, setSkills] = useState(null);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [confirming, setConfirming] = useState("");

    const refresh = useCallback(async () => {
      try {
        const data = await getJson(API + "/skills");
        setSkills(data.skills || []);
      } catch (err) {
        setError(errText(err));
        setSkills([]);
      }
    }, []);

    useEffect(() => {
      refresh();
    }, [refresh]);

    const act = async (path, body, message) => {
      setError("");
      setNotice("");
      try {
        await postJson(API + path, body);
        await refresh();
        if (message) setNotice(message);
      } catch (err) {
        setError(errText(err));
      }
    };

    if (skills === null) return h(Empty, null, "正在读取技能…");
    if (skills.length === 0) {
      return h("div", { className: "tsm" },
        h(Notice, { kind: "error", onDismiss: () => setError("") }, error),
        h(Empty, null, "没有发现 bundle 技能（`<dir>/SKILL.md`）。"),
      );
    }

    return h("div", { className: "tsm" },
      h(Notice, { kind: "error", onDismiss: () => setError("") }, error),
      h(Notice, { kind: "success", onDismiss: () => setNotice("") }, notice),
      h("ul", { className: "tsm-list" },
        skills.map((skill) => h("li", { key: skill.path, className: "tsm-row" },
          h("div", { className: "tsm-row__main" },
            h("div", { className: "tsm-row__top" },
              h("span", { className: "tsm-row__name" }, skill.name),
              skill.readonly ? h(Badge, { tone: "muted" }, "只读（随包发布）") : null,
              skill.modelInvocable ? null : h(Badge, { tone: "info" }, "模型不可调用"),
            ),
            h("div", { className: "tsm-row__desc" }, skill.description),
            h("div", { className: "tsm-row__path" }, skill.path),
          ),
          h("div", { className: "tsm-row__actions" },
            h("div", { className: "tsm-switchline" },
              h("span", { className: "tsm-switchline__label" }, "模型可调用"),
              h(Switch, {
                checked: skill.modelInvocable,
                disabled: skill.readonly,
                onChange: (next) => act("/skills/toggle", { name: skill.name, enabled: next }, "已" + (next ? "启用" : "停用") + " " + skill.name + " 的模型调用"),
              }),
            ),
            h("button", { type: "button", className: "tsm-btn tsm-btn--ghost", onClick: () => act("/skills/open", { name: skill.name }) }, "打开"),
            confirming === skill.name
              ? h("span", { className: "tsm-confirm" },
                  h("button", {
                    type: "button",
                    className: "tsm-btn tsm-btn--danger",
                    onClick: () => {
                      act("/skills/delete", { name: skill.name }, "已删除 " + skill.name);
                      setConfirming("");
                    },
                  }, "确认删除"),
                  h("button", { type: "button", className: "tsm-btn tsm-btn--ghost", onClick: () => setConfirming("") }, "取消"),
                )
              : skill.readonly
                ? null
                : h("button", { type: "button", className: "tsm-btn tsm-btn--danger", onClick: () => setConfirming(skill.name) }, "删除"),
          ),
        )),
      ),
    );
  }

  // ── settings ─────────────────────────────────────────────────────────────

  function SettingsPanel() {
    const [settings, setSettings] = useState(null);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(async () => {
      try {
        setSettings(await getJson(API + "/settings"));
      } catch (err) {
        setError(errText(err));
      }
    }, []);

    useEffect(() => {
      refresh();
    }, [refresh]);

    const save = async (patch) => {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const next = await postJson(API + "/settings", patch);
        setSettings(next);
        // Placement takes effect immediately: the seats are torn down and rebuilt
        // through the disposer `apply()` kept. Without this the operator had to
        // reload and could not tell whether the switch did anything.
        if (patch.uiPlacement !== undefined && placementListener) {
          placementListener(next.uiPlacement);
          setNotice("已保存，显示位置已切换。");
        } else {
          setNotice("已保存。目录改动在下一次请求生效。");
        }
      } catch (err) {
        setError(errText(err));
      } finally {
        setBusy(false);
      }
    };

    if (settings === null) return h(Empty, null, "正在读取设置…");

    return h("div", { className: "tsm" },
      h(Notice, { kind: "error", onDismiss: () => setError("") }, error),
      h(Notice, { kind: "success", onDismiss: () => setNotice("") }, notice),
      // Two deferred-tool searches visible at once cannot both be right. Say so
      // where the operator can act on it, naming both tools.
      settings.searchConflict
        ? h(Notice, { kind: "error" },
            "检索工具重名：本插件的检索工具注册为 " + settings.searchConflict.registeredAs +
              "，因为 " + settings.searchConflict.preferredName + " 已被另一个插件占用" +
              (settings.searchConflict.description ? "（" + settings.searchConflict.description + "）" : "") +
              "。模型现在会同时看到一个以上的检索入口——请在插件列表里关掉另一个的检索功能，或调整本插件的 searchToolName。",
          )
        : null,
      h("div", { className: "tsm-setting tsm-setting--block" },
        h("div", { className: "tsm-setting__row" },
          h("span", { className: "tsm-setting__label" }, "显示位置"),
          h("select", {
            className: "tsm-select",
            value: settings.uiPlacement,
            disabled: busy,
            onChange: (event) => save({ uiPlacement: event.target.value }),
          },
            h("option", { value: "both" }, "设置页 + 侧边栏（默认）"),
            h("option", { value: "settings" }, "只在设置页"),
            h("option", { value: "sidebar" }, "只在侧边栏"),
          ),
        ),
        h("p", { className: "tsm-hint" },
          "侧边栏是左侧栏里的一个图标，点开占满中间区域，比设置页的窄栏好用；设置页则是从「设置 → 工具检索」进入。",
          "切换立即生效，不需要刷新。",
        ),
        // Choosing "sidebar only" removes the page you are standing on, and then
        // there is no way back from inside the app. Say so, and offer the way back
        // before it disappears.
        settings.uiPlacement === "sidebar"
          ? h("p", { className: "tsm-hint" },
              "当前只显示在侧边栏——这个设置页下次打开时就没了。要改回来，从左侧栏图标进入，再到「设置」页签。")
          : null,
        settings.uiPlacement === "settings"
          ? h("p", { className: "tsm-hint" },
              "当前只显示在设置页：左侧栏没有图标。改动仍会立即生效。")
          : null,
      ),
      h("div", { className: "tsm-setting tsm-setting--block" },
        h("div", { className: "tsm-setting__row" },
          h("span", { className: "tsm-setting__label" }, "目录粒度"),
          h("select", {
            className: "tsm-select",
            value: settings.catalogGranularity,
            disabled: busy,
            onChange: (event) => save({ catalogGranularity: event.target.value }),
          },
            h("option", { value: "server" }, "服务器级（每台服务器一行，最省字符）"),
            h("option", { value: "tool" }, "工具级（每个工具一行，模型能预知细节）"),
          ),
        ),
        h("p", { className: "tsm-hint" }, "服务器级在 63 个工具下约 400 字符；工具级在描述截 80 字符下约 6,900 字符。"),
      ),
      h("div", { className: "tsm-setting tsm-setting--block" },
        h("div", { className: "tsm-setting__row" },
          h("span", { className: "tsm-setting__label" }, "工具描述上限"),
          h("input", {
            className: "tsm-input",
            type: "number",
            min: 4,
            max: 5000,
            defaultValue: settings.toolDescriptionMaxLength,
            disabled: busy,
            onBlur: (event) => {
              const next = Number(event.target.value);
              if (Number.isInteger(next) && next >= 4 && next !== settings.toolDescriptionMaxLength) save({ toolDescriptionMaxLength: next });
            },
          }),
          h("span", { className: "tsm-count" }, "字符，仅工具级目录使用"),
        ),
      ),
      h("div", { className: "tsm-setting tsm-setting--block" },
        h("div", { className: "tsm-setting__row" },
          h("span", { className: "tsm-setting__label" }, "本地命令审批"),
          h("select", {
            className: "tsm-select",
            value: settings.localCommandApproval,
            disabled: busy,
            onChange: (event) => save({ localCommandApproval: event.target.value }),
          },
            h("option", { value: "follow" }, "跟随会话权限（默认）"),
            h("option", { value: "always-ask" }, "总是询问"),
            h("option", { value: "always-allow" }, "总是允许"),
          ),
        ),
        h("p", { className: "tsm-hint" }, "登记或修改本地程序（stdio）时是否先征求同意。"),
      ),
      h("div", { className: "tsm-setting tsm-setting--block" },
        h("div", { className: "tsm-setting__row" },
          h("span", { className: "tsm-setting__label" }, "stdio 读缓冲上限"),
          h("input", {
            className: "tsm-input",
            type: "number",
            min: 0,
            placeholder: "SDK 默认",
            defaultValue: settings.stdioMaxBufferSizeMb === null ? "" : settings.stdioMaxBufferSizeMb,
            disabled: busy,
            onBlur: (event) => {
              const raw = event.target.value.trim();
              const next = raw === "" ? null : Number(raw);
              if ((next === null || (Number.isInteger(next) && next > 0)) && next !== settings.stdioMaxBufferSizeMb) {
                save({ stdioMaxBufferSizeMb: next });
              }
            },
          }),
          h("span", { className: "tsm-count" }, "MB，留空 = 10 MiB"),
        ),
        h("p", { className: "tsm-hint" }, "单个 MCP 响应超过上限时，那次调用拿到结构化错误而连接不断。改后对新连接生效。"),
      ),
      h("div", { className: "tsm-setting tsm-setting--block" },
        h("div", { className: "tsm-setting__row" },
          h("span", { className: "tsm-setting__label" }, "局域网主机允许名单"),
          h("input", {
            className: "tsm-input tsm-input--wide",
            defaultValue: (settings.lanHostAllowlist || []).join(", "),
            disabled: busy,
            onBlur: (event) => {
              const next = event.target.value.split(",").map((item) => item.trim()).filter(Boolean);
              save({ lanHostAllowlist: next });
            },
          }),
        ),
        h("p", { className: "tsm-hint" }, "localhost、本机名与 IP 字面量始终允许；其他主机名要写在这里才能用浏览器访问这些路由。"),
      ),
      h("div", { className: "tsm-setting tsm-setting--block" },
        kv("检索工具名", settings.searchToolName),
        kv("当前 profile", settings.profile),
        kv("patch 文件", settings.patchPath),
      ),
    );
  }

  // ── page ─────────────────────────────────────────────────────────────────

  function ManagerSection(props) {
    const [tab, setTab] = useState("capabilities");
    // `embedded` is the sidebar panel: the host already draws the panel chrome
    // and a title there, so repeating the big heading would waste the vertical
    // space that made the settings page feel cramped in the first place.
    const embedded = props?.embedded === true;
    return h("div", { className: embedded ? "tsm tsm--panel" : "tsm" },
      embedded
        ? null
        : h("div", { className: "tsm-header" },
            h("h2", { className: "tsm-title" }, "工具检索与管理"),
            h("span", { className: "tsm-subtitle" }, "MCP 连接、工具可见性、市场与导入，全部由这一个插件管。"),
          ),
      h("div", { className: "tsm-tabs", role: "tablist" },
        h(Tab, { label: "能力", active: tab === "capabilities", onClick: () => setTab("capabilities") }),
        h(Tab, { label: "市场", active: tab === "market", onClick: () => setTab("market") }),
        h(Tab, { label: "导入", active: tab === "import", onClick: () => setTab("import") }),
        h(Tab, { label: "技能", active: tab === "skills", onClick: () => setTab("skills") }),
        h(Tab, { label: "设置", active: tab === "settings", onClick: () => setTab("settings") }),
      ),
      h("div", { className: "tsm-body" },
        tab === "capabilities" ? h(CapabilitiesPanel) : null,
        tab === "market" ? h(MarketPanel) : null,
        tab === "import" ? h(ImportPanel) : null,
        tab === "skills" ? h(SkillsPanel) : null,
        tab === "settings" ? h(SettingsPanel) : null,
      ),
    );
  }

  /** The sidebar panel cell; the host draws the surrounding page. */
  function ManagerPanel() {
    return h(ManagerSection, { embedded: true });
  }

  // ── CSS ──────────────────────────────────────────────────────────────────
  // Only `--dsw-alias-*` tokens: a renamed token degrades appearance, never
  // rendering. Class names are prefixed `tsm-` so nothing collides with a host
  // or another plugin's stylesheet.
  const CSS = [
    ".tsm { display:flex; flex-direction:column; gap:12px; min-width:0; }",
    // Panel mode: the host supplies the page chrome, so this fills the central
    // column and scrolls internally instead of growing past the viewport.
    ".tsm--panel { height:100%; padding:16px 20px 24px; box-sizing:border-box; overflow:hidden; }",
    ".tsm-body { flex:1; min-height:0; overflow-y:auto; overflow-x:hidden; display:flex; flex-direction:column; gap:12px; padding-right:2px; }",
    ".tsm-header { display:flex; flex-direction:column; gap:2px; }",
    ".tsm-title { margin:0; font-size:15px; font-weight:600; color:var(--dsw-alias-label-primary); }",
    ".tsm-subtitle { font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".tsm-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }",
    ".tsm-head__meta { display:flex; align-items:center; gap:8px; }",
    ".tsm-count { font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".tsm-hint { margin:0; font-size:12px; line-height:1.6; color:var(--dsw-alias-label-secondary); }",
    ".tsm-tabs { display:flex; gap:4px; border-bottom:1px solid var(--dsw-alias-border-l1); padding-bottom:8px; flex-wrap:wrap; }",
    ".tsm-tab { font-size:12px; padding:6px 12px; border-radius:6px; border:1px solid transparent; background:none; color:var(--dsw-alias-label-secondary); cursor:pointer; }",
    ".tsm-tab.is-active { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); }",
    ".tsm-tab__count { margin-left:6px; font-size:11px; opacity:.75; }",
    ".tsm-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; }",
    ".tsm-row { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; padding:10px 12px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-1); }",
    ".tsm-row__main { min-width:0; flex:1; display:flex; flex-direction:column; gap:6px; }",
    ".tsm-row__top { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }",
    ".tsm-row__name { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); }",
    ".tsm-row__meta { font-size:11px; color:var(--dsw-alias-label-secondary); }",
    ".tsm-row__desc { font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".tsm-row__path { font-size:11px; color:var(--dsw-alias-label-secondary); word-break:break-all; }",
    ".tsm-row__actions { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }",
    ".tsm-btn { font-size:12px; line-height:1; padding:6px 10px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); cursor:pointer; }",
    ".tsm-btn:hover:not(:disabled) { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }",
    ".tsm-btn:disabled { opacity:.5; cursor:not-allowed; }",
    ".tsm-btn--ghost { border-color:var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); }",
    ".tsm-btn--danger { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }",
    ".tsm-tiers { display:inline-flex; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; overflow:hidden; }",
    ".tsm-tier { font-size:11px; line-height:1; padding:5px 9px; border:none; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; }",
    ".tsm-tier + .tsm-tier { border-left:1px solid var(--dsw-alias-border-l1); }",
    ".tsm-tier.is-active { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font-weight:600; }",
    ".tsm-tier.is-active.tsm-tier--eager { color:var(--dsw-alias-state-success-primary); }",
    ".tsm-tier.is-active.tsm-tier--on-demand { color:var(--dsw-alias-brand-primary); }",
    ".tsm-tier.is-active.tsm-tier--disabled { color:var(--dsw-alias-state-error-primary); }",
    ".tsm-tier:disabled { opacity:.45; cursor:not-allowed; }",
    ".tsm-switch { position:relative; width:30px; height:17px; border-radius:999px; border:none; background:var(--dsw-alias-border-l2); cursor:pointer; padding:0; flex-shrink:0; }",
    ".tsm-switch.is-on { background:var(--dsw-alias-brand-primary); }",
    ".tsm-switch:disabled { opacity:.5; cursor:not-allowed; }",
    ".tsm-switch__knob { position:absolute; top:2px; left:2px; width:13px; height:13px; border-radius:50%; background:var(--dsw-alias-bg-layer-1); transition:left .12s ease; }",
    ".tsm-switch.is-on .tsm-switch__knob { left:15px; }",
    ".tsm-switchline { display:flex; align-items:center; gap:6px; }",
    ".tsm-switchline__label { font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".tsm-badge { font-size:10px; padding:2px 6px; border-radius:999px; border:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-secondary); white-space:nowrap; }",
    ".tsm-badge--success { color:var(--dsw-alias-state-success-primary); border-color:var(--dsw-alias-state-success-primary); }",
    ".tsm-badge--info { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }",
    ".tsm-badge--error { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); }",
    ".tsm-badge--muted { color:var(--dsw-alias-label-secondary); border-color:var(--dsw-alias-border-l1); }",
    ".tsm-notice { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; padding:8px 10px; border-radius:6px; font-size:12px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }",
    ".tsm-notice__text { white-space:pre-wrap; word-break:break-word; }",
    ".tsm-notice--success { border-color:var(--dsw-alias-state-success-primary); }",
    ".tsm-notice--error { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }",
    ".tsm-notice__close { border:none; background:none; color:inherit; cursor:pointer; font-size:14px; padding:0 2px; }",
    ".tsm-empty { padding:18px; text-align:center; font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".tsm-confirm { display:inline-flex; gap:6px; align-items:center; }",
    ".tsm-detail { display:flex; flex-direction:column; gap:6px; border-top:1px solid var(--dsw-alias-border-l1); padding-top:10px; }",
    ".tsm-kv { display:flex; gap:8px; font-size:12px; }",
    ".tsm-kv__k { flex-shrink:0; min-width:110px; color:var(--dsw-alias-label-secondary); }",
    ".tsm-kv__v { color:var(--dsw-alias-label-primary); word-break:break-all; }",
    ".tsm-tools { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:4px; }",
    ".tsm-tools--grid { display:grid; grid-template-columns:1fr; gap:6px; }",
    ".tsm-tool { display:flex; align-items:center; gap:8px; font-size:12px; padding:4px 0; }",
    // The tier buttons must stay visible at any width. They were pushed out of
    // the row before: the description refused to wrap and `justify-content:
    // space-between` let it push the control off-screen, so the page looked like
    // it had no per-tool tier control at all — which is exactly how it was
    // reported.
    ".tsm-builtin { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; padding:8px 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:6px; background:var(--dsw-alias-bg-layer-1); }",
    ".tsm-builtin__main { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:2px; }",
    ".tsm-builtin > .tsm-tiers { flex:0 0 auto; }",
    // Two-line clamp rather than a nowrap ellipsis: a tool description is the
    // only thing distinguishing similarly named built-ins, so truncating to one
    // line on a narrow column communicates less than the extra height costs.
    ".tsm-builtin .tsm-tool__desc { white-space:normal; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; word-break:break-word; }",
    ".tsm-tool__tier { flex-shrink:0; min-width:56px; text-align:center; font-size:10px; padding:2px 4px; border-radius:5px; border:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-primary); }",
    ".tsm-tool__tier.is-eager { color:var(--dsw-alias-state-success-primary); border-color:var(--dsw-alias-state-success-primary); }",
    ".tsm-tool__tier.is-on-demand { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }",
    ".tsm-tool__tier.is-disabled { color:var(--dsw-alias-label-secondary); }",
    ".tsm-tool__name { font-family:var(--ds-font-family-code); color:var(--dsw-alias-label-primary); flex-shrink:0; }",
    ".tsm-tool__desc { color:var(--dsw-alias-label-secondary); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }",
    ".tsm-tool__action { margin-left:auto; }",
    ".tsm-tool.is-disabled .tsm-tool__name, .tsm-tool.is-disabled .tsm-tool__desc { color:var(--dsw-alias-label-secondary); opacity:.7; }",
    ".tsm-output { margin:0; padding:8px; border-radius:6px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font-size:11px; white-space:pre-wrap; word-break:break-word; max-height:240px; overflow:auto; }",
    ".tsm-filters { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }",
    ".tsm-input, .tsm-select, .tsm-textarea { font-size:12px; padding:5px 8px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); }",
    ".tsm-input { width:88px; }",
    ".tsm-input--wide { width:auto; flex:1; min-width:180px; }",
    ".tsm-textarea { width:100%; box-sizing:border-box; font-family:var(--ds-font-family-code); resize:vertical; }",
    ".tsm-link { font-size:12px; color:var(--dsw-alias-brand-primary); }",
    ".tsm-setting { display:flex; gap:8px; padding:8px 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-1); }",
    ".tsm-setting--block { flex-direction:column; align-items:stretch; gap:8px; }",
    ".tsm-setting__row { display:flex; align-items:center; gap:8px; min-width:0; flex-wrap:wrap; }",
    ".tsm-setting__label { flex:none; white-space:nowrap; font-size:12px; color:var(--dsw-alias-label-secondary); min-width:110px; }",
    ".tsm-preview { display:flex; flex-direction:column; gap:8px; padding:10px; border:1px solid var(--dsw-alias-brand-primary); border-radius:8px; }",
  ].join("\n");

  function injectCss() {
    if (typeof document === "undefined") return;
    const tagId = "dsh-toolsearch-manage";
    if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-toolsearch-manage";
    tag.dataset.pluginCss = tagId;
    tag.textContent = CSS;
    document.head.appendChild(tag);
  }

  // ── apply ────────────────────────────────────────────────────────────────
  /**
   * The rail icon. `sidebar.panellist` owner props are `{ size, active }` — this
   * slot draws a SQUARE ICON, not a page. Registering the manager itself here is
   * what put the whole panel into the left rail.
   *
   * Inline SVG rather than the plugin's `icon.svg`: the host asks for an inline
   * element and has no loader for a package asset from the client half.
   */
  function RailIcon(props) {
    const size = typeof props?.size === "number" ? props.size : 18;
    const active = props?.active === true;
    return h("svg", {
      width: size, height: size, viewBox: "0 0 24 24", fill: "none",
      stroke: "currentColor", strokeWidth: 1.7,
      strokeLinecap: "round", strokeLinejoin: "round",
      "aria-hidden": "true", focusable: "false",
      style: { opacity: active ? 1 : 0.82 },
    },
      // A magnifier over three stacked rows: search, and the three tiers.
      h("circle", { cx: 10.5, cy: 10.5, r: 6.5 }),
      h("line", { x1: 15.4, y1: 15.4, x2: 20, y2: 20 }),
      h("line", { x1: 7.6, y1: 8.4, x2: 13.4, y2: 8.4 }),
      h("line", { x1: 7.6, y1: 10.7, x2: 11.9, y2: 10.7 }),
      h("line", { x1: 7.6, y1: 13, x2: 10.2, y2: 13 }),
    );
  }

  function apply(ctx) {
    injectCss();

    // Placement is live, but the FIRST registration must be synchronous.
    //
    // `apply()` runs inside the host's activation step. Registering from a promise
    // callback lands after it, and both seats were then invisible: an icon that
    // opened nothing, and no settings page at all. So all seats are claimed
    // synchronously; the stored value then releases the unwanted one, and a later
    // change rebuilds from scratch through the disposers.
    //
    // `inject` callbacks must return the DISPOSER. Returning `disposers.push(…)`
    // yields a NUMBER, which the host calls on teardown — that throw aborted the
    // remaining registrations, which is how only the first seat survived.
    const SEATS = {
      sidebar: () => ctx.slots.inject("sidebar.panellist", () => record(ctx.slots.register({
        name: "sidebar.panellist",
        id: PANEL_ID,
        order: 30,
        label: "工具检索",
      }, RailIcon))),
      main: () => ctx.slots.inject("main", () => record(ctx.slots.register({
        name: "main",
        key: PANEL_ID,
      }, ManagerPanel))),
      settings: () => ctx.slots.inject("settings.section", () => record(ctx.slots.register({
        name: "settings.section",
        id: "toolsearch",
        order: 36,
        label: "工具检索",
      }, ManagerSection))),
    };

    let live = [];
    let current;

    const record = (dispose) => {
      live.push(dispose);
      return dispose;
    };

    const rebuild = (placement) => {
      if (placement === current) return;
      current = placement;
      for (const dispose of live.splice(0)) {
        try {
          dispose();
        } catch {
          // Disposing twice (unmount racing a placement change) must not throw.
        }
      }
      if (placement !== "settings") {
        SEATS.sidebar();
        SEATS.main();
      }
      if (placement !== "sidebar") SEATS.settings();
    };

    // Claim everything now, so activation sees the seats.
    SEATS.sidebar();
    SEATS.main();
    SEATS.settings();
    current = "both";

    // The settings panel calls this after saving, so a change lands without a
    // reload. A module-level hook is the only path from the panel back to here.
    placementListener = (placement) => rebuild(placement);

    // Honour a stored non-default placement. This may release a seat moments
    // after it was claimed, which is the price of not losing the seat entirely.
    getJson(API + "/settings")
      .then((settings) => rebuild(settings.uiPlacement))
      .catch(() => {
        /* keep `both` */
      });
  }

  /** Set by `apply`, called by the settings panel when the placement is saved. */
  let placementListener;

  return { name, inject, apply };
}});
