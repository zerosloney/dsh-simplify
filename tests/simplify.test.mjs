// dsh-simplify 功能等价测试：对照 pi-simplify 功能清单逐项验证。
// 运行：npm test（先 build，再 node --test tests/）
// 覆盖：参数解析 / 提示词构建 / git diff 解析 / 变更文件收集（真实 git）/ 命令处理（inbox 注入）

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseArgs, handleSimplifyCommand } from "../lib/simplify-command.js";
import { buildSimplifyPrompt } from "../lib/prompt-builder.js";
import { parseDiffOutput, parseChangedLines, getChangedFiles } from "../lib/git-diff.js";

// ---------- 测试替身 ----------

/** 用 node:child_process 实现的最小 subprocess seam（真实跑 git）。 */
function fakeSubprocess() {
  return {
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      const done = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve({ exitCode: code }));
      });
      return {
        pid: child.pid,
        done,
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        collected: {
          stdout: { readFrom: () => ({ text: out, nextOffset: out.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: err, nextOffset: err.length, lossy: false }) },
        },
      };
    },
  };
}

/** 最小 cordis 风格 ctx：只有插件用到的 subprocess seam。 */
function fakeCtx() {
  return { subprocess: fakeSubprocess() };
}

/** 建一个真实 git 临时仓库。 */
function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-simplify-test-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  return { dir, git };
}

function fakeInvocation(overrides = {}) {
  const appended = [];
  const invocation = {
    commandId: "cmd-test",
    agent: {
      session: { header: { cwd: undefined } },
      inbox: {
        append: (target, message) => { appended.push({ target, message }); },
      },
    },
    rawInput: "",
    attachments: [],
    signal: undefined,
    ...overrides,
  };
  return { invocation, appended };
}

// ---------- 1. 参数解析（与 pi-simplify parseArgs 行为一致） ----------

test("parseArgs: 默认值", () => {
  assert.deepEqual(parseArgs(""), { files: [], ref: "HEAD", staged: false });
  assert.deepEqual(parseArgs("   "), { files: [], ref: "HEAD", staged: false });
});

test("parseArgs: --staged", () => {
  assert.deepEqual(parseArgs("--staged"), { files: [], ref: "HEAD", staged: true });
});

test("parseArgs: --ref 与文件", () => {
  assert.deepEqual(parseArgs("--ref=main src/a.ts"), {
    files: ["src/a.ts"], ref: "main", staged: false,
  });
});

test("parseArgs: 混合输入", () => {
  assert.deepEqual(parseArgs("a.ts --staged --ref=dev b.ts"), {
    files: ["a.ts", "b.ts"], ref: "dev", staged: true,
  });
});

// ---------- 2. 提示词构建（逐字对照 pi-simplify buildSimplifyPrompt） ----------

test("buildSimplifyPrompt: 变更行范围与原则", () => {
  const prompt = buildSimplifyPrompt([
    { path: "src/foo.ts", status: "modified", changedLines: [{ start: 12, end: 30 }, { start: 45, end: 45 }] },
  ]);
  assert.match(prompt, /src\/foo\.ts \(modified; changed lines: 12-30, 45\)/);
  assert.match(prompt, /\*\*Preserve functionality\*\*/);
  assert.match(prompt, /\*\*Maintain balance\*\*/);
  assert.match(prompt, /Do NOT add new features, change public APIs/);
  assert.match(prompt, /Run existing tests|run existing tests/);
});

test("buildSimplifyPrompt: 新增文件整文件在范围内", () => {
  const prompt = buildSimplifyPrompt([{ path: "src/new.ts", status: "added" }]);
  assert.match(prompt, /src\/new\.ts \(added; entire file is in scope\)/);
});

test("buildSimplifyPrompt: 纯删除文件提示", () => {
  const prompt = buildSimplifyPrompt([
    { path: "src/gone.ts", status: "modified", changedLines: [] },
  ]);
  assert.match(prompt, /src\/gone\.ts \(modified; deletions only — no current lines to simplify\)/);
});

// ---------- 3. git diff 解析 ----------

test("parseDiffOutput: M/A/R/C 状态与重命名新路径", () => {
  const files = parseDiffOutput("M\tfoo.ts\nA\tbar.ts\nR100\told.ts\tnew.ts\nC50\tsrc/x.ts\tsrc/y.ts\n");
  assert.deepEqual(files, [
    { path: "foo.ts", status: "modified" },
    { path: "bar.ts", status: "added" },
    { path: "new.ts", status: "renamed" },
    { path: "src/y.ts", status: "copied" },
  ]);
});

test("parseDiffOutput: 忽略未知状态与空行", () => {
  assert.deepEqual(parseDiffOutput("D\tgone.ts\n\n"), []);
});

test("parseChangedLines: 行号区间与相邻合并", () => {
  // 不相邻的两个 hunk 各自保留（10-14 与 30）
  assert.deepEqual(parseChangedLines("@@ -1,3 +10,5 @@\n@@ -1 +30,1 @@\n"), [
    { start: 10, end: 14 },
    { start: 30, end: 30 },
  ]);
  // 相邻区间合并
  assert.deepEqual(parseChangedLines("@@ -1 +1 @@\n@@ -1 +2 @@\n"), [{ start: 1, end: 2 }]);
  // count=0 跳过
  assert.deepEqual(parseChangedLines("@@ -1 +16,0 @@\n"), []);
});

// ---------- 4. 变更文件收集（真实 git 仓库，验证 subprocess 适配层） ----------

test("getChangedFiles: 未提交改动（工作区）", async () => {
  const { dir, git } = makeRepo();
  try {
    writeFileSync(path.join(dir, "a.ts"),
      Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n") + "\n");
    git("add", "a.ts");
    git("commit", "-q", "-m", "init");
    // 修改 a.ts（追加两行）并新增 b.ts（加入暂存区使其进入 diff 视野；
    // 完全未跟踪的文件 git diff 不展示——与 pi-simplify 原版行为一致）
    writeFileSync(path.join(dir, "a.ts"),
      Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n") + "\nline11\nline12\n");
    writeFileSync(path.join(dir, "b.ts"), "x\n");
    git("add", "b.ts");

    const files = await getChangedFiles(fakeCtx(), dir, { files: [], ref: "HEAD", staged: false });
    const a = files.find((f) => f.path === "a.ts");
    const b = files.find((f) => f.path === "b.ts");
    assert.ok(a, "a.ts 应出现在变更清单中");
    assert.equal(a.status, "modified");
    assert.deepEqual(a.changedLines, [{ start: 11, end: 12 }]);
    assert.ok(b, "b.ts 应出现在变更清单中");
    assert.equal(b.status, "added");
    assert.equal(b.changedLines, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getChangedFiles: --staged 只取暂存区", async () => {
  const { dir, git } = makeRepo();
  try {
    writeFileSync(path.join(dir, "a.ts"), "v1\n");
    git("add", "a.ts");
    git("commit", "-q", "-m", "init");
    writeFileSync(path.join(dir, "a.ts"), "v1\nv2\n");
    git("add", "a.ts");
    writeFileSync(path.join(dir, "b.ts"), "unstaged\n");

    const files = await getChangedFiles(fakeCtx(), dir, { files: [], ref: "HEAD", staged: true });
    assert.deepEqual(files.map((f) => f.path).sort(), ["a.ts"]);
    assert.deepEqual(files.find((f) => f.path === "a.ts").changedLines, [{ start: 2, end: 2 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getChangedFiles: 指定文件与回退分支", async () => {
  const { dir, git } = makeRepo();
  try {
    writeFileSync(path.join(dir, "a.ts"), "v1\n");
    git("add", "a.ts");
    git("commit", "-q", "-m", "init");
    writeFileSync(path.join(dir, "a.ts"), "v1\nv2\n");
    writeFileSync(path.join(dir, "c.ts"), "c\n");

    const files = await getChangedFiles(fakeCtx(), dir,
      { files: ["a.ts"], ref: "HEAD", staged: false });
    assert.deepEqual(files.map((f) => f.path), ["a.ts"]);
    assert.deepEqual(files[0].changedLines, [{ start: 2, end: 2 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getChangedFiles: 干净仓库返回空", async () => {
  const { dir, git } = makeRepo();
  try {
    writeFileSync(path.join(dir, "a.ts"), "v1\n");
    git("add", "a.ts");
    git("commit", "-q", "-m", "init");
    const files = await getChangedFiles(fakeCtx(), dir, { files: [], ref: "HEAD", staged: false });
    assert.deepEqual(files, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 5. 命令处理（inbox 注入，对应 pi sendUserMessage followUp） ----------

test("handleSimplifyCommand: 无变更时返回提示文本", async () => {
  const { dir, git } = makeRepo();
  try {
    writeFileSync(path.join(dir, "a.ts"), "v1\n");
    git("add", "a.ts");
    git("commit", "-q", "-m", "init");
    const { invocation, appended } = fakeInvocation({
      rawInput: "",
      agent: { session: { header: { cwd: dir } }, inbox: { append: (target, message) => appended.push({ target, message }) } },
    });
    const result = await handleSimplifyCommand(invocation, fakeCtx());
    assert.equal(result.kind, "success");
    assert.match(result.text, /No changed files found/);
    assert.equal(appended.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handleSimplifyCommand: 有变更时注入 next-turn 用户消息", async () => {
  const { dir, git } = makeRepo();
  try {
    writeFileSync(path.join(dir, "a.ts"), "line1\nline2\n");
    git("add", "a.ts");
    git("commit", "-q", "-m", "init");
    writeFileSync(path.join(dir, "a.ts"), "line1\nline2\nline3\n");

    const { invocation, appended } = fakeInvocation({
      rawInput: "",
      agent: { session: { header: { cwd: dir } }, inbox: { append: (target, message) => appended.push({ target, message }) } },
    });
    const result = await handleSimplifyCommand(invocation, fakeCtx());
    assert.equal(result.kind, "success");
    assert.equal(appended.length, 1);
    assert.equal(appended[0].target, "next-turn");
    const msg = appended[0].message;
    assert.equal(msg.role, "user");
    assert.equal(msg.content[0].type, "text");
    assert.match(msg.content[0].text, /Review the following recently changed files/);
    assert.match(msg.content[0].text, /a\.ts \(modified; changed lines: 3\)/);
    assert.equal(msg.source.kind, "plugin");
    assert.equal(msg.source.plugin, "dsh-simplify");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handleSimplifyCommand: 会话无 cwd 时回落 process.cwd()", async () => {
  // 无 header.cwd：getChangedFiles 在 process.cwd() 上跑，通常无未提交改动 →
  // 返回"无变更"提示而非抛错。
  const { invocation, appended } = fakeInvocation({ rawInput: "" });
  const result = await handleSimplifyCommand(invocation, fakeCtx());
  assert.equal(result.kind, "success");
  assert.match(result.text, /No changed files found/);
  assert.equal(appended.length, 0);
});
