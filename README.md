# dsh-simplify

DeepSeek Harness（dsh）插件：评审最近改动的代码，提升清晰度、一致性与可维护性。
由 Pi 扩展 **pi-simplify**（MIT）迁移而来，功能等价。

## 安装

```bash
# 在目标 profile 中安装本插件（npm 已发布，包名 dsh-simplify）
dsh plugin --profile web add dsh-simplify
```

> 本地开发版安装（源码路径，需先 `npm install && npm run build`）：
> ```bash
> dsh plugin --profile web add <本插件仓库路径>
> ```

> 版本要求：Node >= 22.19；宿主 dsh 0.1.1-rc.2 及以上（依赖 `dsh-llm ^0.1.1-rc.2`）。

> 注意：`dsh plugin add` 只更新 profile 清单，**不会热加载到已运行的 dsh web 进程**，
> 需重启 dsh web 后 `/simplify` 才会注册生效。

## 用法

| 命令 | 作用 |
| --- | --- |
| `/simplify` | 评审所有未提交改动（工作区 diff） |
| `/simplify --staged` | 只评审已暂存改动 |
| `/simplify src/foo.ts src/bar.ts` | 指定文件 |
| `/simplify --ref=main` | 对比指定分支的改动 |

执行后，插件把「变更文件 + 变更行范围 + 四条简化原则」作为用户消息注入
当前 agent 会话（`next-turn`），模型随即按约束在变更行范围内完成简化并跑测试。

## 功能清单

- **git diff 变更检测**：`--name-status` 解析（M/A/R/C），重命名/复制取新路径；工作区模式自动识别未跟踪新增文件（untracked）；新仓库（无首提交）也能列出暂存区与未跟踪的新文件；显式指定的未跟踪文件同样识别为整文件在范围内；
- **变更行号提取**：`--unified=0` 解析，相邻区间合并，count=0 跳过，纯删除文件降级提示；按路径分块批量提取（一次 git 调用取多个文件）；输出超限截断时降级为「行号不可用」；
- **参数与路径解析**：支持单双引号包裹的带空格路径与参数（如 `--ref="feature branch"`、`"dir with space/a.ts"`，引号未闭合直接报错），自动规范化 Windows 路径；非 ASCII 文件名（中文等）与含特殊字符的路径原样支持（`core.quotepath=off` + C-quote 反解码）；
- **指定文件模式**：显式文件列表按 `--ref`/`--staged` 取行号；
- **回退与透明提示**：`HEAD` 无结果时自动回退 `HEAD~1`，并在 UI 状态与提示词中显式标注回退来源；
- **错误透传**：未知 `--ref`、非 git 仓库、git 不在 PATH 等失败直接以错误提示呈现（含 git 的 fatal 信息），不与「无变更」混淆；
- **提示词**：Preserve functionality / Apply project standards / Enhance clarity / Maintain balance
  四条原则 + 变更行范围锁定 + 逐文件修改 + 跑测试 + 总结；
- **无变更提示**：不注入消息，直接返回 UI 提示文本。

## 开发

```bash
npm install        # 安装 dependencies（dsh-llm）与 devDependencies（dsh 各 seam 包）
npm run build      # tsc 构建到 lib/
npm run typecheck  # 类型检查
npm test           # 构建 + 功能等价测试（node --test，真实 git 仓库）
```

> 依赖策略：运行时 peer 契约为 `@deepseek-ai/cordis ^4.0.1`、`@deepseek-ai/dsh-llm
> >=0.1.0-rc.7 <0.2.0 || >=0.1.1-rc.1 <0.2.0`、`@deepseek-ai/schemastery ^3.18.1`，
> 由宿主提供；`dependencies` 里的同名包仅作宿主缺失时的兜底副本，npm 去重后与
> 宿主同实例。peer 范围的第二段 `>=0.1.1-rc.1` 是有意为之：npm semver 只在范围
> 端点同为 prerelease 且版本元组相同时才匹配 prerelease，第一段覆盖 0.1.0-rc.7+，
> 第二段放行 0.1.1-rc.x。构建期类型依赖（dsh-commands / dsh-session /
> dsh-subprocess 等）在 devDependencies，与宿主闭包版本对齐。

## 发布（本机）

GitHub Actions CI（`.github/workflows/ci.yml`，push/PR 自动跑 ubuntu/windows × node 22 测试）
继续保留；仅移除发布 workflow（`publish.yml`），改为本机发布：

```bash
npm run publish:local            # patch（默认）
npm run publish:local -- minor   # minor
npm run publish:local -- major   # major
```

脚本（`scripts/publish.mjs`）流程：

1. 校验 git 工作区干净（`npm version` 会创建 commit + tag，要求干净）；
2. `npm version <bump>` —— 自动触发 `version` 钩子跑 `npm test`，
   测试通过后才提交并打 `v*` 标签；
3. `npm publish` 发布到 npm（`prepublishOnly` 钩子保证 `lib/` 为最新构建）；
4. 提示手动推送：`git push && git push --tags`（本机发布不代替推送）。

> 前置：本机已登录 npm（`npm whoami` 可验证）；账号开启 2FA 时按提示输入 OTP。
> 如果 git 工作区有未提交改动，脚本会中止并列出待处理文件。

## 迁移说明

变更点、API 映射与验证记录见 [MIGRATION.md](./MIGRATION.md)。

## License

MIT（pi-simplify 为 MIT，本插件延续 MIT）。
