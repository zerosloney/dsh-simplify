/**
 * git diff 解析与变更文件收集：自 pi-simplify 迁移（src/git-diff.ts）。
 *
 * 变更点（详见 MIGRATION.md）：
 *  - `pi.exec("git", args, { cwd })` → dsh `ctx.subprocess.spawn(...)`（树级终止、
 *    显式 stdio、graceMs、AbortSignal）；
 *  - `getChangedFiles` 签名增加 `signal` 参数；
 *  - 仅为了让测试可直接覆盖解析器，解析函数由私有改为导出（零行为改动）；
 *  - git 调用统一带 `-c core.quotepath=off`（非 ASCII 路径不被八进制转义），
 *    并对 C-quoted 路径反解码（含 `"` / 控制字符的文件名）；
 *  - 收集 stderr 并透传失败：未知 `--ref`、非 git 仓库等返回 `{ error }`，
 *    不再伪装成「无变更」（无首提交仓库的 `git diff HEAD` 失败仍按预期回退）；
 *  - `--staged --ref=<branch>` 以该分支为基准（`git diff --cached <ref>`）；
 *  - 显式传入的未跟踪文件归类为 added；无首提交仓库用裸 `--cached` 补齐已暂存文件；
 *  - 行号 diff 按路径分块批量化（一次 spawn 取多个文件）；stdout 截断（lossy）
 *    的块降级为「行号不可用」。
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

/** 一次 git 命令的结果：退出码 + 收集的 stdout/stderr 文本。 */
export interface GitResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout 超出保留窗口被截断（头部丢失）：此时解析结果不可信。 */
  readonly lossy: boolean;
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
    // core.quotepath=off：diff/ls-files 原样输出非 ASCII 路径（中文文件名等），
    // 否则默认被八进制转义，后续按该路径取行号的 diff 也匹配不上。
    argv: ["git", "-c", "core.quotepath=off", ...args],
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
  const stdoutRead = handle.collected.stdout?.readFrom(0);
  const stderrRead = handle.collected.stderr?.readFrom(0);
  return {
    code: outcome.exitCode,
    stdout: stdoutRead?.text ?? "",
    stderr: stderrRead?.text ?? "",
    lossy: stdoutRead?.lossy ?? false,
  };
}

function pushUtf8(bytes: number[], ch: string): void {
  const code = ch.charCodeAt(0);
  if (code < 0x80) {
    bytes.push(code);
  } else {
    bytes.push(...Buffer.from(ch, "utf8"));
  }
}

/** git C 转义里「反斜杠 + 字母」对应的控制字符；`\"` 与 `\\` 取字面值。 */
const C_ESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '"': 0x22,
  "\\": 0x5c,
};

/**
 * 反解码 git 的 C-quoted 路径。quotepath=off 只放过非 ASCII；含 `"` 或控制字符的
 * 路径仍会输出成 `"..."` 包裹、`\NNN` 八进制 + C 转义的形式，这里还原为原始路径。
 * 非引号包裹的输入原样返回。
 */
export function unquoteGitPath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;

  const end = p.length - 1;
  const bytes: number[] = [];
  for (let i = 1; i < end; i++) {
    const ch = p[i]!;
    if (ch !== "\\" || i + 1 >= end) {
      pushUtf8(bytes, ch);
      continue;
    }
    const octal = /^[0-7]{3}$/.exec(p.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
      continue;
    }
    const next = p[++i]!;
    const escaped = C_ESCAPES[next];
    if (escaped !== undefined) {
      bytes.push(escaped);
    } else {
      pushUtf8(bytes, next);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** 把一次 git 失败压缩成单行用户可读错误（取 stderr 首个非空行，通常是 fatal 行）。 */
function describeGitFailure(what: string, result: GitResult): string {
  const reason = result.stderr
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const code = result.code === null ? "signal" : `code ${result.code}`;
  return `${what} failed (${code})${reason ? `: ${reason}` : ""}`;
}

/**
 * 归因清单失败的根因：仓库外 `git diff` 会切到 --no-index 模式，其报错
 * （unknown option 等）会掩盖真实原因；rev-parse 失败说明仓库本身不可用，
 * 此时以它为准，否则返回 undefined（保留原命令的 stderr）。
 */
async function repositoryError(
  ctx: Context,
  cwd: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const probe = await runGit(ctx, ["rev-parse", "--git-dir"], cwd, signal);
  return probe.code === 0 ? undefined : describeGitFailure("git rev-parse", probe);
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** 追加一个 hunk 头到区间列表：相邻合并、count=0（纯删除）跳过。 */
function appendHunk(ranges: LineRange[], line: string): void {
  const match = HUNK_RE.exec(line);
  if (!match?.[1]) return;

  const start = Number(match[1]);
  const count = match[2] === undefined ? 1 : Number(match[2]);
  if (count === 0) return;

  const end = start + count - 1;
  const previous = ranges.at(-1);
  if (previous && start <= previous.end + 1) {
    ranges[ranges.length - 1] = { start: previous.start, end: Math.max(previous.end, end) };
  } else {
    ranges.push({ start, end });
  }
}

export function parseChangedLines(stdout: string): LineRange[] {
  const ranges: LineRange[] = [];

  for (const line of stdout.split("\n")) {
    appendHunk(ranges, line);
  }

  return ranges;
}

/**
 * 把一次多文件 diff（`git diff --unified=0 -- path1 path2 ...`）的输出按文件归组。
 * 以 `+++ b/<path>` 行界定文件段（重命名/复制取新路径，`+++ /dev/null` 为整文件
 * 删除，跳过）。`+++` 只在每段开头生效一次，hunk 内新增的 `"+++ ..."` 内容行
 * 不会误判为新文件段。
 */
export function parseChangedLinesPerFile(stdout: string): Map<string, LineRange[]> {
  const result = new Map<string, LineRange[]>();
  let current: LineRange[] | undefined;
  let sawTarget = false;

  for (const line of stdout.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = undefined;
      sawTarget = false;
    } else if (!sawTarget && line.startsWith("+++ ")) {
      sawTarget = true;
      const target = unquoteGitPath(line.slice(4));
      if (target.startsWith("b/") && target.length > 2) {
        current = [];
        result.set(target.slice(2), current);
      } else {
        current = undefined;
      }
    } else if (current) {
      appendHunk(current, line);
    }
  }

  return result;
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
      files.push({ path: unquoteGitPath(rawPath).replace(/\\/g, "/"), status });
    }
  }

  return files;
}

/** 单次 spawn 最多携带的路径数：40 个长路径约 4k 参数，远低于 Windows 32k 命令行上限。 */
const DIFF_CHUNK = 40;

/**
 * 批量取变更行区间：一次 `git diff --unified=0 [--cached] <ref> -- <paths...>`
 * 携带多个路径，按 `+++` 段归组。失败或 stdout 截断（lossy）的块整体降级为
 * 「行号不可用」（提示词侧有现成的 inspect-diff 兜底文案）。
 */
async function addChangedLines(
  ctx: Context,
  cwd: string,
  options: SimplifyOptions,
  files: readonly ChangedFile[],
  ref: string,
  signal?: AbortSignal,
): Promise<ChangedFile[]> {
  const targets = files.filter((f) => f.status !== "added");
  if (targets.length === 0) return [...files];

  const args = ["diff", "--unified=0", "--no-ext-diff"];
  if (options.staged) {
    // `git diff --cached <ref>`：暂存区 vs 指定基准。默认基准省略 ref（等价
    // `--cached HEAD`，且在无首提交的仓库里裸 --cached 依然可用）。
    args.push("--cached");
    if (ref !== "HEAD") args.push(ref);
  } else {
    args.push(ref);
  }

  const changed = new Map<string, readonly LineRange[]>();
  for (let i = 0; i < targets.length; i += DIFF_CHUNK) {
    const chunk = targets.slice(i, i + DIFF_CHUNK);
    const result = await runGit(ctx, [...args, "--", ...chunk.map((f) => f.path)], cwd, signal);
    if (result.code !== 0 || result.lossy) continue;
    const perFile = parseChangedLinesPerFile(result.stdout);
    for (const file of chunk) {
      // 无输出段（无改动）与纯删除文件一致：空区间
      changed.set(file.path, perFile.get(file.path) ?? []);
    }
  }

  return files.map((f) => {
    const lines = changed.get(f.path);
    return lines ? { ...f, changedLines: lines } : f;
  });
}

export async function getChangedFiles(
  ctx: Context,
  cwd: string,
  options: SimplifyOptions,
  signal?: AbortSignal,
): Promise<ChangedFilesResult> {
  if (options.files.length > 0) {
    // 先甄别显式文件里的未跟踪新文件（diff 输出为空不代表该文件没有内容可评审）
    const untracked = await runGit(
      ctx,
      ["ls-files", "--others", "--exclude-standard", "--", ...options.files],
      cwd,
      signal,
    );
    if (untracked.code !== 0) {
      return { files: [], error: describeGitFailure("git ls-files", untracked) };
    }
    const untrackedPaths = new Set(
      untracked.stdout.split("\n").map((line) => unquoteGitPath(line.trim())).filter(Boolean),
    );
    const files = options.files.map((p) => ({
      path: p.replace(/\\/g, "/"),
      status: untrackedPaths.has(p.replace(/\\/g, "/")) ? ("added" as const) : ("modified" as const),
    }));
    const withLines = await addChangedLines(ctx, cwd, options, files, options.ref, signal);
    return { files: withLines };
  }

  const args = ["diff", "--name-status"];
  if (options.staged) {
    args.push("--cached");
    if (options.ref !== "HEAD") args.push(options.ref);
  } else {
    args.push(options.ref);
  }

  const result = await runGit(ctx, args, cwd, signal);
  let files: ChangedFile[] = [];
  let headDiffFailed = false;
  if (result.code === 0) {
    files = parseDiffOutput(result.stdout);
  } else if (!options.staged && options.ref === "HEAD") {
    // 默认的 `git diff HEAD` 在无首提交的仓库会失败：属预期，交给补充/回退路径
    headDiffFailed = true;
  } else {
    // 显式指定的 ref 失败（拼错分支等）或 --cached 失败：报错而不是伪装成「无变更」
    const rootCause = await repositoryError(ctx, cwd, signal);
    return { files: [], error: rootCause ?? describeGitFailure("git diff", result) };
  }

  // 工作区模式（非 staged 且对比 HEAD 时）检测未跟踪的新文件
  if (!options.staged && options.ref === "HEAD") {
    if (headDiffFailed) {
      // 无首提交：`git diff HEAD` 不可用；用裸 --cached（index vs 空树）补齐已暂存文件，
      // 否则 `git add` 过但从未提交的文件会被漏掉而误报「无变更」。
      const stagedList = await runGit(ctx, ["diff", "--name-status", "--cached"], cwd, signal);
      if (stagedList.code === 0) {
        files = parseDiffOutput(stagedList.stdout);
      }
    }
    const untracked = await runGit(ctx, ["ls-files", "--others", "--exclude-standard"], cwd, signal);
    if (untracked.code === 0 && untracked.stdout.trim()) {
      const existingPaths = new Set(files.map((f) => f.path));
      for (const line of untracked.stdout.split("\n")) {
        const p = unquoteGitPath(line.trim()).replace(/\\/g, "/");
        if (p && !existingPaths.has(p)) {
          files.push({ path: p, status: "added" });
          existingPaths.add(p);
        }
      }
    } else if (untracked.code !== 0 && headDiffFailed) {
      // diff 与 ls-files 双双失败：几乎可以断定不是 git 仓库
      return { files: [], error: describeGitFailure("git ls-files", untracked) };
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
