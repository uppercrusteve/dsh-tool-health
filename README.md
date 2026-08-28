# dsh-tool-health

工具健康度哨兵（DSH host 端插件，v0.1.0，零 npm 依赖）。

痛点：agent 对工具的间歇性故障没有跨会话记忆，反复撞同一个坏工具浪费回合。
本插件在每次工具执行落定后记录 `{tool, ok, ms, errorClass, err?}`，持久化到
`$DSH_HOME/tool-health/history.json`（滚动窗口：每工具近 `windowDays` 天、上限
`maxEntriesPerTool` 条），并在会话启动时把"慢性失败工具"警告注入系统提示。

## 行为

- **观测**：`tools/result`（官方纯观测事件，冻结快照，监听器失败被宿主隔离）记录结果；
  `tools/execute` 环绕分发计时（官方 metrics 钩子）。错误分类为纯文本启发式：
  `success / timeout / network / rate-limit / permission / unknown`。
- **慢性判定**（默认）：近 3 天内失败 ≥5 次且失败率 ≥30% 的工具，在系统提示注册段
  `plugin:tool-health`（order 218）注入一行：
  `⚠ tool-health: 近期高失败率工具 foo(62%) bar(41%)——优先改用替代或先检查其依赖服务。`
  无慢性工具时注册空 section（text 为空串）。
- **模型工具**：
  - `tool_health_report({tool?, days?=7})` → markdown 体检表（调用数/成功率/错误分布/p50/p95 延迟/最近一次失败摘录）。
  - `tool_health_reset({confirm:true})` → 清空历史（confirm 不为 true 时拒绝，防误删）。
- **slash 命令**：`/tool-health` 输出与 report 同源的近 7 天摘要。
- **HTTP**：`GET /dsh-tool-health/summary` → JSON（近 7 天每工具统计 + 慢性名单 + 配置回显），供将来 UI。
- **重试策略 v0.1**：仅记录建议，不自动重试（保守；summary/report 里以
  `retryPolicy: v0.1-observe-only` 标注）。

## 安装

### A. git 安装（正式，已真机实测）

```
dsh plugin --profile web add github:uppercrusteve/dsh-tool-health
# 锁定发布 tag（可复现）：
dsh plugin --profile web add github:uppercrusteve/dsh-tool-health#v0.1.0
```

profile 的 `package.json` 会同时记入 `dependencies` 与 `dsh.profile.bundles`（宿主按已安装
状态调和），启动时自动应用 `dsh.bundle.patch` 声明的
`examples/tool-health.bundle.patch.yml`——**不需要** `--patch`。
卸载：`dsh plugin --profile web remove @uppercrusteve/dsh-tool-health`。

Windows 实测记录（2026-08-28，隔离 `DSH_HOME`，宿主为 DSH Desktop 自带 dsh）：

- `add github:uppercrusteve/dsh-tool-health` 后三项齐备：`dependencies` 记入、
  `dsh.profile.bundles` 记入、`node_modules/@uppercrusteve/dsh-tool-health/src/index.js` 存在；
  安装件 `src/index.js` 28804 字节 / sha256 `eea90a9f…9cc6a1` / 行尾 LF，与 raw.githubusercontent
  及仓库 blob 逐字节一致（`.gitattributes` 的 `* text=auto eol=lf` 生效，安装不被 CRLF 污染）。
- 免 `--patch` 起 web：`[tool-health] apply ok … configSource=patch(windowDays+warnMinFailures+warnMinRate)`，
  无 `plugin tree failed`；`GET /dsh-tool-health/summary` 返回 200 且 JSON 形状正确；`/` 返回 200。
- `#v0.1.0` 锁 tag 形态等价可用（依赖记为 `github:uppercrusteve/dsh-tool-health#v0.1.0`，
  安装件 sha 同上），boot 与 summary 表现一致。
- `remove` 后三项清除（依赖、bundles、`node_modules` 内包体均消失；pnpm 会留一个空的
  `node_modules\@uppercrusteve` 作用域目录，无内容、不参与启动）；再起 web：`/` 200、
  `/dsh-tool-health/summary` 404、日志无 `[tool-health]` 行。

默认分支为 `main`；不带 ref 的 `github:` 形式解析到 `main` HEAD，`#v0.1.0` 钉住发布提交
（两者 `src/index.js` 内容相同）。

### A2. npm 安装（尚未发布）

```
dsh plugin --profile web add @uppercrusteve/dsh-tool-health
```

npm registry 目前对该包名返回 404——发布之后此形式才可用；在那之前请用上面的 `github:` 形式。

### B. dev patch（免安装迭代）

```
$env:DSH_HOME = 'D:\path\to\isolated\home'
node "<dsh bin>" --profile web --patch "<repo>\plugin\examples\tool-health.dev-fileurl.patch.yml" --port 18781 --no-open
```

注意 name 必须是 `file:///` 绝对 URL（裸 `D:\...` 会被 ESM loader 当协议，整树死于
ERR_UNSUPPORTED_ESM_URL_SCHEME）。用前编辑该 yml 里的路径。

## Config

patch 行 `config:` 块（apply(ctx, config) 接收；未识别键忽略）：

| 键 | 默认 | 说明 |
|---|---|---|
| `windowDays` | 14 | 历史滚动窗口（天，1–90） |
| `warnWindowDays` | 3 | 慢性判定窗口（天） |
| `warnMinFailures` | 5 | 慢性判定：最少失败次数（≥） |
| `warnMinRate` | 0.3 | 慢性判定：最低失败率（≥） |
| `maxEntriesPerTool` | 500 | 每工具条数上限（50–5000） |
| `flushDebounceMs` | 1000 | 落盘防抖下限（≥1000） |

插件不导出 config schema（吸取 dsh-converge 教训：不以 standard-schema 语义导出 Config）。

## 数据与隐私

- 唯一持久文件：`$DSH_HOME/tool-health/history.json`（DSH_HOME 缺省回退 `~/.dsh`）。
- 每条记录仅含工具名、成败、耗时、错误类别与 ≤240 字符错误摘录；不记录入参值。
- 写入防抖 ≥1s，tmp+rename 原子替换；文件损坏时改名为 `history.json.corrupt-<ts>` 后重建，不抛错。
- 删除数据：删掉 history.json（或跑 `tool_health_reset`）。

## 差异说明

cost-meter / token-heatmap / devtools 关注 token、成本与开发者侧检查；
**dsh-tool-health 专注工具执行历史的健康度与模型侧注入**（把慢性失败工具警告放进系统提示），互不重叠。

## Boot 日志

apply 成功后 stdout 打印一行：

```
[tool-health] apply ok windowDays=14 warnMinFailures=5 warnMinRate=0.3 toolsSeen=N chronic=K configSource=... services=tools:yes,systemPrompt:yes,commands:...,webServer:...
```

可选 `DSH_TOOLHEALTH_LOG=<file.jsonl>` 落结构化取证日志。

## License

MIT © 2026 uppercrusteve
