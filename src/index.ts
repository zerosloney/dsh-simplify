/**
 * dsh-simplify 插件入口：注册 /simplify 命令。
 *
 * 架构：Cordis 插件（Service 形态）。依赖 harness 的 `commands`（命令注册表）
 * 与 `subprocess`（执行 git）两个核心 seam；无 Web 面。
 *
 * 由 pi-simplify 迁移而来（index.ts 原为
 * `pi.registerCommand("simplify", { description, handler })`）。
 */

import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { COMMAND_NAME, handleSimplifyCommand } from "./simplify-command.js";

/** 插件配置：当前无配置项（保留 schema 以便后续扩展，与 dsh 插件约定一致）。 */
export interface Config {}

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** /simplify 命令服务（pi-simplify 迁移）。 */
    simplify: SimplifyService;
  }
}

export default class SimplifyService extends Service {
  static inject = ["commands", "subprocess"];

  static Config = z.object({});

  constructor(ctx: Context, config: Config) {
    super(ctx, "simplify");
    void config;

    ctx.commands.register({
      name: COMMAND_NAME,
      description:
        "Review recently changed code for clarity, consistency, and maintainability improvements",
      input: {
        hint: "[--staged] [--ref=<branch>] [<file> ...]",
      },
      handler: (invocation) => handleSimplifyCommand(invocation, ctx),
    });
  }
}
