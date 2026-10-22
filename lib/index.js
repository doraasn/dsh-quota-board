/**
 * dsh-quota-panel — host half.
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
const ASTRA_TIMEOUT_MS = 8000;

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

function resetLabel(unixSeconds, now = new Date()) {
  const seconds = Number(unixSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const target = new Date(seconds * 1000);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTarget = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  const dayOffset = Math.round((startOfTarget - startOfToday) / 86400000);
  const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(target);
  // Kept short: the sidebar column is ~110px wide per metric.
  if (dayOffset === 0) return time;
  if (dayOffset === 1) return `明天 ${time}`;
  return `${target.getMonth() + 1}/${target.getDate()} ${time}`;
}

function toWidgetState(result, now = new Date()) {
  const keyed = result?.rateLimitsByLimitId;
  const firstKeyed = keyed && typeof keyed === 'object' ? Object.values(keyed)[0] : null;
  const limits = result?.rateLimits ?? firstKeyed;
  const buildWindow = (name, source) => {
    const remaining = remainingPercent(source?.usedPercent);
    return { name, remaining, color: quotaColor(remaining), reset: resetLabel(source?.resetsAt, now) };
  };
  return {
    fiveHour: buildWindow('5 小时', limits?.primary),
    weekly: buildWindow('周', limits?.secondary),
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
    weekly: { name: '周', remaining: null, color: quotaColor(null), reset: '' },
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
    this.#child?.kill();
    this.#child = null;
    this.#ready = false;
    this.#pending = null;
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
    this.#child?.stdin.write(`${JSON.stringify(message)}\n`);
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
    const pattern = new RegExp(`${name}\\s*[:=]\\s*["']?([A-Za-z0-9_\\-]+)`);
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
async function fetchBilling(endpoints, apiKey) {
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
  const one = async (url) => {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(ASTRA_TIMEOUT_MS) });
      const text = (await response.text()).slice(0, 65536);
      if (!response.ok) return { ok: false, status: response.status, detail: text.slice(0, 300) };
      try {
        return { ok: true, body: JSON.parse(text) };
      } catch {
        return { ok: false, status: response.status, detail: `not JSON: ${text.slice(0, 200)}` };
      }
    } catch (error) {
      return { ok: false, status: 0, detail: String(error && error.message).slice(0, 300) };
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
  return { ...toRelayWidgetState(amounts, { todaySpent }), key: provider.id, kind: 'relay', name: provider.name };
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
  const refreshProviders = async () => {
    const mine = ++generation;
    const results = await Promise.all(providers.map((provider) => fetchProviderState(provider)));
    if (mine !== generation) return; // a save replaced the list mid-flight
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
  refreshProviders();

  const timer = setInterval(() => {
    codex.refresh();
  }, REFRESH_MS);
  timer.unref?.();

  const astraTimer = setInterval(refreshProviders, ASTRA_REFRESH_MS);
  astraTimer.unref?.();

  /** What the settings page shows: never a key, only whether one exists. */
  const settingsPayload = () => ({
    providers: providers.map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      name: provider.name,
      baseUrl: provider.baseUrl,
      balanceUrl: provider.balanceUrl,
      credential: provider.credential,
      hasApiKey: Boolean(provider.apiKey) || Boolean(readDshCredential(provider.credential)),
      map: provider.map,
    })),
    defaults: DEFAULT_MAP,
    settingsFile: settingsPath(),
  });

  const readBody = (req) => new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) raw = raw.slice(0, 64 * 1024);
    });
    req.on('end', () => resolve(raw));
    req.on('error', () => resolve(''));
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
      if (pathname === '/dsh-quota/api/balance' || pathname === '/dsh-quota/api/balance/') {
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
          body = JSON.parse(await readBody(req));
        } catch {
          json(400, { error: 'bad-json' });
          return;
        }
        const saved = providers.find((provider) => provider.id === body?.providerId) || null;
        const baseUrl = String(body?.baseUrl || saved?.baseUrl || '').trim().replace(/\/+$/, '');
        // A key typed but not saved yet wins; otherwise use the saved one.
        const apiKey = String(body?.apiKey || '').trim() || saved?.apiKey || readDshCredential(saved?.credential);
        if (!baseUrl) {
          json(400, { error: 'missing-base-url' });
          return;
        }
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
      if (pathname === '/dsh-quota/api/settings' || pathname === '/dsh-quota/api/settings/') {
        if ((req.method || 'GET').toUpperCase() === 'GET') {
          json(200, settingsPayload());
          return;
        }
        if ((req.method || '').toUpperCase() === 'POST') {
          let body;
          try {
            body = JSON.parse(await readBody(req));
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
      codex.stop();
    },
    'quota-panel: lifecycle',
  );
}
