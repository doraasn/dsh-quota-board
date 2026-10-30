/**
 * 生成可发布副本：把本地开发用的包名 @local/dsh-quota-panel 统一改成 dsh-quota-board。
 *
 * 三处必须同时改，否则 DSH 会报 duplicate factory registration：
 *   1. package.json      name
 *   2. cordis.patch.yml  name
 *   3. lib/client.js     window.__ModuleLoader__.load({ id })
 *
 * 用法: node scripts/build-publish.mjs [--out publish]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL_NAME = '@local/dsh-quota-panel'
const PUBLISH_NAME = 'dsh-quota-board'
const OUT_FLAG = process.argv.indexOf('--out')
const OUT = path.resolve(ROOT, OUT_FLAG > 0 ? process.argv[OUT_FLAG + 1] : 'publish')

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const write = (rel, text) => {
  const target = path.join(OUT, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text)
}
const copy = (rel) => {
  const target = path.join(OUT, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(path.join(ROOT, rel), target)
}

fs.rmSync(OUT, { recursive: true, force: true })

// 1) package.json：改名 + 补发布字段
const pkg = JSON.parse(read('package.json'))
pkg.name = PUBLISH_NAME
pkg.repository = { type: 'git', url: 'git+https://github.com/doraasn/dsh-quota-board.git' }
pkg.homepage = 'https://github.com/doraasn/dsh-quota-board#readme'
pkg.bugs = { url: 'https://github.com/doraasn/dsh-quota-board/issues' }
pkg.publishConfig = { access: 'public' }
if (!pkg.files.includes('test/')) pkg.files.push('test/')
write('package.json', JSON.stringify(pkg, null, 2) + '\n')

// 2) cordis.patch.yml
const patch = read('cordis.patch.yml').replaceAll(LOCAL_NAME, PUBLISH_NAME)
write('cordis.patch.yml', patch)

// 3) lib/client.js 的模块 id
const client = read('lib/client.js')
const idPattern = `id: "${LOCAL_NAME}"`
if (!client.includes(idPattern)) {
  throw new Error(`client.js 里没找到 ${idPattern}，先确认格式没变`)
}
write('lib/client.js', client.replace(idPattern, `id: "${PUBLISH_NAME}"`))

// 4) 其余文件原样复制（README 里的包名同步替换）；icon.svg 供「已安装」列表取图
for (const rel of ['lib/index.js', 'README.md', 'LICENSE', 'test/run.mjs', 'icon.svg']) {
  copy(rel)
}
write('README.md', read('README.md').replaceAll(LOCAL_NAME, PUBLISH_NAME))

// 5) 自检：三处名字必须一致
const names = {
  'package.json': JSON.parse(fs.readFileSync(path.join(OUT, 'package.json'), 'utf8')).name,
  'cordis.patch.yml': (fs.readFileSync(path.join(OUT, 'cordis.patch.yml'), 'utf8').match(/name: '([^']+)'/) || [])[1],
  'lib/client.js': (fs.readFileSync(path.join(OUT, 'lib/client.js'), 'utf8').match(/id: "([^"]+)"/) || [])[1],
}
console.log(`输出目录: ${OUT}`)
for (const [file, name] of Object.entries(names)) console.log(`  ${file.padEnd(18)} ${name}`)
if (new Set(Object.values(names)).size !== 1 || names['package.json'] !== PUBLISH_NAME) {
  console.error('名字不一致，发布前必须修好')
  process.exit(1)
}
console.log(`✓ 三处名字一致: ${PUBLISH_NAME}`)
