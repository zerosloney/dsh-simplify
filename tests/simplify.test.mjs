// dsh-simplify 功能等价测试：对照 pi-simplify 功能清单逐项验证。
// 运行：npm test（先 build，再 node --test tests/）
// 覆盖：参数解析 / 提示词构建 / git diff 解析 / 变更文件收集（真实 git）/ 命令处理（inbox 注入）

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseArgs, tokenizeArgs, handleSimplifyCommand } from "../lib/simplify-command.js";
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

// ---------- 1. 参数解析 ----------

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

test("parseArgs: 引号包裹的带空格路径与 ref", () => {
  assert.deepEqual(parseArgs(`"src/my file.ts" '--ref=feature/cool test' "lib/other dir/b.ts"`), {
    files: ["src/my file.ts", "lib/other dir/b.ts"],
    ref: "feature/cool test",
    staged: false,
  });
  assert.deepEqual(parseArgs(`--ref="feature branch" src\\foo\\bar.ts`), {
    files: ["src/foo/bar.ts"],
    ref: "feature branch",
    staged: false,
  });
});

// ---------- 2. 提示词构建 ----------

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

test("buildSimplifyPrompt: 支持 refNote 标注文案", () => {
  const prompt = buildSimplifyPrompt(
    [{ path: "src/foo.ts", status: "modified", changedLines: [{ start: 1, end: 2 }] }],
    "HEAD~1",
  );
  assert.match(prompt, /Review the following files changed in HEAD~1 and apply simplification improvements\./);
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
    // 修改 a.ts（追加两行）并新增 b.ts（加入暂存区使其进入 diff 视野）
    writeFileSync(path.join(dir, "a.ts"),
      Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n") + "\nline11\nline12\n");
    writeFileSync(path.join(dir, "b.ts"), "x\n");
    git("add", "b.ts");

    const { files, fallbackRef } = await getChangedFiles(fakeCtx(), dir, { files: [], ref: "HEAD", staged: false });
    assert.equal(fallbackRef, undefined);
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

test("getChangedFiles: 检测未跟踪的新文件（untracked）", async () => {
  const { dir, git } = makeRepo();
  try {
    writeFileSync(path.join(dir, "init.ts"), "initial\n");
    git("add", "init.ts");
    git("commit", "-q", "-m", "init");

    // 新建文件但未 git add
    writeFileSync(path.join(dir, "untracked.ts"), "console.log('untracked');\n");

    const { files, fallbackRef } = await getChangedFiles(fakeCtx(), dir, { files: [], ref: "HEAD", staged: false });
    assert.equal(fallbackRef, undefined);
    const untracked = files.find((f) => f.path === "untracked.ts");
    assert.ok(untracked, "未跟踪的新文件应被识别为 added");
    assert.equal(untracked.status, "added");
    assert.equal(untracked.changedLines, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getChangedFiles: --staged 只取暂存区（忽略 untracked）", async () => {
  const { dir, git } = makeRepo();
  try {
    writeFileSync(path.join(dir, "a.ts"), "v1\n");
    git("add", "a.ts");
    git("commit", "-q", "-m", "init");
    writeFileSync(path.join(dir, "a.ts"), "v1\nv2\n");
    git("add", "a.ts");
    writeFileSync(path.join(dir, "b.ts"), "unstaged\n");

    const { files } = await getChangedFiles(fakeCtx(), dir, { files: [], ref: "HEAD", staged: true });
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

    const { files } = await getChangedFiles(fakeCtx(), dir,
      { files: ["a.ts"], ref: "HEAD", staged: false });
    assert.deepEqual(files.map((f) => f.path), ["a.ts"]);
    assert.deepEqual(files[0].changedLines, [{ start: 2, end: 2 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getChangedFiles: 干净仓库无上一提交时返回空", async () => {
  const { dir, git } = makeRepo();
  try {
    writeFileSync(path.join(dir, "a.ts"), "v1\n");
    git("add", "a.ts");
    git("commit", "-q", "-m", "init");
    const { files, fallbackRef } = await getChangedFiles(fakeCtx(), dir, { files: [], ref: "HEAD", staged: false });
    assert.deepEqual(files, []);
    assert.equal(fallbackRef, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getChangedFiles: 干净工作区回退到上一条提交 HEAD~1", async () => {
  const { dir, git } = makeRepo();
  try {
    writeFileSync(path.join(dir, "a.ts"), "v1\n");
    git("add", "a.ts");
    git("commit", "-q", "-m", "init");

    writeFileSync(path.join(dir, "a.ts"), "v1\nv2\n");
    git("add", "a.ts");
    git("commit", "-q", "-m", "second commit");

    const { files, fallbackRef } = await getChangedFiles(fakeCtx(), dir, { files: [], ref: "HEAD", staged: false });
    assert.equal(fallbackRef, "HEAD~1");
    assert.equal(files.length, 1);
    assert.equal(files[0].path, "a.ts");
    assert.deepEqual(files[0].changedLines, [{ start: 2, end: 2 }]);
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

test("handleSimplifyCommand: 回退 HEAD~1 时提示文本包含 fallback 说明", async () => {
  const { dir, git } = makeRepo();
  try {
    writeFileSync(path.join(dir, "a.ts"), "v1\n");
    git("add", "a.ts");
    git("commit", "-q", "-m", "init");
    writeFileSync(path.join(dir, "a.ts"), "v1\nv2\n");
    git("add", "a.ts");
    git("commit", "-q", "-m", "second");

    const { invocation, appended } = fakeInvocation({
      rawInput: "",
      agent: { session: { header: { cwd: dir } }, inbox: { append: (target, message) => appended.push({ target, message }) } },
    });
    const result = await handleSimplifyCommand(invocation, fakeCtx());
    assert.equal(result.kind, "success");
    assert.match(result.text, /Simplify review queued for 1 changed file\(s\) \(fallback: comparing previous commit HEAD~1\)\./);
    assert.equal(appended.length, 1);
    assert.match(appended[0].message.content[0].text, /Review the following files changed in HEAD~1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handleSimplifyCommand: 会话无 cwd 时回落 process.cwd()（环境隔离测试）", async () => {
  // 需要一个干净的 git 仓库：非 git 目录现在会返回 kind=error（见错误透传用例）
  const { dir, git } = makeRepo();
  try {
    writeFileSync(path.join(dir, "a.ts"), "v1\n");
    git("add", "a.ts");
    git("commit", "-q", "-m", "init");
    const prevCwd = process.cwd();
    try {
      process.chdir(dir);
      const { invocation, appended } = fakeInvocation({ rawInput: "" });
      const result = await handleSimplifyCommand(invocation, fakeCtx());
      assert.equal(result.kind, "success");
      assert.match(result.text, /No changed files found/);
      assert.equal(appended.length, 0);
    } finally {
      process.chdir(prevCwd);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 6. 行为缺陷修复回归（2026-09-25，详见 MIGRATION.md §9.6） ----------

test("getChangedFiles: --staged --ref=<branch> 以该分支为基准（不再静默忽略 ref）", async () => {
  const { dir, git } = makeRepo();
  try {
    writeFileSync(path.join(dir, "a.ts"), "v1\n");
    git("add", "a.ts");
    git("commit", "-q", "-m", "init");
    const base = git("rev-parse", "--abbrev-ref", "HEAD").toString().trim();
    git("checkout", "-q", "-b", "feature");
    // feature 上已经有 x
    writeFileSync(path.join(dir, "a.ts"), "v1\nx\n");
    git("add", "a.ts");
    git("commit", "-q", "-m", "feature adds x");
    git("checkout", "-q", base);
    // 暂存区 = "v1\nx\ny\n"
    writeFileSync(path.join(dir, "a.ts"), "v1\nx\ny\n");
    git("add", "a.ts");

    const { files } = await getChangedFiles(fakeCtx(), dir,
      { files: [], ref: "feature", staged: true });
    assert.deepEqual(files.map((f) => f.path), ["a.ts"]);
    // vs feature 只有 y 是新的 → {3,3}；旧实现（裸 --cached，对比 HEAD="v1"）
    // 会把 x、y 都算进来 → [{2,3}]
    assert.deepEqual(files[0].changedLines, [{ start: 3, end: 3 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getChangedFiles: 无首提交的仓库 --staged 仍可列出暂存新文件", async () => {
  const { dir, git } = makeRepo();
  try {
    writeFileSync(path.join(dir, "fresh.ts"), "new\n");
    git("add", "fresh.ts");

    const { files } = await getChangedFiles(fakeCtx(), dir, { files: [], ref: "HEAD", staged: true });
    assert.deepEqual(files.map((f) => f.path), ["fresh.ts"]);
    assert.equal(files[0].status, "added");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getChangedFiles: 未知的 --ref 返回错误而不是「无变更」", async () => {
  const { dir, git } = makeRepo();
  try {
    writeFileSync(path.join(dir, "a.ts"), "v1\n");
    git("add", "a.ts");
    git("commit", "-q", "-m", "init");

    const { files, error } = await getChangedFiles(fakeCtx(), dir,
      { files: [], ref: "no-such-ref", staged: false });
    assert.deepEqual(files, []);
    assert.match(error ?? "", /no-such-ref/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getChangedFiles: 非 git 仓库返回错误（默认与 --staged 模式）", async () => {
  const plain = mkdtempSync(path.join(tmpdir(), "dsh-simplify-norepo-"));
  try {
    const notARepo = /not a git repository/;
    const workspace = await getChangedFiles(fakeCtx(), plain,
      { files: [], ref: "HEAD", staged: false });
    assert.match(workspace.error ?? "", notARepo);
    assert.deepEqual(workspace.files, []);

    const staged = await getChangedFiles(fakeCtx(), plain,
      { files: [], ref: "HEAD", staged: true });
    assert.match(staged.error ?? "", notARepo);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test("getChangedFiles: 中文文件名不被八进制转义（清单/行号/ls-files 全链路）", async () => {
  const { dir, git } = makeRepo();
  try {
    writeFileSync(path.join(dir, "中文文件.ts"), "line1\n");
    git("add", "中文文件.ts");
    git("commit", "-q", "-m", "init");
    writeFileSync(path.join(dir, "中文文件.ts"), "line1\nline2\n");
    writeFileSync(path.join(dir, "新文件.ts"), "x\n");
    git("add", "新文件.ts");
    writeFileSync(path.join(dir, "未跟踪.ts"), "y\n");

    const { files } = await getChangedFiles(fakeCtx(), dir,
      { files: [], ref: "HEAD", staged: false });
    const modified = files.find((f) => f.path === "中文文件.ts");
    assert.ok(modified, "diff 清单中的中文路径应原样出现");
    assert.equal(modified.status, "modified");
    // HEAD 只有 line1，工作区追加 line2 → hunk @@ -1,0 +2 @@ → {2,2}
    assert.deepEqual(modified.changedLines, [{ start: 2, end: 2 }]);
    const stagedFile = files.find((f) => f.path === "新文件.ts");
    assert.ok(stagedFile, "暂存的中文新文件应原样出现");
    assert.equal(stagedFile.status, "added");
    const untrackedFile = files.find((f) => f.path === "未跟踪.ts");
    assert.ok(untrackedFile, "ls-files 检出的中文未跟踪文件应原样出现");
    assert.equal(untrackedFile.status, "added");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getChangedFiles: 显式指定的未跟踪文件归类为 added（整文件在范围内）", async () => {
  const { dir, git } = makeRepo();
  try {
    writeFileSync(path.join(dir, "a.ts"), "v1\n");
    git("add", "a.ts");
    git("commit", "-q", "-m", "init");
    writeFileSync(path.join(dir, "a.ts"), "v1\nv2\n");
    writeFileSync(path.join(dir, "new.ts"), "brand new\n");

    const { files } = await getChangedFiles(fakeCtx(), dir,
      { files: ["a.ts", "new.ts"], ref: "HEAD", staged: false });
    assert.deepEqual(files.map((f) => f.status), ["modified", "added"]);
    assert.deepEqual(files[0].changedLines, [{ start: 2, end: 2 }]);
    assert.equal(files[1].changedLines, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handleSimplifyCommand: git 失败时返回 kind=error（不再伪装成无变更）", async () => {
  const plain = mkdtempSync(path.join(tmpdir(), "dsh-simplify-norepo-"));
  try {
    const { invocation, appended } = fakeInvocation({
      rawInput: "",
      agent: { session: { header: { cwd: plain } }, inbox: { append: (t, m) => appended.push({ target: t, message: m }) } },
    });
    const result = await handleSimplifyCommand(invocation, fakeCtx());
    assert.equal(result.kind, "error");
    assert.match(result.text, /not a git repository/);
    assert.equal(appended.length, 0);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

