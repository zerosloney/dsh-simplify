#!/usr/bin/env node
/**
 * 本机发布脚本 —— 替代已删除的 GitHub Actions publish workflow。
 *
 * 用法：
 *   npm run publish:local            # patch（默认）
 *   npm run publish:local -- minor   # minor
 *   npm run publish:local -- major   # major
 *
 * 流程：
 *   1. 校验 git 工作区干净（npm version 会创建 commit + tag，要求干净）；
 *   2. npm version <bump> —— 自动触发 "version" 钩子里的 npm test，
 *      测试通过后才提交 package.json/package-lock.json 并打 v* 标签；
 *   3. npm publish 发布到 npm registry；
 *   4. 提示手动推送 commit 与 tag 到远端（本机发布不代替推送）。
 *
 * 前置：本机已登录 npm（npm whoami 可验证）；若账号开启 2FA，
 *       npm publish 会交互式提示输入 OTP。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bump = process.argv[2] ?? 'patch'
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error(`未知版本号类型: ${bump}（可选 patch | minor | major）`)
  process.exit(1)
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts })
  if (res.error) {
    console.error(`
执行失败: ${cmd} ${args.join(' ')} — ${res.error.message}`)
    process.exit(1)
  }
  if (res.status !== 0) process.exit(res.status ?? 1)
}

const pkgPath = path.join(root, 'package.json')
const version = () => JSON.parse(readFileSync(pkgPath, 'utf8')).version

// 1. 校验 git 工作区干净
const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
if (status.error || status.status !== 0) {
  console.error('无法读取 git 状态，请确认已安装 git')
  process.exit(1)
}
if (status.stdout.trim()) {
  console.error('git 工作区不干净，请先提交或还原改动后再发布：\n')
  console.error(status.stdout)
  process.exit(1)
}

const before = version()
console.log(`\n当前版本: v${before}，准备发布 ${bump} 版本\n`)

// 2. 升版本 + 打标签（"version" 钩子自动跑 npm test，失败则不提交不打标签）
run(npmCmd, ['version', bump, '-m', 'chore: release v%s'])

const after = version()
console.log(`\n版本已更新: v${before} → v${after}\n`)

// 3. 本机发布到 npm
run(npmCmd, ['publish'])

console.log(`\n✅ 已发布 ${JSON.parse(readFileSync(pkgPath, 'utf8')).name}@${after}`)
console.log('如需同步远端（不会自动推送）：')
console.log('  git push && git push --tags')
