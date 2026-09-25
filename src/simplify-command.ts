/**
 * /simplify 命令处理：自 pi-simplify 迁移（src/simplify-command.ts）。
 *
 * 变更点（详见 MIGRATION.md）：
 *  - `ctx.cwd`（Pi 会话工作目录）→ `invocation.agent.session.header?.cwd ?? process.cwd()`；
 *  - `ctx.ui.notify(msg, "info")` → 返回 `{ kind: "success", text }`（CommandResult
 *    由 dsh UI 适配器直接渲染，不进模型历史）；
 *  - `pi.sendUserMessage(prompt, { deliverAs: "followUp" })` →
 *    `agent.inbox.append("next-turn", createUserMessage({...}))`（持久化 inbox splice，
 *    唤醒驱动器在下一轮消费）；
 *  - 命令注册由 `pi.registerCommand("simplify", ...)` 改为 dsh
 *    `ctx.commands.register({ name: "simplify", ... })`。
 */

import type { Context } from "@deepseek-ai/cordis";
import type { CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { getChangedFiles } from "./git-diff.js";
import { buildSimplifyPrompt } from "./prompt-builder.js";
import type { SimplifyOptions } from "./types.js";

export const COMMAND_NAME = "simplify";

/**
 * 将命令行输入拆分为 token，支持双引号与单引号包裹的带空格参数。
 * 有意不支持反斜杠转义：`\` 在 Windows 路径里是分隔符（parseArgs 随后统一
 * 归一为 `/`）；引号未闭合直接抛错，避免静默吞掉剩余输入。
 */
export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inDouble = false;
  let inSingle = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (char === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (/\s/.test(char) && !inDouble && !inSingle) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (inDouble || inSingle) {
    throw new Error("Unclosed quote in command input");
  }
  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

export function parseArgs(args: string): SimplifyOptions {
  const tokens = tokenizeArgs(args.trim());
  const files: string[] = [];
  let ref = "HEAD";
  let staged = false;

  for (const token of tokens) {
    if (token === "--staged") {
      staged = true;
    } else if (token.startsWith("--ref=")) {
      let r = token.slice("--ref=".length);
      if ((r.startsWith('"') && r.endsWith('"')) || (r.startsWith("'") && r.endsWith("'"))) {
        r = r.slice(1, -1);
      }
      ref = r;
    } else {
      let file = token;
      if ((file.startsWith('"') && file.endsWith('"')) || (file.startsWith("'") && file.endsWith("'"))) {
        file = file.slice(1, -1);
      }
      files.push(file.replace(/\\/g, "/"));
    }
  }

  return { files, ref, staged };
}

/** 取接收命令的 agent 会话工作目录；无目录委派时回落进程 cwd。 */
function sessionCwd(invocation: CommandInvocation): string {
  return invocation.agent.session.header?.cwd ?? process.cwd();
}

export async function handleSimplifyCommand(
  invocation: CommandInvocation,
  ctx: Context,
): Promise<CommandResult> {
  try {
    const options = parseArgs(invocation.rawInput);
    const cwd = sessionCwd(invocation);
    const { files, fallbackRef, error } = await getChangedFiles(ctx, cwd, options, invocation.signal);

    if (error) {
      return { kind: "error", text: `Failed to collect changed files: ${error}` };
    }

    if (files.length === 0) {
      return {
        kind: "success",
        text: "No changed files found. Specify file paths or make some changes first.",
      };
    }

    const prompt = buildSimplifyPrompt(files, fallbackRef);
    invocation.agent.inbox.append("next-turn", createUserMessage({
      content: [{ type: "text", text: prompt }],
      source: { kind: "plugin", plugin: "dsh-simplify" },
    }));

    const fallbackNote = fallbackRef ? ` (fallback: comparing previous commit ${fallbackRef})` : "";
    return {
      kind: "success",
      text: `Simplify review queued for ${files.length} changed file(s)${fallbackNote}.`,
    };
  } catch (err) {
    // spawn 级失败（git 不在 PATH 等）与参数解析抛错在此兜底为可读的命令错误
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", text: `Failed to run simplify: ${message}` };
  }
}

