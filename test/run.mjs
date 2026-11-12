/**
 * 自测：不联网、不碰真实 ~/.dsh，用临时 DSH_HOME 跑主机侧核心逻辑。
 * 用法: npm test
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-quota-board-test-'))
process.env.DSH_HOME = HOME

const { apply, resetLabel, toWidgetState } = await import(new URL('../lib/index.js', import.meta.url).href)

/** 把宿主注册的路由抓出来，直接调用。 */
let handler = null
let dispose = null
const SELF_ORIGIN = 'http://127.0.0.1:59681'
const HOST = '127.0.0.1:59681'
const ctx = {
  webServer: { register: (route) => { handler = route.handler }, getOrigin: () => SELF_ORIGIN },
  /** 收集清理函数：测试结束时必须停掉定时器与 codex 子进程，否则 process.exit 会撞 uv 断言。 */
  effect: (fn) => { dispose = fn() },
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

/** 发一个假请求，收 JSON。headers 用于验证 Host / Origin 防护。 */
const call = (url, method = 'GET', body = null, headers = { host: HOST }) => new Promise((resolve) => {
  const listeners = {}
  const req = {
    url,
    method,
    headers,
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
    const raw = typeof body === 'string' ? body : JSON.stringify(body)
    listeners.data?.(Buffer.from(raw))
    listeners.end?.()
  }
})

// ---- 0. 免费版 Codex 没有周额度 ----
{
  const now = new Date(2026, 10, 12, 10, 0, 0)
  const resetsAt = Math.floor(new Date(2026, 10, 12, 14, 30, 0).getTime() / 1000)
  const free = toWidgetState({ rateLimits: { primary: { usedPercent: 30, resetsAt } } }, now)
  check('免费版：没有周额度时 weekly 为 null', free.weekly === null, `实际 ${JSON.stringify(free.weekly)}`)
  check('免费版：5 小时窗口仍可用', free.fiveHour?.remaining === 70 && free.fiveHour?.reset === '14:30',
    `实际 ${JSON.stringify(free.fiveHour)}`)
  const paid = toWidgetState({
    rateLimits: { primary: { usedPercent: 30, resetsAt }, secondary: { usedPercent: 80, resetsAt } },
  }, now)
  check('付费版：有周额度时 weekly 是对象', paid.weekly?.remaining === 20, `实际 ${JSON.stringify(paid.weekly)}`)
}
// ---- 0. 重置时间文案 ----
{
  const now = new Date(2026, 10, 11, 22, 30, 0);            // 11-11 22:30 本地
  const tomorrow = Math.floor(new Date(2026, 10, 12, 4, 11, 0).getTime() / 1000);
  const later = Math.floor(new Date(2026, 10, 20, 9, 5, 0).getTime() / 1000);
  check('5 小时窗口跨午夜只写时刻', resetLabel(tomorrow, now, { withDay: false }) === '04:11',
    `实际 ${resetLabel(tomorrow, now, { withDay: false })}`)
  check('周窗口仍保留「明天」', resetLabel(tomorrow, now) === '明天 04:11',
    `实际 ${resetLabel(tomorrow, now)}`)
  check('远期窗口写月日', resetLabel(later, now) === '11/20 09:05',
    `实际 ${resetLabel(later, now)}`)
}
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

// ---- 6. 本机同源防护（防 CSRF / DNS rebinding / 凭据外流）----
const rebind = await call('/dsh-quota/api/settings', 'GET', null, { host: 'evil.example' })
check('非回环 Host 被拒（DNS rebinding）', rebind.status === 403 && rebind.body.error === 'forbidden-host', `实际 ${rebind.status}`)

const csrf = await call('/dsh-quota/api/probe', 'POST', { baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-x' }, { host: HOST, origin: 'https://evil.example' })
check('跨站 Origin 被拒（CSRF）', csrf.status === 403 && csrf.body.error === 'forbidden-origin', `实际 ${csrf.status}`)

const sandboxed = await call('/dsh-quota/api/settings', 'POST', { providers: [] }, { host: HOST, origin: 'null' })
check('Origin: null 被拒', sandboxed.status === 403, `实际 ${sandboxed.status}`)

const sameOrigin = await call('/dsh-quota/api/settings', 'GET', null, { host: HOST, origin: SELF_ORIGIN })
check('同源 Origin 放行', sameOrigin.status === 200)

// localhost 与 127.0.0.1 是同一个服务：端口一致就应放行，否则用户从 localhost 打开发设置页会 403
const localhostOrigin = await call('/dsh-quota/api/settings', 'GET', null, { host: HOST, origin: 'http://localhost:59681' })
check('localhost 同端口放行', localhostOrigin.status === 200, `实际 ${localhostOrigin.status}`)

const otherPort = await call('/dsh-quota/api/settings', 'GET', null, { host: HOST, origin: 'http://127.0.0.1:59682' })
check('端口不同被拒', otherPort.status === 403, `实际 ${otherPort.status}`)

// 凭据只回到它自己的站点：即使宿主真的保存着 key，也不能被带到别的 host。
fs.mkdirSync(path.join(HOME, 'storages'), { recursive: true })
fs.writeFileSync(path.join(HOME, '.credentials.yaml'), 'refs:\n  ASTRA_HUB_API_KEY: sk-stored-secret\n')
await call('/dsh-quota/api/settings', 'POST', {
  providers: [{ id: 'astra-hub', kind: 'relay', name: 'AstraHub', baseUrl: 'https://www.astrahub-ai.com', credential: 'ASTRA_HUB_API_KEY' }],
}, { host: HOST, origin: SELF_ORIGIN })
const withKey = await call('/dsh-quota/api/settings', 'GET', null, { host: HOST, origin: SELF_ORIGIN })
const astra = withKey.body.providers.find((p) => p.id === 'astra-hub')
check('宿主能读到已保存的 key', astra?.hasApiKey === true)

const crossHost = await call('/dsh-quota/api/probe', 'POST', { providerId: 'astra-hub', baseUrl: 'http://127.0.0.1:9' }, { host: HOST, origin: SELF_ORIGIN })
check('已保存的 key 不会被发往别的 host', crossHost.status === 400 && crossHost.body.error === 'missing-api-key', `实际 ${crossHost.status} ${crossHost.body?.error}`)

// 凭据名里的正则元字符必须当字面量：".*" 不能变成「文件里第一个值」。
const weird = await call('/dsh-quota/api/settings', 'POST', {
  providers: [{ id: 'weird', kind: 'relay', name: 'Weird', baseUrl: 'https://example.com', credential: '.*' }],
}, { host: HOST, origin: SELF_ORIGIN })
check('凭据名按字面量匹配，不注入正则', weird.body.providers[0].hasApiKey === false)

const huge = await call('/dsh-quota/api/probe', 'POST', 'x'.repeat(70 * 1024), { host: HOST, origin: SELF_ORIGIN })
check('超大 body 返回 413', huge.status === 413, `实际 ${huge.status}`)

fs.rmSync(HOME, { recursive: true, force: true })
dispose?.()
console.log(`\n结果: ${passed} 通过 / ${failed} 失败`)
// 不用 process.exit()：Windows 上若子进程句柄还在关闭中，会撞 libuv 断言（退出码 0xC0000409）。
process.exitCode = failed === 0 ? 0 : 1
