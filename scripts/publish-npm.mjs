/**
 * 把 publish/ 目录发布到 npm 官方源（registry.npmjs.org）。
 *
 * 为什么要发 npm：DSH 安装 git 插件时是让本机直接去 GitHub 下 tarball，
 * 不经过安装源；国内用户没代理就会报「无法连接 github.com」。
 * 发布到 npm 后索引可改用 npm 源，走用户自己配置的 registry（npmmirror 可达）。
 *
 * 用法:
 *   npm login --registry https://registry.npmjs.org     # 一次性
 *   node scripts/publish-npm.mjs                        # 发布 publish/ 里的版本
 *   node scripts/publish-npm.mjs --dry-run
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REGISTRY = 'https://registry.npmjs.org'
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const publishDir = path.join(root, 'publish')
const pkgPath = path.join(publishDir, 'package.json')

if (!fs.existsSync(pkgPath)) {
  console.error(`没有找到 ${pkgPath}，先运行 npm run build:publish`)
  process.exit(1)
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

// 认证检查：~/.npmrc 里有 _authToken，或环境变量里有 NPM_TOKEN。
const npmrcPath = path.join(os.homedir(), '.npmrc')
const npmrc = fs.existsSync(npmrcPath) ? fs.readFileSync(npmrcPath, 'utf8') : ''
const hasToken = /_authToken\s*=/.test(npmrc) || Boolean(process.env.NPM_TOKEN)
if (!hasToken && !process.argv.includes('--dry-run')) {
  console.error('还没有 npm 认证。先执行一次：npm login --registry ' + REGISTRY)
  console.error('或在环境变量里提供 NPM_TOKEN（npm 访问令牌）。')
  process.exit(1)
}

console.log(`发布 ${pkg.name}@${pkg.version} 到 ${REGISTRY}`)

const args = ['publish', publishDir, '--registry', REGISTRY, '--access', 'public']
if (process.argv.includes('--dry-run')) args.push('--dry-run')

const result = spawnSync(NPM, args, { stdio: 'inherit', env: { ...process.env, npm_config_registry: REGISTRY } })
process.exit(result.status ?? 1)
