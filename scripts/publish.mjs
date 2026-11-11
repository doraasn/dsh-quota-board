/**
 * 发版收尾：推 main、用 publish/ 建「发布身份快照」提交、移 tag、远端复核。
 *
 * 用法：
 *   node scripts/publish.mjs --dry-run   只做自检 + 建快照树，不推送
 *   node scripts/publish.mjs             自检 → 推 main → 建快照 + 打 tag → 推 tag → ls-remote 复核
 *
 * 为什么要有它：手动「推 main → 建快照 → 打 tag → 推 tag」四步里，最常漏的是最后一步，
 * 结果 tag 只在本机、索引抓不到新版本；另外本机 git 环境被 superagent 的
 * worker-gitconfig 覆盖（GIT_CONFIG_GLOBAL 指向它、GIT_CONFIG_NOSYSTEM=1），
 * 会让 ~/.gitconfig 里的身份与凭据全部失效，所以脚本里统一修正这两个变量。
 *
 * 前置：`node scripts/build-publish.mjs` 已生成 publish/，且工作区干净、版本已 bump。
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLISH = path.join(REPO, 'publish')
const DRY = process.argv.includes('--dry-run')

/** 绕开 superagent 注入的 worker-gitconfig，让 ~/.gitconfig 的身份与凭据生效。 */
const baseEnv = () => {
  const env = { ...process.env }
  if (process.env.USERPROFILE) env.GIT_CONFIG_GLOBAL = `${process.env.USERPROFILE}\\.gitconfig`
  delete env.GIT_CONFIG_NOSYSTEM
  return env
}

const git = (args, options = {}) => execFileSync('git', args, {
  cwd: options.cwd || REPO,
  encoding: 'utf8',
  env: options.env || baseEnv(),
}).trim()

const problems = []
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
const version = String(pkg.version || '')
const tag = `v${version}`

/* ---------- 1. 自检 ---------- */
if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`package.json 版本异常：${version}`)
if (!fs.existsSync(path.join(PUBLISH, 'package.json'))) problems.push('没有 publish/，先跑 scripts/build-publish.mjs')
else {
  const shipped = JSON.parse(fs.readFileSync(path.join(PUBLISH, 'package.json'), 'utf8'))
  if (shipped.version !== version) problems.push(`publish/ 版本 ${shipped.version} ≠ package.json ${version}`)
  if (String(shipped.name).startsWith('@local/')) problems.push(`publish/ 仍是开发身份 ${shipped.name}`)
  if (shipped.dependencies && Object.keys(shipped.dependencies).length) problems.push('publish/ 里不该有 dependencies')
  for (const file of ['cordis.patch.yml', 'icon.svg', path.join('lib', 'client.js')]) {
    if (!fs.existsSync(path.join(PUBLISH, file))) problems.push(`publish/ 缺 ${file}`)
  }
}
if (git(['status', '--porcelain'])) problems.push('工作区不干净：先 commit（或 stash）再发版')

/* 已有同名 tag 时，只有在它正是本次内容时才允许续跑；否则视为版本没 bump */
const existingTag = git(['tag', '--list', tag])
if (existingTag) {
  const tagVersion = (() => {
    try { return JSON.parse(git(['show', `${tag}:package.json`])).version } catch { return null }
  })()
  if (tagVersion !== version) problems.push(`tag ${tag} 已存在但版本是 ${tagVersion}，先删掉重打或 bump 版本`)
}

if (problems.length) {
  for (const problem of problems) console.error(`  FAIL  ${problem}`)
  console.error(`\n${problems.length} 项问题，未推送`)
  process.exit(1)
}
console.log(`✓ 自检通过：${pkg.name}@${version}`)

/* ---------- 2. 建快照（本地对象，不推送） ---------- */
const head = git(['rev-parse', 'HEAD'])
const indexPath = path.join(os.tmpdir(), `dsh-publish-index-${Date.now()}`)
const indexEnv = { ...baseEnv(), GIT_INDEX_FILE: indexPath }
try {
  git(['-C', REPO, '--work-tree', PUBLISH, 'add', '-A', '.'], { cwd: PUBLISH, env: indexEnv })
  const tree = git(['write-tree'], { env: indexEnv })
  const message = `chore: release ${version} (published identity snapshot)`
  const snapshot = git(['commit-tree', tree, '-p', head, '-m', message])
  const shipped = JSON.parse(git(['show', `${snapshot}:package.json`]))
  if (shipped.name !== pkg.name.replace(/^@local\//, '') || shipped.version !== version) {
    console.error(`快照内容不符：${shipped.name}@${shipped.version}`)
    process.exit(1)
  }
  console.log(`  快照 ${snapshot.slice(0, 8)}（tree ${tree.slice(0, 8)}，parent ${head.slice(0, 8)}）`)
  console.log(`  ${shipped.name}@${shipped.version}`)

  if (DRY) {
    const existing = git(['tag', '--list', tag])
    if (existing) {
      const sameTree = git(['rev-parse', `${tag}^{tree}`]) === tree
      console.log(`  dry-run：现有 ${tag} 的 tree ${sameTree ? '与本快照一致' : '与本快照不同'}`)
    }
    console.log('\n--dry-run：不推送')
    process.exit(0)
  }

  /* ---------- 3. 推 main 与 tag ---------- */
  git(['push', 'origin', 'main'])
  git(['tag', '-f', tag, snapshot])
  git(['push', 'origin', `refs/tags/${tag}`])

  /* ---------- 4. 远端复核 ---------- */
  const remoteMain = git(['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0]
  const remoteTag = git(['ls-remote', 'origin', `refs/tags/${tag}`]).split(/\s+/)[0]
  if (remoteMain !== head) throw new Error(`远端 main ${remoteMain.slice(0, 8)} ≠ 本地 HEAD ${head.slice(0, 8)}`)
  if (remoteTag !== snapshot) throw new Error(`远端 tag ${remoteTag.slice(0, 8)} ≠ 快照 ${snapshot.slice(0, 8)}`)
  console.log(`\n✓ 已推送：main ${head.slice(0, 8)}，${tag} → ${snapshot.slice(0, 8)}`)
  console.log(`  报告给索引维护方：${shipped.name} / ${tag} / ${snapshot}`)
} finally {
  fs.rmSync(indexPath, { force: true })
}
