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
> dsh plugin --profile web add E:\Demo\cli-tools\dsh-simplify
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

## 功能清单（迁移自 pi-simplify）

- git diff 变更检测：`--name-status` 解析（M/A/R/C），重命名/复制取新路径；
- 变更行号提取：`--unified=0` 解析，相邻区间合并，count=0 跳过，纯删除文件降级提示；
- 指定文件模式：显式文件列表按 `--ref`/`--staged` 取行号；
- 回退逻辑：`HEAD` 无结果时回退 `HEAD~1`；
- 提示词：Preserve functionality / Apply project standards / Enhance clarity / Maintain balance
  四条原则 + 变更行范围锁定 + 逐文件修改 + 跑测试 + 总结；
- 无变更提示：不注入消息，直接返回 UI 提示文本。

## 开发

```bash
npm install        # 安装 dependencies（dsh-llm）与 devDependencies（dsh 各 seam 包）
npm run build      # tsc 构建到 lib/
npm run typecheck  # 类型检查
npm test           # 构建 + 功能等价测试（node --test，真实 git 仓库）
```

> 依赖版本与宿主闭包（dsh 0.1.1-rc.2）对齐：`@deepseek-ai/dsh-llm` 为运行时
> 依赖（`createUserMessage`），其余 seam 包为构建期类型依赖（devDependencies）。

## 迁移说明

变更点、API 映射与验证记录见 [MIGRATION.md](./MIGRATION.md)。

## License

MIT（pi-simplify 为 MIT，本插件延续 MIT）。
