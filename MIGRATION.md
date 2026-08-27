# dsh-simplify 迁移说明（MIGRATION）

本文档记录 pi-simplify → dsh-simplify 的迁移决策、变更点、运行方式与验证记录，
供后续维护者直接查阅。

## 1. 迁移范围与原则

- 迁移目标：**功能等价**，不做功能重构、性能优化或界面改动；
- 源码逐文件移植，保留原注释与行为；仅适配宿主 API；
- pi-simplify 版本：0.2.3（npm），MIT。

## 2. 文件对照

| pi-simplify | dsh-simplify | 处理 |
| --- | --- | --- |
| `src/types.ts` | `src/types.ts` | 原样迁移 |
| `src/prompt-builder.ts` | `src/prompt-builder.ts` | 原样迁移（提示词逐字保留） |
| `src/git-diff.ts` | `src/git-diff.ts` | 适配 subprocess seam；`parseDiffOutput`/`parseChangedLines` 改为导出（仅测试可见性，零行为改动） |
| `src/simplify-command.ts` | `src/simplify-command.ts` | 适配命令注册 / 工作目录 / 消息注入 |
| `src/index.ts` | `src/index.ts` | 插件入口重写（Cordis 插件） |
| — | `cordis.patch.yml` | 新增：dsh bundle 插入清单 |
| — | `tests/simplify.test.mjs` | 新增：功能等价测试 |
| — | `package.json` / `tsconfig.json` | 新增：dsh 插件包元数据 |

## 3. API 映射（宿主适配点）

| pi-simplify（Pi） | dsh-simplify（DeepSeek Harness） |
| --- | --- |
| `pi.registerCommand("simplify", { description, handler })` | `ctx.commands.register({ name: "simplify", description, input: { hint }, handler })`（`@deepseek-ai/dsh-commands`） |
| `ctx.cwd`（会话工作目录） | `invocation.agent.session.header?.cwd ?? process.cwd()`（目录委派） |
| `pi.exec("git", args, { cwd })` | `ctx.subprocess.spawn({ argv: ["git", ...args], cwd, stdio: { stdin: "ignore", stdout/stderr: { maxBytes } }, graceMs: 7000, signal })`（`@deepseek-ai/dsh-subprocess`，树级终止 + AbortSignal） |
| `ctx.ui.notify(msg, "info")` | 返回 `{ kind: "success", text }`（`CommandResult` 由 UI 适配器直接渲染，不进模型历史） |
| `pi.sendUserMessage(prompt, { deliverAs: "followUp" })` | `agent.inbox.append("next-turn", createUserMessage({ content: [{ type: "text", text: prompt }], source: { kind: "plugin", plugin: "dsh-simplify" } }))`（`@deepseek-ai/dsh-llm`；持久化 inbox splice，唤醒驱动器下一轮消费） |
| 类型：`@earendil-works/pi-coding-agent` | 类型：`@deepseek-ai/cordis` / `dsh-commands` / `dsh-llm` / `dsh-session` / `dsh-subprocess` |

## 4. 行为保持核对

- [x] 参数语法：`--staged` / `--ref=<branch>` / 位置文件参数，语义与 pi 一致；
- [x] 提示词正文：逐字保留（四条原则 / Scope / Process / 红线）；
- [x] 变更行范围锁定：模型只改变更行，新增文件整文件在范围内；
- [x] 无变更时：不注入消息，仅提示（pi 为 notify，dsh 为 CommandResult 文本）；
- [x] git 命令参数序列与 pi 完全一致（`--unified=0 --no-ext-diff` 等）。

## 5. 构建与测试

```bash
npm install
npm run build     # tsc → lib/
npm test          # node --test tests/（真实 git 临时仓库 + fake subprocess seam）
```

测试覆盖：参数解析 ×4、提示词构建 ×3、diff 解析 ×3、变更文件收集 ×4（真实 git）、
命令处理 ×3（inbox 注入 / 无变更 / cwd 回落）。

## 6. 集成与加载验证

```bash
dsh plugin --profile web add dsh-simplify      # npm 已发布（0.1.0+）
# 或本地路径（开发版，需先 npm install && npm run build）：
# dsh plugin --profile web add <本插件路径>
dsh --profile web --dump-config   # 确认 simplify 条目已插入组合树
dsh web --no-open                 # 启动并检查日志无加载错误
```

## 7. 验证记录（2026-08-24，Windows 10 · Node v22.22.0 · dsh 0.1.1-rc.2）

### 7.1 构建与类型检查

```
$ npm run build
> tsc -p tsconfig.json      # 无输出 = 通过
$ npm run typecheck
> tsc --noEmit -p tsconfig.json   # 通过
```

产物：`lib/index.js`、`lib/git-diff.js`、`lib/prompt-builder.js`、`lib/simplify-command.js`、`lib/types.js` + 对应 .d.ts / .js.map。

### 7.2 功能等价测试（node --test，真实 git 临时仓库）

```
$ npm test
# tests 17  # pass 17  # fail 0
```

| 分组 | 用例 | 结果 |
| --- | --- | --- |
| 参数解析 | 默认值 / --staged / --ref+文件 / 混合输入 | 4/4 通过 |
| 提示词构建 | 变更行范围与原则 / 新增文件 / 纯删除文件 | 3/3 通过 |
| diff 解析 | M/A/R/C 状态与重命名新路径 / 未知状态忽略 / 行号区间与相邻合并 | 3/3 通过 |
| 变更收集（真实 git） | 工作区未提交 / --staged / 指定文件 / 干净仓库 | 4/4 通过 |
| 命令处理 | 无变更提示 / next-turn 消息注入 / cwd 回落 | 3/3 通过 |

### 7.3 dsh 集成与加载（web profile）

> ⚠️ 部署记录修订（2026-08-24 复核）：本节原始记录声称插件已在 web profile
> 安装并验证，但复核时发现 `profiles/web/package.json` 的 `dsh.profile.bundles`
> 列表**并不包含** dsh-simplify（仅残留 node_modules 符号链接）。已重新执行
> `dsh plugin add` 修复部署，以下为修复后实测记录：

```
$ dsh plugin --profile web add E:\Demo\cli-tools\dsh-simplify
+ dsh-simplify link:E:/Demo/cli-tools/dsh-simplify

# profiles/web/package.json（修复后）
"dependencies": { "dsh-simplify": "link:E:/Demo/cli-tools/dsh-simplify", ... }
"dsh.profile.bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", ..., "dsh-simplify"]

$ dsh --profile web --dump-config | grep -A2 simplify
# == dsh-simplify
- id: simplify
  name: dsh-simplify
  config: {}

$ dsh web --no-open
[ui-skin-center] legacy bridge: no legacy managed skin state; nothing to migrate
dsh web: http://127.0.0.1:3080   # 启动成功，无 dsh-simplify 相关错误
```

加载结论：插件已被 profile 识别、插入组合树（`id: simplify`），web 启动无加载报错。

> ⚠️ 生效前提：`dsh plugin add` 只更新 profile 清单（package.json / lockfile /
> 组合树），**不会热加载到已在运行的 dsh web 进程**。若在 web 运行期间安装，
> 需重启 dsh web 后 `/simplify` 才会注册生效。

> 环境备注：web 启动日志中的 better-sqlite3 NODE_MODULE_VERSION 报错来自
> dsh-cbx-orch / dsh-debugger-dap（既有环境问题，与本插件无关）；dsh-simplify
> 无原生依赖，不受影响。

### 7.4 与 pi-simplify 原版行为一致性

- 参数语法、提示词正文（逐字）、git 命令参数序列、无变更提示文案与 pi-simplify 0.2.3 一致；
- 未跟踪文件不纳入变更清单（`git diff` 语义，与原版一致）；
- 消息注入：原版 `deliverAs: "followUp"` → dsh `next-turn`，语义等价。

## 8. 已知差异

- dsh 的 CommandResult 文本会显示在 UI 中（pi 的 notify 同样显示），语义等价；
- pi 的 `deliverAs: "followUp"` 对应 dsh `next-turn`（下一轮输入），
  非 `next-step`（当前轮立即续跑），与 pi 的 follow-up 语义一致。

## 9. 变更记录

### 9.1 依赖对齐宿主版本（2026-08-24）

复核发现插件安装的 seam 包（`@deepseek-ai/dsh-*`）为 0.1.0-rc.8，而宿主闭包
（dsh 0.1.1-rc.2 的依赖）为 0.1.1-rc.2，存在版本漂移。已对齐：

- `@deepseek-ai/dsh-llm`（运行时调用 `createUserMessage`）从 `devDependencies`
  **移至 `dependencies`**，版本 `^0.1.1-rc.2`；
- `@deepseek-ai/dsh-commands` / `dsh-session` / `dsh-subprocess` / `schemastery`
  在 devDependencies 中对齐 `^0.1.1-rc.2` / `^3.18.1`。

验证：`npm run typecheck` 与 `npm test`（17/17）通过。插件从 profile 以符号链接
加载时，Node 沿真实路径解析到插件自身 node_modules，故对齐后与宿主版本一致，
消除潜在双实例/类型漂移。

### 9.2 GitHub 远端 + npm 发布（2026-08-24）

- 初始化 git 仓库（分支 `main`），远端 `origin` → `https://github.com/zerosloney/dsh-simplify`（PUBLIC，与姊妹插件一致）；
- 新增 `.github/workflows/ci.yml`（ubuntu/windows × node 22 测试矩阵）与
  `.github/workflows/publish.yml`（`v*` 标签触发：install → test → publish，用仓库
  `NPM_TOKEN` secret，账号 master0071）；
- 打标签 `v0.1.0` 触发发布，**npm 已发布 `dsh-simplify@0.1.0`**（latest），
  发布物含 `lib/`（js+d.ts+map）、`cordis.patch.yml`、README、MIGRATION；
- 安装方式从本地路径改为 npm 包：`dsh plugin --profile web add dsh-simplify`。

### 9.3 鲁棒性增强与测试环境隔离改进（2026-08-25）

- **参数引号与路径规范化**：`parseArgs` 支持单双引号包裹的带空格路径与参数（`tokenizeArgs`），并统一规范化 Windows 路径分隔符；
- **工作区未跟踪文件检测**：工作区模式（无 `--staged` 且对比 `HEAD`）通过 `git ls-files --others --exclude-standard` 自动检测未暂存新增文件，归类为 `added`；
- **回退透明度**：工作区无改动自动回退 `HEAD~1` 时，在 UI 提示与提示词中明确标注 `(fallback: comparing previous commit HEAD~1)`；
- **测试环境隔离修复**：修复 `tests/simplify.test.mjs` 中 `process.cwd` 回落用例因受外部 git commit 历史干扰而偶发失败的问题，并新增引号解析、untracked 文件、回退标注等 5 项测试（共 22/22 全部通过）。

### 9.4 移除 GitHub Actions，改为本机发布（2026-08-25）

- 删除 `.github/workflows/publish.yml`（`v*` 标签触发发布），发布不再依赖远端 CI / `NPM_TOKEN` secret；
- **保留 `.github/workflows/ci.yml`**（push/PR 触发 ubuntu/windows × node 22 测试矩阵），远端 CI 能力不变；
- 新增 `scripts/publish.mjs` 本机发布脚本，`npm run publish:local [patch|minor|major]`：
  校验 git 工作区干净 → `npm version` 升版本并打 `v*` 标签（`version` 钩子自动跑 `npm test`，
  测试失败则不提交）→ `npm publish`（`prepublishOnly` 钩子保证 `lib/` 为最新构建）；
- package.json 新增 `version` / `prepublishOnly` / `publish:local` 三个脚本；
- 本机发布不代替推送：发布成功后手动 `git push && git push --tags` 同步远端。

