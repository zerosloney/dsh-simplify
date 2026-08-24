/**
 * git diff 解析与变更文件收集：自 pi-simplify 迁移（src/git-diff.ts）。
 *
 * 变更点（详见 MIGRATION.md）：
 *  - `pi.exec("git", args, { cwd })` → dsh `ctx.subprocess.spawn(...)`（树级终止、
 *    显式 stdio、graceMs、AbortSignal）；
 *  - `getChangedFiles` 签名增加 `signal` 参数；
 *  - 仅为了让测试可直接覆盖解析器，`parseDiffOutput` / `parseChangedLines`
 *    由私有改为导出（零行为改动）。
 */

import type { Context } from "@deepseek-ai/cordis";
// 引入 subprocess seam 的类型声明（含对 cordis Context 的模块增强：ctx.subprocess）。
import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import type { ChangedFile, ChangedFilesResult, LineRange, SimplifyOptions } from "./types.js";

const STATUS_MAP: Record<string, ChangedFile["status"]> = {
  M: "modified",
  A: "added",
  R: "renamed",
  C: "copied",
};

/** 一次 git 命令的结果：退出码 + 收集的 stdout 文本。 */
export interface GitResult {
  readonly code: number | null;
  readonly stdout: string;
}

/**
 * 通过 dsh subprocess seam 执行一次 git 命令。
 * 收集 stdout/stderr（有界内存，保留尾部），异常或退出码非 0 时
 * 由调用方决定如何处置；spawn 级失败会抛出。
 */
export async function runGit(
  ctx: Context,
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<GitResult> {
  const handle = ctx.subprocess.spawn({
    argv: ["git", ...args],
    cwd,
    stdio: {
      stdin: "ignore",
      stdout: { maxBytes: 8 * 1024 * 1024 },
      stderr: { maxBytes: 1024 * 1024 },
    },
    graceMs: 7_000,
    signal,
  });
  const outcome = await handle.done;
  const stdout = handle.collected.stdout?.readFrom(0).text ?? "";
  return { code: outcome.exitCode, stdout };
}

export function parseDiffOutput(stdout: string): ChangedFile[] {
  const files: ChangedFile[] = [];

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;

    const parts = line.split("\t");
    const statusCode = parts[0]?.[0];
    if (!statusCode) continue;

    const status = STATUS_MAP[statusCode];
    if (!status) continue;

    // Renamed (R100\told\tnew) and copied (C100\told\tnew) have two paths; use the new one.
    const rawPath = (status === "renamed" || status === "copied") ? parts[2] : parts[1];
    if (rawPath) {
      files.push({ path: rawPath.replace(/\\/g, "/"), status });
    }
  }

  return files;
}

export function parseChangedLines(stdout: string): LineRange[] {
  const ranges: LineRange[] = [];

  for (const line of stdout.split("\n")) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match?.[1]) continue;

    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count === 0) continue;

    const end = start + count - 1;
    const previous = ranges.at(-1);
    if (previous && start <= previous.end + 1) {
      ranges[ranges.length - 1] = { start: previous.start, end: Math.max(previous.end, end) };
    } else {
      ranges.push({ start, end });
    }
  }

  return ranges;
}

function diffArgs(
  options: SimplifyOptions,
  ref: string,
  path: string,
): string[] {
  const args = ["diff", "--unified=0", "--no-ext-diff"];
  if (options.staged && ref !== "HEAD~1") {
    args.push("--cached");
  } else {
    args.push(ref);
  }
  args.push("--", path.replace(/\\/g, "/"));
  return args;
}

async function addChangedLines(
  ctx: Context,
  cwd: string,
  options: SimplifyOptions,
  files: readonly ChangedFile[],
  ref: string,
  signal?: AbortSignal,
): Promise<ChangedFile[]> {
  return Promise.all(files.map(async (file) => {
    if (file.status === "added") return file;

    const result = await runGit(ctx, diffArgs(options, ref, file.path), cwd, signal);
    return result.code === 0
      ? { ...file, changedLines: parseChangedLines(result.stdout) }
      : file;
  }));
}

export async function getChangedFiles(
  ctx: Context,
  cwd: string,
  options: SimplifyOptions,
  signal?: AbortSignal,
): Promise<ChangedFilesResult> {
  if (options.files.length > 0) {
    const files = options.files.map((p) => ({
      path: p.replace(/\\/g, "/"),
      status: "modified" as const,
    }));
    const withLines = await addChangedLines(ctx, cwd, options, files, options.ref, signal);
    return { files: withLines };
  }

  const args = ["diff", "--name-status"];
  if (options.staged) {
    args.push("--cached");
  } else {
    args.push(options.ref);
  }

  const result = await runGit(ctx, args, cwd, signal);
  let files: ChangedFile[] = [];
  if (result.code === 0) {
    files = parseDiffOutput(result.stdout);
  }

  // 工作区模式（非 staged 且对比 HEAD 时）检测未跟踪的新文件
  if (!options.staged && options.ref === "HEAD") {
    const untracked = await runGit(ctx, ["ls-files", "--others", "--exclude-standard"], cwd, signal);
    if (untracked.code === 0 && untracked.stdout.trim()) {
      const existingPaths = new Set(files.map((f) => f.path));
      for (const line of untracked.stdout.split("\n")) {
        const p = line.trim().replace(/\\/g, "/");
        if (p && !existingPaths.has(p)) {
          files.push({ path: p, status: "added" });
          existingPaths.add(p);
        }
      }
    }
  }

  if (files.length > 0) {
    const withLines = await addChangedLines(ctx, cwd, options, files, options.ref, signal);
    return { files: withLines };
  }

  // Fallback: diff against previous commit
  if (!options.staged && options.ref === "HEAD") {
    const fallback = await runGit(ctx, ["diff", "--name-status", "HEAD~1"], cwd, signal);
    if (fallback.code === 0) {
      const fallbackFiles = parseDiffOutput(fallback.stdout);
      if (fallbackFiles.length > 0) {
        const withLines = await addChangedLines(ctx, cwd, options, fallbackFiles, "HEAD~1", signal);
        return { files: withLines, fallbackRef: "HEAD~1" };
      }
    }
  }

  return { files: [] };
}

