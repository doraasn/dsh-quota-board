/**
 * dsh-quota-board — host half.
 *
 * Serves a small JSON API at /dsh-quota/api/balance:
 *   {
 *     fiveHour: {name, remaining, color, reset},
 *     weekly:   {name, remaining, color, reset},
 *     astra:    {name, remaining, spent, granted, todaySpent, color, reset},
 *     resets: number,
 *     codexOk: boolean
 *   }
 *
 * Data sources (Codex part ported from
 * https://github.com/doraasn/codex-quota-dashboard, MIT):
 *   - Codex quota: local `codex.exe app-server` JSON-RPC `account/rateLimits/read`
 *   - AstraHub spend: the relay's OpenAI-compatible billing endpoints,
 *     /dashboard/billing/usage (cumulative spend) and
 *     /dashboard/billing/subscription (granted total). Mind the scales — the
 *     usage endpoint answers in hundredths of the display currency while the
 *     subscription endpoint answers in whole units; see DEFAULT_MAP.
 *     Authenticated with the relay API key from .dsh/.credentials.yaml.
 */
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// v4 起的会话日志是 zstd 多帧流，Node 22+ 的 zlib 自带 zstdDecompressSync。
import zlib from 'node:zlib';

export const name = 'quota-panel';
export const inject = ['webServer'];

const REFRESH_MS = 5000;
// How long to wait before trying to bring a dead codex CLI back.
const CODEX_RETRY_MS = 10000;
// A CLI that spawns but never completes the handshake is treated as dead.
const CODEX_INIT_TIMEOUT_MS = 15000;
// A request that gets no answer in this window means the CLI hung; respawn.
const CODEX_REPLY_TIMEOUT_MS = 12000;

// The relay is polled far less often than the local Codex quota: its billing
// endpoints are an external HTTP call and the numbers move slowly.
const DEFAULT_ASTRA_BASE_URL = 'https://www.astrahub-ai.com';
const DEFAULT_ASTRA_CREDENTIAL = 'ASTRA_HUB_API_KEY';
const DEFAULT_PROVIDER_ID = 'astra-hub';
const CODEX_PROVIDER_ID = 'codex';
const MAX_PROVIDERS = 12;
const ASTRA_REFRESH_MS = 60000;
// 侧栏打开时按需刷新：距上次成功刷新超过这个间隔，就在下一次 /api/balance
// 请求里顺带触发一次（不阻塞响应），把「最多 60s 才变」压到「约 15s 内变」。
const ASTRA_MIN_AGE_MS = 15000;
const ASTRA_TIMEOUT_MS = 8000;
// 今日用量/花费默认按本地自然日统计，可用 QUOTA_DAY_START_HOUR 改切日时刻。
const USD_TO_CNY = 7;
/**
 * DeepSeek 官方价目表（美元 / 1M tokens，2026-11 官网）。
 * 峰时 01:00–04:00、06:00–10:00 UTC 的周一至周五（中国法定节假日除外），
 * 其余时段（含周末与节假日）半价；价目表调整时需要跟着更新。
 */
const DEEPSEEK_PRICE = {
  hit: 0.003,
  miss: 0.15,
  out: 0.6,
};
const USAGE_REFRESH_MS = 30000;
const USAGE_MAX_DAYS = 31;

// ---------- formatting (ported from quota-format.js) ----------

const bounded = (value) => Math.max(0, Math.min(100, Number(value)));

function remainingPercent(usedPercent) {
  const used = Number(usedPercent);
  return Number.isFinite(used) ? Math.round(100 - bounded(used)) : null;
}

function quotaColor(remaining) {
  if (remaining === null) return '#9aa3af';
  if (remaining >= 80) return '#43c982';
  if (remaining < 10) return '#ff6262';
  return '#efb83f';
}

export function resetLabel(unixSeconds, now = new Date(), { withDay = true } = {}) {
  const seconds = Number(unixSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const target = new Date(seconds * 1000);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTarget = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  const dayOffset = Math.round((startOfTarget - startOfToday) / 86400000);
  const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(target);
  // Kept short: the sidebar column is ~110px wide per metric.
  // 5 小时窗口只写时刻（跨午夜也不写「明天」）：它最长 5 小时就重置，写日期只占宽度。
  if (!withDay) return time;
  if (dayOffset === 0) return time;
  if (dayOffset === 1) return `明天 ${time}`;
  return `${target.getMonth() + 1}/${target.getDate()} ${time}`;
}

export function toWidgetState(result, now = new Date()) {
  const keyed = result?.rateLimitsByLimitId;
  const firstKeyed = keyed && typeof keyed === 'object' ? Object.values(keyed)[0] : null;
  const limits = result?.rateLimits ?? firstKeyed;
  const buildWindow = (name, source, options) => {
    const remaining = remainingPercent(source?.usedPercent);
    return { name, remaining, color: quotaColor(remaining), reset: resetLabel(source?.resetsAt, now, options) };
  };
  return {
    fiveHour: buildWindow('5 小时', limits?.primary, { withDay: false }),
    // 免费版 Codex 只有 5 小时窗口，没有 secondary；此时显式给 null，
    // 让卡片与悬停卡都能「整个周额度段不渲染」，而不是显示一个 --。
    weekly: limits?.secondary ? buildWindow('周', limits.secondary) : null,
    resets: Math.max(0, Math.trunc(Number(result?.rateLimitResetCredits?.availableCount) || 0)),
  };
}

function compactAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  if (Math.abs(amount) >= 1000) return `${Math.round(amount / 100) / 10}k`;
  if (Math.abs(amount) >= 100) return String(Math.round(amount));
  if (Math.abs(amount) >= 10) return amount.toFixed(1).replace(/\.0$/, '');
  return amount.toFixed(2).replace(/\.?0+$/, '');
}

function formatSpent(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  if (Math.abs(amount) >= 1000) return `${(amount / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (Math.abs(amount) >= 1) return amount.toFixed(2).replace(/\.?0+$/, '');
  if (amount === 0) return '0';
  return amount.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function emptyWidgetState() {
  return {
    fiveHour: { name: '5 小时', remaining: null, color: quotaColor(null), reset: '' },
    weekly: null,
    // One entry per configured relay, in the order the settings page lists them.
    providers: [],
    resets: 0,
  };
}

// ---------- Codex quota client (ported from quota-client.js) ----------

function locateCodex() {
  if (process.platform !== 'win32') return null;
  const lookup = spawnSync('where.exe', ['codex.exe'], { encoding: 'utf8', windowsHide: true });
  const first = lookup.stdout?.split(/\r?\n/).find((value) => value.trim());
  if (first && fs.existsSync(first.trim())) return first.trim();
  const binRoot = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  if (binRoot && fs.existsSync(binRoot)) {
    const candidates = fs
      .readdirSync(binRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(binRoot, entry.name, 'codex.exe'))
      .filter(fs.existsSync)
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
    if (candidates[0]) return candidates[0];
  }
  return null;
}

class CodexQuotaClient {
  #child = null;
  #ready = false;
  #pending = null;
  #sequence = 20;
  #retryAt = 0;
  #executable = null;
  #watchdog = null;

  start(executable) {
    if (this.#child) return;
    if (!executable) {
      this.#scheduleRetry();
      return;
    }
    // A fresh child starts from a clean slate: leftover #pending from the dead
    // one used to block every later request, freezing the card.
    this.#executable = executable;
    this.#ready = false;
    this.#pending = null;
    this.#child = spawn(executable, ['app-server'], {
      cwd: os.homedir(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    // 子进程可能已经退出：此时 stdin 是已销毁的流，写入失败会以 'error' 事件
    // 冒出来。没有监听器就是未捕获异常，会直接带走整个宿主进程。
    this.#child.stdin.on('error', () => {});
    this.#child.once('error', () => {
      this.#child = null;
      this.#ready = false;
      this.#pending = null;
      this.#clearWatchdog();
      this.#scheduleRetry();
      this.emitOffline();
    });
    this.#child.once('exit', () => {
      this.#child = null;
      this.#ready = false;
      this.#pending = null;
      this.#clearWatchdog();
      // The CLI can exit on its own (idle, upgrade, another instance taking
      // over). Without a retry the card would freeze on stale numbers forever.
      this.#scheduleRetry();
      this.emitOffline();
    });
    const output = readline.createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
    output.on('line', (line) => this.#receive(line));
    this.#write({ id: 1, method: 'initialize', params: { clientInfo: { name: 'dsh_quota_panel', version: '0.1.0' } } });
    // Handshake watchdog: a CLI that starts but never answers would otherwise
    // leave #ready=false forever, and refresh() would never respawn it.
    this.#armWatchdog(CODEX_INIT_TIMEOUT_MS);
  }

  /**
   * Called on a timer. Brings the child back if it died, then asks for a
   * refresh — so a crashed or upgraded CLI recovers without a DSH restart.
   */
  refresh() {
    if (!this.#child) {
      if (Date.now() < this.#retryAt) return false;
      // Re-discover on every retry: an upgrade moves the executable to a new
      // hashed directory.
      this.#executable = locateCodex() || this.#executable;
      this.start(this.#executable);
      return false;
    }
    if (!this.#ready || this.#pending !== null) return false;
    this.#pending = ++this.#sequence;
    this.#write({ id: this.#pending, method: 'account/rateLimits/read' });
    // The CLI can hang mid-session (auth refresh, another instance grabbing the
    // lock). Without this the request would keep #pending set forever.
    this.#armWatchdog(CODEX_REPLY_TIMEOUT_MS);
    return true;
  }

  #scheduleRetry() {
    this.#retryAt = Date.now() + CODEX_RETRY_MS;
  }

  #armWatchdog(ms) {
    this.#clearWatchdog();
    this.#watchdog = setTimeout(() => {
      this.#watchdog = null;
      this.#killAndRetry();
    }, ms);
    // Never keep the host's event loop alive just for this timer.
    this.#watchdog.unref?.();
  }

  #clearWatchdog() {
    if (this.#watchdog) clearTimeout(this.#watchdog);
    this.#watchdog = null;
  }

  /** Treat "no answer in time" exactly like a crash: kill it so the next tick respawns. */
  #killAndRetry() {
    const child = this.#child;
    this.#child = null;
    this.#ready = false;
    this.#pending = null;
    try { child?.kill(); } catch {}
    this.#scheduleRetry();
    this.emitOffline();
  }

  stop() {
    this.#clearWatchdog();
    const child = this.#child;
    this.#child = null;
    this.#ready = false;
    this.#pending = null;
    try {
      child?.kill();
    } catch {}
    // 关掉管道：codex 的 stdin/stdout 是两个常驻 Socket，
    // 不显式销毁时宿主退出（或测试收尾）要等子进程回收，白等好几秒。
    try {
      child?.stdin?.destroy();
    } catch {}
    try {
      child?.stdout?.destroy();
    } catch {}
  }

  #receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === 1 && !message.error) {
      this.#ready = true;
      this.#write({ method: 'initialized', params: {} });
      this.refresh();
      return;
    }
    if (message.id !== this.#pending) return;
    this.#pending = null;
    this.#clearWatchdog();
    if (message.error) this.emitOffline();
    else this.emitQuota(toWidgetState(message.result));
  }

  #write(message) {
    try {
      this.#child?.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // 子进程刚退出；refresh() 的下一个 tick 会重建它。
    }
  }

  onQuota = null;
  onOffline = null;
  emitQuota(state) {
    this.onQuota?.(state);
  }
  emitOffline() {
    this.onOffline?.();
  }
}

/**
 * Read one secret straight from the dsh harness credential store
 * (`.dsh/.credentials.yaml`), which already holds the keys dsh itself uses.
 * Values are never logged or returned to the client — only used for the fetch.
 */
function readDshCredential(name) {
  // An empty name would make the pattern below match the first key in the
  // file, handing one provider's secret to another. Refuse it outright.
  if (!name) return '';
  try {
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const file = path.join(dshHome, '.credentials.yaml');
    if (!fs.existsSync(file)) return '';
    const raw = fs.readFileSync(file, 'utf8');
    // Matches: refs:\n  DEEPSEEK_API_KEY: sk-...  (also tolerates = / quotes)
    // The name comes from the settings form, so it must be escaped before it
    // becomes a pattern: ".*" would otherwise match the first value in the
    // file and hand one provider's secret to another provider's endpoint.
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${escaped}\\s*[:=]\\s*["']?([A-Za-z0-9_\\-]+)`);
    const match = raw.match(pattern);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

// ---------- relay spend: fetch, then map fields ----------

/**
 * Where each displayed number comes from by default.
 *
 * new-api's two endpoints do NOT share a scale (controller/billing.go):
 *   /dashboard/billing/usage        -> TotalUsage: amount * 100, i.e. HUNDREDTHS
 *                                      of the display currency (fen/cents);
 *   /dashboard/billing/subscription -> hard_limit_usd: (remain + used) / QuotaPerUnit,
 *                                      i.e. whole currency units, and it is the
 *                                      GRANTED total — not the remaining balance.
 * Other relays differ, so every path is overridable per provider.
 */
const DEFAULT_MAP = {
  spent: { path: 'usage.total_usage', scale: 0.01 },
  granted: { path: 'subscription.hard_limit_usd', scale: 1 },
  // Absent means "compute it as granted − spent".
  remaining: null,
};

/** Read "usage.total_usage" / "data.items.0.quota" out of a nested object. */
function getByPath(root, path) {
  if (typeof path !== 'string' || !path) return undefined;
  // A bare number is a constant, not a path: percentage-style APIs need a fixed
  // ceiling ("100") while the used side comes from the response.
  if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
  if (!root || typeof root !== 'object') return undefined;
  let cursor = root;
  for (const segment of path.split('.')) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      cursor = Number.isInteger(index) ? cursor[index] : undefined;
    } else if (typeof cursor === 'object') {
      cursor = cursor[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
}

/** Accept whatever the settings page sent; fall back to the defaults per field. */
function normalizeMap(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const field = (key, fallback) => {
    const item = source[key];
    const path = item && typeof item === 'object' && typeof item.path === 'string' ? item.path.trim() : '';
    if (!path) return fallback;
    const scale = Number(item.scale);
    return { path, scale: Number.isFinite(scale) ? scale : fallback.scale };
  };
  const remainingItem = source.remaining;
  const remainingPath = remainingItem && typeof remainingItem === 'object' && typeof remainingItem.path === 'string'
    ? remainingItem.path.trim()
    : '';
  let remaining = null;
  if (remainingPath) {
    const scale = Number(remainingItem.scale);
    remaining = { path: remainingPath, scale: Number.isFinite(scale) ? scale : 1 };
  }
  return {
    spent: field('spent', DEFAULT_MAP.spent),
    granted: field('granted', DEFAULT_MAP.granted),
    remaining,
  };
}

/** Resolve the mapped numbers out of one combined response. NaN means "no value". */
function computeAmounts(combined, rawMap) {
  const map = normalizeMap(rawMap);
  const read = (mapping) => {
    if (!mapping) return NaN;
    const value = Number(getByPath(combined, mapping.path));
    return Number.isFinite(value) ? value * mapping.scale : NaN;
  };
  const spent = read(map.spent);
  const granted = read(map.granted);
  const mapped = read(map.remaining);
  const remaining = Number.isFinite(mapped)
    ? mapped
    : (Number.isFinite(granted) && Number.isFinite(spent) ? Math.max(0, granted - spent) : NaN);
  return { spent, granted, remaining };
}

/**
 * Turn the single address field into the 1-2 URLs actually requested.
 *
 * Accepted forms:
 *   https://relay.example.com                                  -> new-api pair
 *   https://relay.example.com/dashboard/billing/usage          -> same pair (pasted one leg)
 *   https://api.deepseek.com/user/balance                      -> that one endpoint
 *   https://x/usage.php  https://x/subscription.php            -> two explicit endpoints
 *
 * The two-URL form exists because only the user knows the real paths on a
 * non-standard relay; everything else is derived so nobody has to remember the
 * new-api convention.
 */
function resolveEndpoints(raw) {
  const tokens = String(raw || '').trim().split(/[\s,]+/).filter(Boolean);
  if (tokens.length >= 2) {
    return { usage: tokens[0], limit: tokens[1] };
  }
  const url = tokens[0] || '';
  const { origin, balancePath } = splitEndpoint(url);
  if (!balancePath || /\/dashboard\/billing\/(usage|subscription)$/.test(balancePath)) {
    return { usage: `${origin}/dashboard/billing/usage`, limit: `${origin}/dashboard/billing/subscription` };
  }
  return { single: url };
}

/**
 * Fetch one or two endpoints. Errors are values: a relay that lacks one of them
 * still yields the other, which is what makes the field picker useful.
 */
/**
 * 进行中的外部请求：插件卸载时统一中止。
 * 否则一次在途 fetch（最长 ASTRA_TIMEOUT_MS）会拖住事件循环，宿主退出要等它超时。
 */
const inflight = new Set();
function trackedSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref?.();
  inflight.add(controller);
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      inflight.delete(controller);
    },
  };
}
function abortInflight() {
  for (const controller of inflight) {
    try {
      controller.abort();
    } catch {}
  }
  inflight.clear();
}

async function fetchBilling(endpoints, apiKey) {
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
  const one = async (url) => {
    // 地址来自设置表单：只放行 http(s)，别让 file:/data: 之类的协议走到 fetch 里。
    if (!/^https?:\/\//i.test(String(url || ''))) {
      return { ok: false, status: 0, detail: 'unsupported scheme' };
    }
    const track = trackedSignal(ASTRA_TIMEOUT_MS);
    try {
      const response = await fetch(url, { headers, signal: track.signal });
      const text = (await response.text()).slice(0, 65536);
      if (!response.ok) return { ok: false, status: response.status, detail: text.slice(0, 300) };
      try {
        return { ok: true, body: JSON.parse(text) };
      } catch {
        return { ok: false, status: response.status, detail: `not JSON: ${text.slice(0, 200)}` };
      }
    } catch (error) {
      return { ok: false, status: 0, detail: String(error && error.message).slice(0, 300) };
    } finally {
      track.done();
    }
  };

  if (endpoints.single) {
    const single = await one(endpoints.single);
    return {
      // No wrapping: the response itself is the mapping root, so a path like
      // "balance_infos.0.total_balance" works as written in the docs.
      combined: single.ok ? single.body : null,
      errors: { usage: single.ok ? null : single, subscription: null },
    };
  }

  const [usage, subscription] = await Promise.all([
    one(endpoints.usage),
    one(endpoints.limit),
  ]);
  return {
    // Paths are resolved against this combined object, so "usage.*" and
    // "subscription.*" both work, and so does anything nested inside them.
    combined: { usage: usage.ok ? usage.body : null, subscription: subscription.ok ? subscription.body : null },
    errors: {
      usage: usage.ok ? null : usage,
      subscription: subscription.ok ? null : subscription,
    },
  };
}

const relayMissing = (reset) => ({
  name: 'AstraHub',
  remaining: null,
  spent: null,
  granted: null,
  todaySpent: null,
  color: quotaColor(null),
  reset,
});

/**
 * Presentation layer: takes the already-mapped numbers, so the shape of the
 * relay's JSON never reaches this function.
 */
function toRelayWidgetState(amounts, options = {}) {
  if (options.missingKey) return relayMissing('未配置 key');
  if (options.error) return { ...relayMissing('请求失败'), color: '#ff6262' };
  const spent = Number(amounts?.spent);
  const granted = Number(amounts?.granted);
  const remaining = Number(amounts?.remaining);
  const todaySpent = Number.isFinite(options.todaySpent) ? options.todaySpent : null;
  const finite = Number.isFinite(spent);
  return {
    name: 'AstraHub',
    remaining: Number.isFinite(remaining) ? compactAmount(remaining) : null,
    spent: finite ? compactAmount(spent) : null,
    granted: Number.isFinite(granted) ? compactAmount(granted) : null,
    todaySpent: todaySpent === null ? null : compactAmount(todaySpent),
    // A mapped remaining value is trusted; the derived one warns when it gets low.
    color: Number.isFinite(granted) || Number.isFinite(remaining)
      ? (Number.isFinite(remaining) && remaining <= 10 ? '#efb83f' : '#43c982')
      : quotaColor(null),
    reset: todaySpent === null ? '额度未知' : `今日 ¥${formatSpent(todaySpent)}`,
  };
}

/** Local calendar day, e.g. 2026-10-20. */
function localDayKey(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function dailyPath() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(dshHome, 'storages', 'quota-panel-daily.json');
}

/** Baselines keyed by provider id: { [id]: {day, baseCents} }. */
function readDaily() {
  try {
    const parsed = JSON.parse(fs.readFileSync(dailyPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeDaily(record) {
  try {
    const file = dailyPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record));
  } catch {
    // best effort: a failed write only means today's figure restarts
  }
}

/** The pre-0.5 baseline file (one provider, no ids). Read only, for migration. */
function legacyDaily() {
  try {
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const parsed = JSON.parse(fs.readFileSync(path.join(dshHome, 'storages', 'quota-panel-astra.json'), 'utf8'));
    const baseCents = Number(parsed?.baseCents);
    if (typeof parsed?.day === 'string' && Number.isFinite(baseCents)) {
      return { day: parsed.day, baseCents };
    }
  } catch {
    // no legacy file: first install, or already migrated
  }
  return null;
}

/**
 * Today's spend for one provider, derived from its lifetime counter.
 *
 * The relay only exposes a lifetime total, so "today" needs a baseline kept on
 * disk — otherwise every harness restart would reset the figure. Baselines are
 * per provider; the first sample of each new local day becomes the baseline, so
 * a session that starts mid-day under-counts the earlier part of that day.
 * @param providerId - which provider this counter belongs to.
 * @param spentCents - lifetime spend in hundredths of the display currency.
 * @returns today's spend in whole currency units.
 */
function trackDay(providerId, spentCents) {
  const day = localDayKey();
  const all = readDaily();
  let record = all[providerId];
  // Upgrading from the single-provider version would otherwise throw away
  // today's figure; adopt the old baseline for the provider it belonged to.
  if (!record && providerId === DEFAULT_PROVIDER_ID) {
    const legacy = legacyDaily();
    if (legacy && legacy.day === day) record = legacy;
  }
  if (!record || record.day !== day) {
    all[providerId] = { day, baseCents: spentCents };
    writeDaily(all);
    return 0;
  }
  if (all[providerId] !== record) {
    all[providerId] = record;
    writeDaily(all);
  }
  return Math.max(0, (spentCents - record.baseCents) / 100);
}

/** 「今日」从几点算起：0 = 本地自然日。 */
function dayStartHour() {
  const raw = Number(process.env.QUOTA_DAY_START_HOUR);
  return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : 0;
}

/** 今日 0 点（按 dayStartHour）。 */
function todayStart(now = new Date()) {
  const start = new Date(now);
  start.setHours(dayStartHour(), 0, 0, 0);
  if (start.getTime() > now.getTime()) start.setDate(start.getDate() - 1);
  return start;
}

/**
 * 估算花费（人民币）。
 *
 * 官方单价是「美元 / 1M tokens」，且峰谷差一倍：峰时 01:00–04:00、06:00–10:00 UTC
 * 的周一至周五（中国法定节假日除外），其余时段半价。这里不区分峰谷，
 * 一律按峰值价算，得到的是当日花费**上限**（实际通常约为一半）。
 *
 * @param input 输入 token（含缓存命中部分）
 * @param output 输出 token
 * @param cached 其中缓存命中的输入 token
 * @param cacheWrite 缓存写入 token（按未命中价计）
 * @returns 人民币金额
 */
function recordCost(input, output, cached, cacheWrite = 0) {
  const hit = Math.min(Math.max(0, cached || 0), input);
  const miss = input - hit;
  const usd = (miss * DEEPSEEK_PRICE.miss + hit * DEEPSEEK_PRICE.hit
    + (cacheWrite || 0) * DEEPSEEK_PRICE.miss + output * DEEPSEEK_PRICE.out) / 1_000_000;
  return usd * USD_TO_CNY;
}

// ---------- local usage ledger (今日预估用量 / 预估花费) ----------

/**
 * 每张卡声明它「占用」哪些模型（= 哪把 key）。配置在设置页每张卡里填，
 * 形如 `deepseek-v4.1-flash-kaiaosi, deepseek-v4-pro-kaiaosi`。
 * 没声明任何模型的卡不参与分账，避免把别人的用量算到它头上。
 * @returns Array<{key: string, models: string[]}>
 */
function providerModels() {
  return effectiveProviders({})
    .filter((provider) => provider.kind === 'relay' && Array.isArray(provider.models) && provider.models.length)
    .map((provider) => ({ key: provider.id, models: provider.models }));
}

/** 最新一轮聚合结果：/api/usage 读它，面板不用每次重扫日志。 */
let latestUsage = null;

/**
 * 官方 API key 只能读余额（/user/balance），查不到逐 key 的每日 token 与花费：
 * 那些数只存在于 platform.deepseek.com 的登录态接口，API key 认证不了。
 * 所以「今日」按本机请求记账。数据来自 DSH 自己的会话日志
 * `$DSH_HOME/sessions/<workspace>/<session>/session.vN.jsonl[.zstd]`：
 * 每次模型请求落一条 `assistant/message`，带
 * `usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`
 * 与毫秒时间戳 `time`（框架层实测形状）。
 *
 * 口径（已与用户确认，面板上标注「预估」）：
 *   - 只算本机；别的设备/工具用同一个 key 的消耗不在这里；
 *   - 子代理与摘要请求各有自己的会话文件，一并计入；
 *   - 价目表按官方 2026-11 峰谷价，币种按 USD:CNY = 7 折算。
 * 本插件账本在 `storages/quota-panel-usage.json`：{ files: { [路径]: 已消费字节 }, days }。
 */

/** 本插件自己的账本。 */
function usageStatePath() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(dshHome, 'storages', 'quota-panel-usage.json');
}

function readUsageState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(usageStatePath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { files: {}, days: {} };
    // 账本结构：files（每个日志读到哪）、fileUsage（每个日志各自的按天分账）、
    // days（各文件汇总，读面板用）、done/pending（重扫两段式标记）。
    // 这里必须把新字段一起带出去，否则每轮扫描都会把分账当成空的重建。
    return {
      files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {},
      fileUsage: parsed.fileUsage && typeof parsed.fileUsage === 'object' ? parsed.fileUsage : {},
      days: parsed.days && typeof parsed.days === 'object' ? parsed.days : {},
      done: Array.isArray(parsed.done) ? parsed.done : [],
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      rescan: Array.isArray(parsed.rescan) ? parsed.rescan : [],
    };
  } catch {
    return { files: {}, fileUsage: {}, days: {}, done: [], pending: [], rescan: [] };
  }
}

function writeUsageState(next) {
  try {
    const file = usageStatePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 先写临时文件再改名：30 秒一次的写入中途被打断也不会留下半截 JSON，
    // 否则下一次读不到账本会从头全量重扫。
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next));
    fs.renameSync(temp, file);
  } catch {
    // 写失败只是下次多读一遍，不影响卡片出数
  }
}

/** 会话日志根目录。 */
function sessionsRoot() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(dshHome, 'sessions');
}

/** 会话日志文件名：session.vN.jsonl 或 session.vN.jsonl.zstd。 */
const SESSION_LOG = /^session(?:\.v\d+)?\.jsonl(\.zstd)?$/;

/**
 * 列出会话日志（含子代理目录），跳过近期没改动过的：它们不可能再有今天的用量。
 * @param sinceMs 只看 mtime 不早于此刻的文件
 * @returns Array<{file: string, size: number}>
 */
function listSessionLogs(sinceMs) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (SESSION_LOG.test(entry.name)) {
        try {
          const stat = fs.statSync(full);
          if (stat.mtimeMs >= sinceMs) out.push({ file: full, size: stat.size });
        } catch {
          // 文件刚被清理：跳过
        }
      }
    }
  };
  walk(sessionsRoot());
  return out;
}

/** 文件是否 zstd 压缩：只看文件头魔数，不解压。 */
function isZstdFile(file, size) {
  if (size < 8) return file.endsWith('.zstd');
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    return head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 从 JSONL 文本里取 assistant/message 的用量行。
 * 末尾没有换行的半行不是记录，留给下次。
 * @param text 一段会话日志文本
 * @param brokenFirst 第一行是否是不完整的残留（是则丢弃）
 * @returns {{records: Array<{time: number, usage: object}>, tailText: string}}
 */
function parseUsageLines(text, brokenFirst) {
  const lines = text.split('\n');
  const tailText = lines.pop() ?? '';
  if (brokenFirst && lines.length) lines.shift();
  const records = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // 坏行跳过，不影响其余行
    }
    if (event?.type !== 'assistant/message' || !event.data?.usage) continue;
    // 模型名就是分账依据：同一个模型 id 只会绑定一把 key（如 deepseek-v4.1-flash-kaiaosi）。
    records.push({
      time: Number(event.time),
      usage: event.data.usage,
      model: String(event.data?.message?.source?.model || '').trim(),
    });
  }
  return { records, tailText };
}

/**
 * 定位 zstd 帧的起点：跳过帧的 magic，再顺着帧头 + 各块头走到帧尾，
 * 这样多帧流的边界是算出来的，不会把数据里的 0x28b52ffd 当成帧头。
 * @returns 下一帧的起始字节；结构不完整（文件正在写）时返回 -1。
 */
function nextFrameOffset(buf, start) {
  try {
    const descriptor = buf[start + 4];
    const fcsFlag = descriptor >> 6;
    const single = (descriptor >> 5) & 1;
    const checksum = (descriptor >> 2) & 1;
    const dictFlag = descriptor & 3;
    let cursor = start + 5 + (single ? 0 : 1);
    cursor += [0, 1, 2, 4][dictFlag];
    cursor += [single ? 1 : 0, 2, 4, 8][fcsFlag];
    for (;;) {
      if (cursor + 3 > buf.length) return -1;
      const header = buf[cursor] | (buf[cursor + 1] << 8) | (buf[cursor + 2] << 16);
      const last = header & 1;
      const type = (header >> 1) & 3;
      const size = header >>> 3;
      cursor += 3 + (type === 1 ? 1 : size);
      if (last) break;
    }
    if (checksum) cursor += 4;
    return cursor <= buf.length ? cursor : -1;
  } catch {
    return -1;
  }
}

/**
 * 解压一份会话日志（单帧或多帧 zstd）并取出全部 assistant/message 用量。
 * 帧尾按结构推算，算不通时（旧格式/损坏）退化为「按魔数切片 + 逐个试解压」。
 * @param file 会话日志路径
 * @returns 用量行
 */
function readZstdUsage(file) {
  const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return [];
  }
  const records = [];
  let cursor = buf.indexOf(Buffer.from(MAGIC));
  while (cursor >= 0 && cursor < buf.length) {
    let next = nextFrameOffset(buf, cursor);
    let end = next;
    if (next < 0) {
      // 结构推算失败：找下一个魔数当边界，解不开就跳过
      const fallback = buf.indexOf(Buffer.from(MAGIC), cursor + 4);
      end = fallback >= 0 ? fallback : buf.length;
      next = fallback;
    }
    try {
      const text = zlib.zstdDecompressSync(buf.subarray(cursor, end)).toString('utf8');
      records.push(...parseUsageLines(text, false).records);
    } catch {
      // 解不开这一段：跳过，不影响其它帧
    }
    cursor = next;
  }
  return records;
}

/** 旧版账本（只有顶层合计、没有 models）搬进新形状：金额照抄，不再重新计价。 */
function fromLegacyDay(raw) {
  const entry = {
    input: Number(raw?.input) || 0,
    output: Number(raw?.output) || 0,
    cached: Number(raw?.cached) || 0,
    requests: Number(raw?.requests) || 0,
    costCny: Number(raw?.costCny) || 0,
    models: {},
  };
  if (entry.requests > 0) {
    entry.models['历史（未分模型）'] = {
      input: entry.input,
      output: entry.output,
      cached: entry.cached,
      requests: entry.requests,
      costCny: entry.costCny,
    };
  }
  return entry;
}

/** 把一份日账并入另一份（顶层合计 + 分模型两部分）。 */
function mergeDayInto(target, part) {
  target.input += part.input || 0;
  target.output += part.output || 0;
  target.cached += part.cached || 0;
  target.requests += part.requests || 0;
  target.costCny += part.costCny || 0;
  for (const [model, item] of Object.entries(part.models || {})) {
    const perModel = target.models[model] || (target.models[model] = { input: 0, output: 0, cached: 0, requests: 0, costCny: 0 });
    perModel.input += item.input || 0;
    perModel.output += item.output || 0;
    perModel.cached += item.cached || 0;
    perModel.requests += item.requests || 0;
    perModel.costCny += item.costCny || 0;
  }
}

/** 从某天的账里扣掉一部分（用于重扫前的回退），扣空则删掉该天。 */
function subtractDay(days, day, part) {
  const entry = days[day];
  if (!entry || !part) return;
  entry.input -= part.input || 0;
  entry.output -= part.output || 0;
  entry.cached -= part.cached || 0;
  entry.requests -= part.requests || 0;
  entry.costCny -= part.costCny || 0;
  for (const [model, modelPart] of Object.entries(part.models || {})) {
    const target = entry.models[model];
    if (!target) continue;
    target.input -= modelPart.input || 0;
    target.output -= modelPart.output || 0;
    target.cached -= modelPart.cached || 0;
    target.requests -= modelPart.requests || 0;
    target.costCny -= modelPart.costCny || 0;
    if (target.requests <= 0) delete entry.models[model];
  }
  if (entry.requests <= 0) delete days[day];
}

/** 一条空账：还没有任何用量时的初值。 */
function zeroEntry() {
  return { input: 0, output: 0, cached: 0, requests: 0, costCny: 0, models: {} };
}

/** 按模型累加：models[模型名] 与顶层合计同步增长。 */
function mergeEntry(target, item, factor = 1) {
  const usage = item.usage || {};
  const input = Number(usage.inputTokens);
  const output = Number(usage.outputTokens);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return;
  const cached = Number(usage.cacheReadTokens) || 0;
  const cacheWrite = Number(usage.cacheWriteTokens) || 0;
  const cost = recordCost(input, output, cached, cacheWrite) * factor;
  target.input += input * factor;
  target.output += output * factor;
  target.cached += cached * factor;
  target.requests += factor;
  target.costCny += cost;
  const model = item.model || '未标注模型';
  const perModel = target.models[model] || { input: 0, output: 0, cached: 0, requests: 0, costCny: 0 };
  target.models[model] = {
    input: perModel.input + input * factor,
    output: perModel.output + output * factor,
    cached: perModel.cached + cached * factor,
    requests: perModel.requests + factor,
    costCny: perModel.costCny + cost,
  };
}

/**
 * 把一条 { time, usage, model } 累加进按天账本（同时记进 models 分账）。
 * @param days 按天账本（原地修改）
 * @param item parseUsageLines 产出的用量行
 * @param cutoffMs 早于此刻的记录直接丢弃
 */
function addUsage(days, item, cutoffMs) {
  if (!Number.isFinite(item.time) || item.time < cutoffMs) return;
  const day = localDayKey(new Date(item.time));
  const entry = days[day] || zeroEntry();
  mergeEntry(entry, item, 1);
  days[day] = entry;
}

/**
 * 扫描会话日志的新增部分，把用量累加进账本。
 *
 * - 每个文件记住已消费字节，只读新增内容；
 * - 文件变短（被重新压缩/清理）时从头重读；
 * - 末尾没有换行的半行留到下次，不会重复计数；
 * - 只保留最近 USAGE_MAX_DAYS 天。
 *
 * @param now 当前时间（测试可注入）
 * @returns 最新账本 { files, days }
 */
export function syncUsageLog(now = new Date()) {
  const state = readUsageState();
  const files = {};
  for (const [file, known] of Object.entries(state.files || {})) files[file] = { ...known };
  // 每个文件各自的分账：{ 文件: { 日期: 日账 } }。重扫只替换自己那一份。
  const fileUsage = {};
  for (const [file, parts] of Object.entries(state.fileUsage || {})) {
    fileUsage[file] = {};
    for (const [day, raw] of Object.entries(parts || {})) {
      fileUsage[file][day] = raw && raw.models ? raw : fromLegacyDay(raw);
    }
  }
  // 跨天补扫：今天动过、且比上次记下的大小更大 → 整份重扫，避免丢掉早几天写入的部分。
  const done = new Set(state.done || []);
  const rescan = new Set(state.pending || []);
  const scanned = listSessionLogs(todayStart(now).getTime());
  for (const entry of scanned) {
    const known = files[entry.file];
    if (known && known.size !== undefined && entry.size > known.size && !done.has(entry.file)) {
      rescan.add(entry.file);
    }
  }
  // 重扫的文件把自己那份旧账清掉，整份重算后再填回去：既不重复计，也不丢跨天的量。
  for (const file of rescan) fileUsage[file] = {};  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - USAGE_MAX_DAYS);
  const cutoffMs = cutoff.getTime();
  for (const entry of scanned) {
    const forced = rescan.has(entry.file);
    const known = forced ? { offset: 0, broken: false } : (files[entry.file] || { offset: 0, broken: false });
    const offset = forced ? 0 : (known.offset <= entry.size ? known.offset : 0);
    // 强制的整份重扫不能被「已读完」跳过，否则分账已被清空就再也补不回来。
    if (!forced && offset >= entry.size) {
      files[entry.file] = { ...known, offset: entry.size, size: entry.size };
      continue;
    }
    let buf;
    try {
      const fd = fs.openSync(entry.file, 'r');
      try {
        buf = Buffer.alloc(entry.size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    let records;
    if (isZstdFile(entry.file, entry.size)) {
      // 压缩流无法按行偏移续读，只能整文件解一次；随后记录整个文件已消费。
      records = readZstdUsage(entry.file);
      files[entry.file] = { offset: entry.size, broken: false, size: entry.size };
    } else {
      const text = buf.toString('utf8');
      const parsed = parseUsageLines(text, Boolean(known.broken));
      records = parsed.records;
      files[entry.file] = {
        offset: offset + Buffer.byteLength(text.slice(0, text.length - parsed.tailText.length)),
        broken: parsed.tailText.length > 0 && !parsed.tailText.startsWith('{'),
        size: entry.size,
      };
    }
    // 本文件这次解析出的分账，覆盖式写入（重扫即整份刷新）。
    const contribution = fileUsage[entry.file] || (fileUsage[entry.file] = {});
    for (const item of records) {
      if (!Number.isFinite(item.time) || item.time < cutoffMs) continue;
      const day = localDayKey(new Date(item.time));
      const usage = item.usage || {};
      const input = Number(usage.inputTokens);
      const output = Number(usage.outputTokens);
      if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
      const cached = Number(usage.cacheReadTokens) || 0;
      const cacheWrite = Number(usage.cacheWriteTokens) || 0;
      const cost = recordCost(input, output, cached, cacheWrite);
      const model = item.model || '未标注模型';
      const bucket = contribution[day] || (contribution[day] = {
        input: 0, output: 0, cached: 0, requests: 0, costCny: 0, models: {},
      });
      bucket.input += input;
      bucket.output += output;
      bucket.cached += cached;
      bucket.requests += 1;
      bucket.costCny += cost;
      const perModel = bucket.models[model] || (bucket.models[model] = { input: 0, output: 0, cached: 0, requests: 0, costCny: 0 });
      perModel.input += input;
      perModel.output += output;
      perModel.cached += cached;
      perModel.requests += 1;
      perModel.costCny += cost;
    }
  }
  // 日总量 = 所有文件分账逐天相加。旧版把总量存在 days 里，这里统一由分账重建。
  const days = {};
  for (const parts of Object.values(fileUsage)) {
    for (const [day, part] of Object.entries(parts)) {
      const entry = days[day] || zeroEntry();
      mergeDayInto(entry, part);
      days[day] = entry;
    }
  }
  const oldestDay = localDayKey(cutoff);
  for (const day of Object.keys(days)) {
    if (day < oldestDay) delete days[day];
  }
  // 两段式标记：先写 pending（还没算完），算完再写 done。
  // 中途被杀时 pending 留着，下次开工会重新判定，不会因为分账被清空而丢数据。
  if (rescan.size) {
    rescan.size && writeUsageState({ files, fileUsage, days, pending: [...rescan] });
  }
  const next = { files, fileUsage, days, done: rescan.size ? [...rescan] : [...done] };
  writeUsageState(next);
  return next;
}

/**
 * 面板读数据：今日用量/花费 + 最近 7 天（今天的在最末一项）。
 *
 * @param now 当前时间（测试可注入）
 * @returns {{
 *   today: {day, input, output, cached, requests, cost},
 *   days: Array<{day, input, output, cached, requests, cost}>,
 *   rates: {hit, miss, out, usdToCny}
 * }} cost 单位为人民币元
 */
export function estimateToday(now = new Date()) {
  const { days: ledger } = syncUsageLog(now);
  const start = todayStart(now);
  const days = [];
  for (let index = 6; index >= 0; index -= 1) {
    const cursor = new Date(start);
    cursor.setDate(start.getDate() - index);
    const key = localDayKey(cursor);
    const entry = ledger[key] || {};
    days.push({
      day: key,
      input: Math.round(entry.input || 0),
      output: Math.round(entry.output || 0),
      cached: Math.round(entry.cached || 0),
      requests: Math.round(entry.requests || 0),
      cost: Math.round((entry.costCny || 0) * 10000) / 10000,
    });
  }
  const todayEntry = ledger[localDayKey(start)] || zeroEntry();
  // 按模型（模型 id 与 key 一一对应）拆出今日分账，金额从高到低。
  const models = Object.entries(todayEntry.models || {})
    .map(([model, item]) => ({
      model,
      input: Math.round(item.input),
      output: Math.round(item.output),
      cached: Math.round(item.cached),
      requests: Math.round(item.requests),
      cost: Math.round((item.costCny || 0) * 10000) / 10000,
    }))
    .sort((left, right) => right.cost - left.cost);
  // 按卡片归集：用户要的是「这张卡那把 key 的预估消耗/花费」，不按模型拆。
  // 分账依据是模型名与 key 的归属表（见 providerModels）；模型不属于任何卡片时
  // 记到 shared 池，界面上明确标注，不静默混进某张卡。
  const byProvider = {};
  for (const item of models) {
    const owners = providerModels().find((entry) => entry.models.includes(item.model));
    const bucket = owners ? owners.key : 'shared';
    const target = byProvider[bucket] || (byProvider[bucket] = { input: 0, output: 0, cached: 0, requests: 0, cost: 0 });
    target.input += item.input;
    target.output += item.output;
    target.cached += item.cached;
    target.requests += item.requests;
    target.cost += item.cost;
  }
  return {
    today: days[days.length - 1],
    days,
    models,
    byProvider,
    rates: { ...DEEPSEEK_PRICE, usdToCny: USD_TO_CNY },
  };
}

function refreshUsage() {
  try {
    latestUsage = estimateToday();
  } catch {
    latestUsage = null;
  }
}

// ---------- user settings (written from the panel's own settings form) ----------

/**
 * Where the panel keeps what the user typed in its settings form.
 *
 * Separate from the harness credential store on purpose: writing into
 * `.credentials.yaml` would touch a file other plugins depend on, while this
 * one is ours alone. The API key therefore has two possible homes — this file
 * (if the user typed one) or the credential store (the original path).
 */
function settingsPath() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(dshHome, 'storages', 'quota-panel.json');
}

function readSettings() {
  try {
    const file = settingsPath();
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeSettings(next) {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return file;
}

/**
 * A provider is one card in the sidebar. Two kinds exist:
 *   relay — an OpenAI-compatible relay, polled over HTTP for its balance;
 *   codex — the local Codex CLI, whose quota arrives over JSON-RPC.
 * Keeping both in one list is what makes "add a provider" uniform.
 */
function defaultProviders(config) {
  return [
    normalizeProvider({
      id: DEFAULT_PROVIDER_ID,
      kind: 'relay',
      name: 'AstraHub',
      baseUrl: String(config.astraBaseUrl || process.env.ASTRA_HUB_BASE_URL || DEFAULT_ASTRA_BASE_URL).trim().replace(/\/+$/, ''),
      credential: String(config.astraCredential || process.env.ASTRA_HUB_CREDENTIAL || DEFAULT_ASTRA_CREDENTIAL).trim(),
      apiKey: '',
    }),
    normalizeProvider({ id: CODEX_PROVIDER_ID, kind: 'codex', name: 'Codex' }),
  ];
}

/** A stable id for a provider the settings page just added. */
function providerId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeProvider(raw, fallbackKey = '') {
  const kind = raw.kind === 'codex' ? 'codex' : 'relay';
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
  if (kind === 'codex') {
    // A codex provider only needs a name: the quota comes from the local CLI.
    return {
      id: String(raw.id || providerId()),
      kind,
      name: String(raw.name || '').trim() || 'Codex',
      baseUrl: '',
      credential: '',
      apiKey: '',
    };
  }
  return {
    id: String(raw.id || providerId()),
    kind,
    name: String(raw.name || '').trim() || '未命名供应商',
    baseUrl: String(raw.baseUrl || '').trim().replace(/\/+$/, ''),
    // Optional single balance endpoint (e.g. DeepSeek's /user/balance). Empty
    // means the new-api pair of billing endpoints is used instead.
    balanceUrl: String(raw.balanceUrl || '').trim(),
    // Kept only as a compatibility fallback for installs configured before the
    // card had a key field. Never defaulted: inheriting another provider's
    // credential would silently send its key to a different relay.
    credential: String(raw.credential || '').trim(),
    // An empty key from the form keeps whatever this provider already had.
    apiKey: raw.clearApiKey === true ? '' : apiKey || fallbackKey,
    // Which JSON fields feed the card. Empty means the defaults apply.
    map: normalizeMap(raw.map),
    // 这张卡在 DSH 里对应的模型名（逗号分隔）。填了就只统计这些模型的用量，
    // 因为 DSH 里「模型 → key」是绑定的；不填则不参与分账。
    models: Array.isArray(raw.models)
      ? raw.models.map((value) => String(value).trim()).filter(Boolean)
      : String(raw.models || '').split(/[,，\s]+/).map((value) => value.trim()).filter(Boolean),
  };
}

/**
 * The configured providers, in the order the settings page lists them.
 *
 * Migrates the older single-relay shape (`astraBaseUrl`/`astraCredential`/
 * `astraApiKey` at the top level) so an existing install keeps working, and
 * seeds the defaults when nothing is saved yet.
 */
function effectiveProviders(config) {
  const saved = readSettings();
  if (Array.isArray(saved.providers)) {
    // No kind-based dedupe: several Codex cards are allowed (one per account the
    // user wants to label), each with its own name.
    return saved.providers
      .filter((item) => item && typeof item === 'object')
      .slice(0, MAX_PROVIDERS)
      .map((item) => normalizeProvider(item));
  }
  if (saved.astraBaseUrl || saved.astraCredential || saved.astraApiKey) {
    return [
      normalizeProvider({
        id: DEFAULT_PROVIDER_ID,
        kind: 'relay',
        name: 'AstraHub',
        baseUrl: saved.astraBaseUrl || DEFAULT_ASTRA_BASE_URL,
        credential: saved.astraCredential || DEFAULT_ASTRA_CREDENTIAL,
        apiKey: saved.astraApiKey || '',
      }),
      normalizeProvider({ id: CODEX_PROVIDER_ID, kind: 'codex', name: 'Codex' }),
    ];
  }
  return defaultProviders(config);
}

/**
 * One URL field is enough: a URL that carries a path is itself the balance
 * endpoint (`https://api.deepseek.com/user/balance`), a bare origin means the
 * new-api pair of billing endpoints. Returns the parts fetchBilling needs.
 */
function splitEndpoint(rawUrl) {
  const url = String(rawUrl || '').trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(url);
    const path = parsed.pathname && parsed.pathname !== '/' ? `${parsed.pathname}${parsed.search}` : '';
    return { origin: `${parsed.protocol}//${parsed.host}`, balancePath: path };
  } catch {
    return { origin: url, balancePath: '' };
  }
}

/**
 * 请求只应来自本机页面。
 *
 * 宿主 Web 服务没有会话校验，而这些接口能读凭据、能替调用方发外部请求。
 * 浏览器里任意页面都能对 127.0.0.1 发跨站 POST（text/plain 不触发预检），
 * DNS rebinding 还能让 evil.example 以同源身份读到响应。隧道代理会把
 * Host/Origin 重写成上游地址，所以两条检查都按「本机」收敛：
 *   - Host 必须是回环地址（挡住 rebinding：Host 仍是 evil.example）；
 *   - Origin 若存在，必须等于宿主自身来源（挡住跨站请求伪造）。
 */
function isLoopbackHost(hostHeader) {
  if (!hostHeader) return false;
  const host = String(hostHeader).trim().toLowerCase();
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1';
}

function isSameOrigin(originHeader, selfOrigin) {
  const origin = String(originHeader || '').trim()
  if (!origin) return true // 非浏览器客户端（curl / 测试）不带 Origin
  if (origin === 'null') return false // file:// 或 sandbox iframe
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  // 只放行回环来源：localhost 与 127.0.0.1 视为同一个服务（端口必须一致）。
  // evil.example 即使解析到 127.0.0.1，Origin 仍是它自己的域名，过不了这一关。
  if (!/^https?:$/.test(parsed.protocol) || !isLoopbackHost(parsed.host)) return false
  if (!selfOrigin) return true
  try {
    return new URL(selfOrigin).port === parsed.port
  } catch {
    return false
  }
}

/**
 * Usage + subscription for one relay. Errors are values, never throws.
 * Codex providers return no numbers here: theirs come from the JSON-RPC client
 * at the top of the state, so this poll would only make them stale.
 */
async function fetchProviderState(provider) {
  if (provider.kind === 'codex') {
    return { key: provider.id, kind: 'codex', name: provider.name };
  }
  // A key typed into the settings form wins; otherwise read the credential store.
  const apiKey = provider.apiKey || readDshCredential(provider.credential);
  // An explicit balanceUrl (older configs) still wins over the address rules.
  const legacySingle = provider.balanceUrl
    ? { single: provider.baseUrl ? `${splitEndpoint(provider.baseUrl).origin}${provider.balanceUrl.startsWith('/') ? '' : '/'}${provider.balanceUrl}` : provider.balanceUrl }
    : null;
  const endpoints = legacySingle || resolveEndpoints(provider.baseUrl || DEFAULT_ASTRA_BASE_URL);
  if (!apiKey) {
    return { ...toRelayWidgetState(null, { missingKey: true }), key: provider.id, kind: 'relay', name: provider.name };
  }
  const raw = await fetchBilling(endpoints, apiKey);
  // Single-endpoint providers have no usage/subscription keys: the whole body is
  // the payload, so "did we get anything" is simply "is it non-null".
  const empty = endpoints.single
    ? !raw.combined
    : (!raw.combined.usage && !raw.combined.subscription);
  if (empty) {
    return { ...toRelayWidgetState(null, { error: true }), key: provider.id, kind: 'relay', name: provider.name };
  }
  const amounts = computeAmounts(raw.combined, provider.map);
  // The daily baseline is kept in hundredths, like the default mapping's scale.
  const spentCents = amounts.spent * 100;
  const todaySpent = Number.isFinite(spentCents) ? trackDay(provider.id, spentCents) : null;
  return {
    ...toRelayWidgetState(amounts, { todaySpent }),
    // 接口原值：卡片上用 compactAmount（12.5），悬浮窗用这里（12.53），两者不能共用。
    remainingExact: Number.isFinite(amounts.remaining) ? amounts.remaining : null,
    spentExact: Number.isFinite(amounts.spent) ? amounts.spent : null,
    grantedExact: Number.isFinite(amounts.granted) ? amounts.granted : null,
    key: provider.id,
    kind: 'relay',
    name: provider.name,
  };
}

// ---------- plugin body ----------

export function apply(ctx, config) {
  const state = { ...emptyWidgetState(), codexOk: false };

  const codex = new CodexQuotaClient();
  codex.onQuota = (quota) => {
    state.fiveHour = quota.fiveHour;
    state.weekly = quota.weekly;
    state.resets = quota.resets;
    state.codexOk = true;
  };
  codex.onOffline = () => {
    state.codexOk = false;
  };

  // First attempt right away; the 5s timer keeps retrying through refresh(),
  // which re-discovers the executable and respawns after a crash or upgrade.
  try {
    codex.start(locateCodex());
  } catch {
    state.codexOk = false;
  }

  // Effective providers, re-read whenever the user saves the settings page.
  // Precedence: saved settings > plugin config > env vars > defaults.
  let providers = effectiveProviders(config);
  let generation = 0;
  let lastRelayRefresh = 0;
  let relayRefresh = null;
  const refreshProviders = async () => {
    const mine = ++generation;
    const results = await Promise.all(providers.map((provider) => fetchProviderState(provider)));
    if (mine !== generation) return; // a save replaced the list mid-flight
    lastRelayRefresh = Date.now();
    state.providers = results;
    // Compatibility: a client bundle from before the multi-provider change
    // reads `astra` and would show an empty card without this.
    const firstRelay = results.find((item) => item.kind !== 'codex');
    state.astra = firstRelay
      ? {
          name: firstRelay.name,
          remaining: firstRelay.remaining,
          spent: firstRelay.spent,
          granted: firstRelay.granted,
          todaySpent: firstRelay.todaySpent,
          color: firstRelay.color,
          reset: firstRelay.reset,
        }
      : null;
  };
  /** 客户端每次拉数据时调用：只有「数据够旧」且没有在飞请求时才真正去拉。 */
  const maybeRefreshRelays = () => {
    if (relayRefresh) return relayRefresh;
    if (Date.now() - lastRelayRefresh < ASTRA_MIN_AGE_MS) return null;
    relayRefresh = refreshProviders().catch(() => {}).finally(() => { relayRefresh = null });
    return relayRefresh;
  };

  refreshProviders();
  refreshUsage();

  const timer = setInterval(() => {
    codex.refresh();
  }, REFRESH_MS);
  timer.unref?.();

  const astraTimer = setInterval(refreshProviders, ASTRA_REFRESH_MS);
  astraTimer.unref?.();

  // 今日用量来自本机日志，读盘很便宜，间隔比余额短。
  const usageTimer = setInterval(refreshUsage, USAGE_REFRESH_MS);
  usageTimer.unref?.();

  /** What the settings page shows: never a key, only whether one exists. */
  const settingsPayload = () => ({
    providers: providers.map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      name: provider.name,
      baseUrl: provider.baseUrl,
      balanceUrl: provider.balanceUrl,
      credential: provider.credential,
      models: provider.models || [],
      hasApiKey: Boolean(provider.apiKey) || Boolean(readDshCredential(provider.credential)),
      map: provider.map,
    })),
    defaults: DEFAULT_MAP,
    settingsFile: settingsPath(),
  });

  const readBody = (req) => new Promise((resolve) => {
    let raw = '';
    let overflow = false;
    req.on('data', (chunk) => {
      if (overflow) return;
      raw += chunk;
      // 超过上限就整个丢弃并要求重发；截断后再 JSON.parse 只会得到假的「格式错误」。
      if (raw.length > 64 * 1024) {
        overflow = true;
        raw = '';
      }
    });
    req.on('end', () => resolve(overflow ? null : raw));
    req.on('error', () => resolve(null));
  });

  ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-quota',
    handler: async (req, res) => {
      const url = req.url || '';
      const pathname = url.split('?')[0];
      const json = (status, payload) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify(payload));
      };
      const selfOrigin = (() => {
        try {
          return new URL(ctx.webServer.getOrigin?.() ?? '').origin;
        } catch {
          return '';
        }
      })();
      // 没有会话校验的接口只能信任「本机 + 同源」这一对前提，见 isLoopbackHost 注释。
      if (!isLoopbackHost(req.headers?.host)) {
        json(403, { error: 'forbidden-host' });
        return;
      }
      if (!isSameOrigin(req.headers?.origin, selfOrigin)) {
        json(403, { error: 'forbidden-origin' });
        return;
      }
      if (pathname === '/dsh-quota/api/balance' || pathname === '/dsh-quota/api/balance/') {
        // 不 await：先把当前状态返回，刷新完成后下一次轮询（5s 后）就能看到新数。
        maybeRefreshRelays();
        json(200, state);
        return;
      }
      // Fetch a relay's billing endpoints and hand the raw JSON back, so the
      // settings page can show real field names before the user maps any.
      if (pathname === '/dsh-quota/api/probe' || pathname === '/dsh-quota/api/probe/') {
        if ((req.method || '').toUpperCase() !== 'POST') {
          json(405, { error: 'method-not-allowed' });
          return;
        }
        let body;
        try {
          const text = await readBody(req);
          if (text === null) {
            json(413, { error: 'body-too-large' });
            return;
          }
          body = JSON.parse(text);
        } catch {
          json(400, { error: 'bad-json' });
          return;
        }
        const saved = providers.find((provider) => provider.id === body?.providerId) || null;
        const baseUrl = String(body?.baseUrl || saved?.baseUrl || '').trim().replace(/\/+$/, '');
        if (!baseUrl) {
          json(400, { error: 'missing-base-url' });
          return;
        }
        if (!/^https?:\/\//i.test(baseUrl)) {
          json(400, { error: 'unsupported-scheme' });
          return;
        }
        // A key typed but not saved yet always wins. A *stored* key is only sent
        // back to the site that stored it: the probe takes its target from the
        // request, so mirroring the saved credential to any host would let a
        // cross-site POST walk off with it (Authorization header and all).
        const typedKey = String(body?.apiKey || '').trim();
        const targetOrigin = splitEndpoint(baseUrl).origin.toLowerCase();
        const savedOrigin = splitEndpoint(saved?.baseUrl || '').origin.toLowerCase();
        const storedKey = saved && targetOrigin === savedOrigin
          ? (saved.apiKey || readDshCredential(saved.credential))
          : '';
        const apiKey = typedKey || storedKey;
        if (!apiKey) {
          json(400, { error: 'missing-api-key' });
          return;
        }
        // Probe uses exactly the same address rules as the poller.
        const legacyBalance = String(body?.balanceUrl || saved?.balanceUrl || '').trim();
        const endpoints = legacyBalance
          ? { single: /^https?:\/\//i.test(legacyBalance) ? legacyBalance : `${splitEndpoint(baseUrl).origin}${legacyBalance.startsWith('/') ? '' : '/'}${legacyBalance}` }
          : resolveEndpoints(baseUrl);
        const raw = await fetchBilling(endpoints, apiKey);
        const map = normalizeMap(body?.map || saved?.map);
        const amounts = computeAmounts(raw.combined, map);
        json(200, {
          combined: raw.combined,
          errors: raw.errors,
          map,
          amounts: {
            spent: Number.isFinite(amounts.spent) ? amounts.spent : null,
            granted: Number.isFinite(amounts.granted) ? amounts.granted : null,
            remaining: Number.isFinite(amounts.remaining) ? amounts.remaining : null,
          },
        });
        return;
      }
      if (pathname === '/dsh-quota/api/usage' || pathname === '/dsh-quota/api/usage/') {
        // 打开每日面板时先同步一次：刚发完请求就点，不该等下一个 30s 周期。
        refreshUsage();
        json(200, latestUsage || { today: null, days: [], rates: null });
        return;
      }
      if (pathname === '/dsh-quota/api/settings' || pathname === '/dsh-quota/api/settings/') {
        if ((req.method || 'GET').toUpperCase() === 'GET') {
          json(200, settingsPayload());
          return;
        }
        if ((req.method || '').toUpperCase() === 'POST') {
          let body;
          try {
            const text = await readBody(req);
            if (text === null) {
              json(413, { error: 'body-too-large' });
              return;
            }
            body = JSON.parse(text);
          } catch {
            json(400, { error: 'bad-json' });
            return;
          }
          if (!Array.isArray(body?.providers)) {
            json(400, { error: 'expected-providers-array' });
            return;
          }
          // The whole list is replaced: adding, editing and deleting all arrive here.
          const previous = new Map(providers.map((provider) => [provider.id, provider]));
          const next = body.providers
            .filter((item) => item && typeof item === 'object')
            .slice(0, MAX_PROVIDERS)
            // A card the user never filled in is not worth storing. A codex
            // card is complete as soon as it exists, so it never matches this.
            .filter((item) => item.kind === 'codex'
              || String(item.baseUrl || '').trim()
              || String(item.name || '').trim()
              || String(item.apiKey || '').trim())
            .map((item) => normalizeProvider(item, previous.get(String(item.id))?.apiKey || ''));
          try {
            writeSettings({ providers: next });
          } catch (error) {
            json(500, { error: 'write-failed', message: String(error && error.message) });
            return;
          }
          providers = next;
          await refreshProviders();
          json(200, settingsPayload());
          return;
        }
        json(405, { error: 'method-not-allowed' });
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    },
  });

  ctx.effect(
    () => () => {
      clearInterval(timer);
      clearInterval(astraTimer);
      clearInterval(usageTimer);
      abortInflight();
      codex.stop();
    },
    'quota-panel: lifecycle',
  );
}
