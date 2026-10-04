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

测试覆盖（共 50 项，按被测对象分组）：`getChangedFiles` ×21（真实 git 临时仓库）、
`handleSimplifyCommand` ×7（inbox 注入 / 无变更 / cwd 回落 / 错误透传）、
`parseArgs` ×5、`parseDiffOutput` ×5、`buildSimplifyPrompt` ×4、
`parseChangedLinesPerFile` ×3、`unquoteGitPath` ×3、`parseChangedLines` ×1、
`tokenizeArgs` ×1。

> 分组数量会随回归用例增加而变化；以 `npm test` 实际输出为准，本节不追平每次增量。

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

> 阅读约定：本节的测试计数（如「17/17」「22/22」「39/39」「50/50」）是**各条目
> 撰写当日的验证快照**，用于记录该次改动交付时的状态，不随后续用例增加而回改。
> 当前测试总数与分组以 §5 与 `npm test` 实际输出为准。

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

### 9.5 恢复 GitHub Actions publish workflow（2026-09-25）

- 从旧历史（远端 `v0.1.0` 标签指向的提交 `6b7ec61`）**原样恢复**
  `.github/workflows/publish.yml`（`v*` 标签触发：install → test → publish，
  使用仓库 `NPM_TOKEN` secret）；
- `scripts/publish.mjs` 本机发布脚本保留不动，两种发布方式并存：打标签推送后
  Actions 自动发布，本机 `npm run publish:local` 亦可（注意避免同一版本双发）；
- 前置不变：仓库 Settings → Secrets and variables → Actions 中 `NPM_TOKEN` 需有效。

### 9.6 行为缺陷修复（2026-09-25）

代码审查发现四个行为缺陷（两 P1 两 P2），修复如下：

- **`--staged --ref=<branch>` 静默丢弃 ref（P1）**：旧实现 staged 时只传 `--cached`
  （恒为暂存区 vs HEAD），`--ref` 被忽略；现改为 `git diff --cached <ref>`
  （`--ref=HEAD` 默认时仍省略 ref——裸 `--cached` 与 `--cached HEAD` 等价，且在
  无首提交的仓库里依然可用）。清单与行号提取同步修改，并删除只对回退路径有意义
  的 `ref !== "HEAD~1"` 特判；
- **git 失败被吞成「无变更」（P1）**：`runGit` 现在收集 stderr，`getChangedFiles`
  返回值增加 `error` 字段，`handleSimplifyCommand` 将其映射为
  `{ kind: "error" }`。未知 `--ref`、非 git 仓库（含 `--staged`）等失败会显式报错，
  不再伪装成 "No changed files found"。归因细节：仓库外 `git diff` 会切到
  `--no-index` 模式，报错（如 unknown option `cached`）会掩盖真实原因，故失败时先以
  `git rev-parse --git-dir` 探测仓库可用性，不可用则报告其根因；无首提交仓库的
  `git diff HEAD` 失败仍按预期回退 untracked/`HEAD~1`，行为不变；
- **非 ASCII 路径被八进制转义（P2）**：git 调用统一加 `-c core.quotepath=off`，
  中文等非 ASCII 文件名在 `--name-status` 清单、`ls-files --others` 与逐文件
  行号 diff 全链路原样出现（继承自上游 pi-simplify 的问题）；
- **显式传入的未跟踪文件被误标「纯删除」（P2）**：显式文件列表先经
  `git ls-files --others --exclude-standard -- <paths>` 甄别，未跟踪新文件归类为
  `added`（提示词为「整文件在范围内」），不再因 diff 为空被降级成
  "deletions only" 而被模型跳过；
- 测试 22 → 29：新增 `--staged+ref` 基准、无首提交 `--staged`、未知 ref 错误、
  非 git 仓库错误、中文路径全链路、显式 untracked、handler 错误透传七组回归；
  原「cwd 回落」用例从裸临时目录改为真实 git 仓库（非 git 目录现在会正确报错）。
  29/29 通过。

### 9.7 第二批修复（2026-09-25）

上一轮审查遗留的低优先级项全部处理：

- **spawn 级异常兜底**：`handleSimplifyCommand` 整体 try/catch，git 不在 PATH 等
  spawn 级失败返回 `{ kind: "error" }`，不再裸抛给命令派发层；
- **无首提交仓库（工作区模式）补齐已暂存文件**：`git diff HEAD` 失败回退时，
  原实现只靠 `ls-files --others`（不含 index 文件），`git add` 过但从未提交的
  文件会被漏掉；现先用裸 `git diff --name-status --cached`（index vs 空树）
  补充来源；
- **stdout 截断检测**：`GitResult` 增加 `lossy`；行号 diff 超过 8MB 保留窗口的
  块降级为「行号不可用」（`changedLines: undefined`，提示词侧有现成的
  inspect-diff 兜底文案），不再用截断输出解析出行号范围；
- **CI 卫生**：`ci.yml` / `publish.yml` 改 `npm ci`（lockfile 可复现安装）；
  `ci.yml` 的 push 限定 `main` 分支，消除与 `pull_request` 的重复构建；
- **行号 diff 批量化**：原逐文件 spawn（N+1，Windows 上每次约 50-100ms）改为
  按路径分块（每块 ≤40 个路径，远低于 Windows 32k 命令行上限）一次取多个文件，
  以 `+++ b/<path>` 段归组解析（`parseChangedLinesPerFile`）；`+++` 只在段首生效
  一次，hunk 内新增的 `"+++ ..."` 内容行不会误判；失败的块整体降级，行为与
  原逐文件失败一致；
- **peer 依赖口径**：`@deepseek-ai/schemastery ^3.18.1` 加入 peerDependencies
  （与 dsh-llm 同款「peer 声明 + dependencies 兜底」策略，修正 9.1 提交信息与
  实际清单的偏差）；peer 范围的 prerelease 语义（第二段放行 0.1.1-rc.x）与
  依赖策略在 README「开发」节写明；
- **README**：移除安装示例中的个人绝对路径，改为通用占位；
- **参数解析**：`tokenizeArgs` 引号未闭合直接抛错（经 handler 兜底呈现为
  kind=error），不再静默吞掉剩余输入；有意不支持反斜杠转义（`\` 是 Windows
  路径分隔符）；
- **C-quoted 路径反解码**：`quotepath=off` 只放过非 ASCII，含 `"` / 控制字符的
  路径仍被 git C-quote（`"..."` + `\NNN` 八进制）；新增 `unquoteGitPath` 在
  `--name-status` 清单、`ls-files` 输出与批量 diff 的 `+++` 段三处统一还原
  （未迁移 `-z`：patch 格式的路径渲染不受 `-z` 控制，且此类路径极罕见）；
- 测试 29 → 39：新增引号未闭合（parseArgs / handler）、unquoteGitPath、
  C-quoted 清单解析、按文件归组解析、`+++` 内容行不误判、unborn 仓库暂存+未跟踪、
  lossy 降级（脚本化 subprocess 注入）、批量归组、spawn 抛错兜底十组回归。
  39/39 通过。

## 9.8 代码审查修复（2026-09-30）：重命名行号范围 + 非 BMP 路径

对照源码逐行审查（`npm test` 39/39、`npm run typecheck` 干净的状态下）发现两个
提示词范围锁的缺陷，均已修复并补回归测试，测试 39 → 50。

### 缺陷 1（功能性）：重命名文件被误报为「整个文件都在变更范围」

`addChangedLines` 只把**新路径**交给 pathspec（`git diff --unified=0 HEAD -- renamed.ts`），
git 的 rename 检测拿不到新旧路径配对，于是把重命名降级成「新文件」段，输出
`--- /dev/null` + `+++ b/renamed.ts` + `@@ -0,0 +1,N @@`，整个文件被算作变更行。

实测（8 行文件，`git mv` 后只改第 3 行）：

- 修复前：`changedLines: [{start: 1, end: 8}]` —— 击穿提示词「只改变更行」的范围锁，
  模型可合法重写整个文件；
- 修复后：`changedLines: [{start: 3, end: 3}]`。

`git diff --name-status` 本身正确识别为 `R082`，问题只出在取行号的二次 diff。

修复：

- `ChangedFile` 新增 `oldPath?`（[src/types.ts](src/types.ts)），`parseDiffOutput`
  保留 `--name-status` 的第二个路径（此前被丢弃，只取 `parts[2]`）；
- `addChangedLines` 把新旧路径**成对**加入 pathspec（`Set` 去重），并显式加 `-M`
  开启重命名检测（`diff.<driver>` 等配置可能关掉默认值）；
- 取行号时先按新路径查，退化段（未识别为 rename）回退按旧路径查；
- 抽出 `normalizePath`（反解码 + 正斜杠归一），消除三处重复。

### 缺陷 2（潜在）：`unquoteGitPath` 破坏 BMP 外字符

旧实现按 UTF-16 **码元**索引（`p[i]` + `charCodeAt(0)`），把 emoji / CJK 扩展 B
的代理对拆成两个孤立代理项，各自编码为 U+FFFD：`"😀.ts"` → `"��.ts"`。

当前 Windows 环境**不可达**（`quotepath=off` 下 git 对非 BMP 路径原样裸输出，
不进入 C-quote 分支；唯一会「加引号 + 内含裸非 BMP」的文件名组合需要 `"`，
而 Windows 文件名不允许），但解析器契约内确属错误，Linux/macOS 上可触发。

修复：改为按**码点**切分（`[...p.slice(1, -1)]`），非 ASCII 一律用 `TextEncoder`
编码整个码点。转义序列本身全是 ASCII，按码点索引与按码元索引在转义处理上等价。

### 回归测试（11 组）

- 重命名 ×8：`oldPath` 捕获、C-quoted 新旧路径反解码、单行修改只报 1 行、
  多段修改报两段区间、纯重命名（内容不变）报空区间而非整文件、`--staged` 下同样正确、
  与未跟踪文件并存、变更行范围端到端进入提示词、重命名 diff 段按新路径归组；
- 非 BMP ×2：emoji / CJK 扩展 B 往返、与 C 转义混排、八进制形态不回归、
  无 U+FFFD；多字节与转义组合（八进制边界、`\"`、`\\`、tab）不回归；
- 同步更新 1 组既有用例（`parseDiffOutput` 的 M/A/R/C 断言纳入 `oldPath`）。

验证：两处修复各自**单独回退**后对应用例必然失败（重命名 6 组失败、
非 BMP 1 组失败），确认测试真实钉住缺陷；修复后 50/50 通过。

## 9.9 次要项清理（2026-09-30）：严格索引 / 终止原因分类 / 文档漂移

上一节审查同时记录的三个次要项，本次一并处理，测试 50 → 57。

### 1. 开启 `noUncheckedIndexedAccess`

`tsconfig.json` 的 `noUncheckedIndexedAccess` 由 `false` 改为 `true`。开启后仅暴露
**1 处**错误（`tokenizeArgs` 的 `input[i]`），说明源码本就按防御式风格书写，此前的
关闭属于不必要的宽松。

修复方式不是加 `!` 断言，而是改为按码点迭代（`for (const char of input)`）——
同时消除了「按 UTF-16 码元切分」的同类隐患，与 §9.8 缺陷 2 的处理口径一致。

### 2. 区分「超时」与「取消」

**问题**：`describeGitFailure` 把 `code === null` 一律显示成 `"signal"`，用户无法
分辨是自己按了取消、仓库太大超时、还是进程被杀。`graceMs: 7_000` 也容易被误读成
deadline。

**关键约束**：dsh subprocess seam **刻意不做**超时/取消分类——
其类型注释明确写着「Deliberately carries NO timeout or cancellation classification
（the caller reads the signal it owns to classify causes）」，`SubprocessOutcome` 只有
`exitCode` / `signal`。所以分类责任在插件侧：必须自己持有 deadline。

**修复**：

- 新增 `GIT_TIMEOUT_MS = 30_000` 作为插件自持的 deadline，经
  `AbortSignal.any([callerSignal, timeout])` 合并后交给 seam；
- `GitResult` 扩展 `signal` / `timedOut` / `cancelled` 三个字段；
- `describeGitFailure` 按**取消 > 超时 > 被信号杀死 > 退出码**的优先级出文案：
  `cancelled` / `timed out after 30s` / `killed by SIGKILL` / `code 128`；
- `graceMs` 7s → 2s，并在注释中澄清它只是「终止后收尾/排空管道」的宽限期，不是 deadline。

`AbortSignal.timeout` 的计时器是 unref 的，不会拖住进程退出（实测单次调用后
node 进程总墙钟 210ms，无 30s 滞留）。

### 3. 文档漂移

- MIGRATION §5 的「测试覆盖」清单严重滞后（仍写「参数解析 ×4…」约 17 项，
  实际已 50+），改为按被测对象分组的真实计数，并注明「以 `npm test` 输出为准」；
- §9 变更记录开头补充阅读约定：各条目的测试计数（17/17、22/22、39/39…）是
  **当日验证快照**，不随后续用例增加回改——避免读者把历史记录误读为现状；
- README 功能清单同步补充：重命名新旧路径成对 + `-M`、非 BMP 路径支持、
  终止原因区分（取消 / 超时 30s / 信号 / 退出码）。

### 回归测试（7 组新增）

`runGit` 正常退出、非 0 退出码不误判、已取消标记 `cancelled`、未取消不误报、
非 git 仓库文案含 `code N` 且不出现含糊 `(signal)`、被信号杀死含 `SIGKILL`、
合并 deadline 确实传给 `subprocess.spawn`。

验证：临时副本中把 `describeGitFailure` 退回旧的 `signal`/`code` 两分支后，
「被信号杀死含信号名」用例失败（56 pass / 1 fail），确认测试钉住新分类；
修复后 57/57 通过。`noUncheckedIndexedAccess` 的生效以一个注入的
`xs[0].toUpperCase()` 探针验证（报 TS2532）。

