/**
 * 自测：不联网、不碰真实 ~/.dsh，用临时 DSH_HOME 跑主机侧核心逻辑。
 * 用法: npm test
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-quota-board-test-'))
process.env.DSH_HOME = HOME

const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

/** 把宿主注册的路由抓出来，直接调用。 */
let handler = null
const ctx = {
  webServer: { register: (route) => { handler = route.handler } },
  effect: () => () => {},
}
apply(ctx, {})

let passed = 0
let failed = 0
const check = (name, condition, extra = '') => {
  if (condition) {
    passed++
  } else {
    failed++
    console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`)
  }
}

/** 发一个假请求，收 JSON。 */
const call = (url, method = 'GET', body = null) => new Promise((resolve) => {
  const listeners = {}
  const req = {
    url,
    method,
    on(event, cb) { listeners[event] = cb },
    setEncoding() {},
    destroy() {},
  }
  const res = {
    statusCode: 200,
    setHeader() {},
    end(payload) {
      let parsed = null
      try { parsed = JSON.parse(payload) } catch { parsed = payload }
      resolve({ status: res.statusCode, body: parsed })
    },
  }
  handler(req, res)
  if (body !== null) {
    listeners.data?.(Buffer.from(JSON.stringify(body)))
    listeners.end?.()
  }
})

// ---- 1. 默认设置 ----
const settings = await call('/dsh-quota/api/settings')
check('GET settings 返回 200', settings.status === 200)
check('默认有 2 个供应商', Array.isArray(settings.body.providers) && settings.body.providers.length === 2,
  `实际 ${settings.body?.providers?.length}`)
check('默认含 codex 卡', settings.body.providers.some((p) => p.kind === 'codex'))
check('默认含中转卡', settings.body.providers.some((p) => p.kind === 'relay'))

// ---- 2. 保存与回读（含常量路径）----
const saved = await call('/dsh-quota/api/settings', 'POST', {
  providers: [
    {
      id: 'zai',
      kind: 'relay',
      name: '智谱 Z.AI',
      baseUrl: 'https://open.bigmodel.cn/api/biz/account/query-customer-account-report',
      credential: 'ZAI_API_KEY',
      visible: true,
      map: {
        spent: { path: 'data.totalSpendAmount', scale: 1 },
        granted: { path: 'data.rechargeAmount', scale: 1 },
        remaining: { path: 'data.availableBalance', scale: 1 },
      },
    },
    {
      id: 'pct',
      kind: 'relay',
      name: '百分比型',
      baseUrl: 'https://example.com/quota',
      credential: '',
      visible: false,
      map: {
        spent: { path: 'data.limits.0.percentage', scale: 1 },
        granted: { path: '100', scale: 1 },
        remaining: { path: '', scale: 1 },
      },
    },
  ],
})
check('POST settings 返回 200', saved.status === 200)
check('保存后仍是 2 个', saved.body.providers.length === 2)
check('顺序按提交顺序', saved.body.providers[0].id === 'zai' && saved.body.providers[1].id === 'pct')
check('常量路径被保留', saved.body.providers[1].map.granted.path === '100')

const reread = await call('/dsh-quota/api/settings')
check('重新读回一致', reread.body.providers[1].map.granted.path === '100')

// ---- 3. 地址解析（三种写法）----
// 用本机不可达端口：只验证三种地址写法都能被解析、不会抛异常（不联网）
const cases = [
  ['http://127.0.0.1:9', 'pair'],
  ['http://127.0.0.1:9/dashboard/billing/usage', 'pair'],
  ['http://127.0.0.1:9/user/balance', 'single'],
  ['http://127.0.0.1:9/x' + String.fromCharCode(10) + 'http://127.0.0.1:9/y', 'pair'],
]
for (const [url, expect] of cases) {
  const probe = await call('/dsh-quota/api/probe', 'POST', {
    baseUrl: url,
    apiKey: 'sk-test',
    map: { spent: { path: 'a', scale: 1 }, granted: { path: 'b', scale: 1 }, remaining: { path: 'c', scale: 1 } },
  })
  // 探测会去请求真实地址，这里只关心它不抛异常且有结构返回
  check(`探测 ${url} 不崩`, probe.status === 200 && typeof probe.body === 'object', `expect=${expect}`)
}

// ---- 4. 越界保护 ----
const tooMany = await call('/dsh-quota/api/settings', 'POST', {
  providers: Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, kind: 'relay', name: `P${i}`, baseUrl: '', credential: '', visible: true, map: {} })),
})
check('超过上限被截断到 12', tooMany.body.providers.length === 12, `实际 ${tooMany.body.providers.length}`)

// ---- 5. 配置文件落盘 ----
const stored = path.join(HOME, 'storages', 'quota-panel.json')
check('设置写入 storages/quota-panel.json', fs.existsSync(stored))

fs.rmSync(HOME, { recursive: true, force: true })
console.log(`\n结果: ${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
