/**
 * Smart KuCoin Futures Pre-Pump Scanner — FINAL
 * ---------------------------------------------
 * - Daily O→C pump guard: skip if > DAILY_PUMP_SKIP_RATIO (default 20%)
 * - Gating: pass if EITHER of the following is true (set REQUIRE_BOTH_GATES=true to require both):
 *    (A) 1D volume today ≥ VOLUME_SPIKE_RATIO × prior historical max (5pm→5pm aligned)
 *    (B) At least one 15m candle intrabar jump > PRICE_JUMP_RATIO (default 10%)
 * - Optional confluence (non-gating): Turnover spike, OBV impulse, Squeeze→Breakout, 1m Whale Sweeps, funding rate bias
 * - Simple scoring surfaces near-misses; second email table lists high-confluence near-misses.
 *
 * Requires: npm i axios dayjs nodemailer node-cron p-limit dotenv
 */

////////////////////////////////////////////////////////////////////////////////
// Setup & Imports
////////////////////////////////////////////////////////////////////////////////
require('dotenv').config();
const axios = require('axios');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
const nodemailer = require('nodemailer');
const cron = require('node-cron');

dayjs.extend(utc);
dayjs.extend(tz);
dayjs.tz.setDefault(process.env.TZ || 'America/Vancouver'); // PST/PDT handling

////////////////////////////////////////////////////////////////////////////////
// CONFIG (env-first, with sane defaults)
////////////////////////////////////////////////////////////////////////////////
const CFG = {
  // API
  BASE_URL: process.env.KUCOIN_BASE_URL || 'https://api-futures.kucoin.com/api/v1',
  REQUEST_TIMEOUT_MS: +process.env.REQUEST_TIMEOUT_MS || 20_000,

  // Core detectors
  PRICE_JUMP_RATIO: +process.env.PRICE_JUMP_RATIO || 0.10, // >10% intrabar
  GRANULARITY_MIN: +process.env.GRANULARITY_MIN || 15,

  // Gating strictness
  REQUIRE_BOTH_GATES: envBool(process.env.REQUIRE_BOTH_GATES, false),

  // Daily pump filter
  ENABLE_DAILY_PUMP_FILTER: envBool(process.env.ENABLE_DAILY_PUMP_FILTER, true),
  DAILY_PUMP_SKIP_RATIO: +process.env.DAILY_PUMP_SKIP_RATIO || 0.20, // >20% skipped

  // Volume spike
  ENABLE_VOLUME_SPIKE: envBool(process.env.ENABLE_VOLUME_SPIKE, true),
  VOLUME_SPIKE_RATIO: +process.env.VOLUME_SPIKE_RATIO || 1.10, // ≥1.10× prev max

  // Optional context (non-gating)
  ENABLE_COMPRESSION_EXPANSION: envBool(process.env.ENABLE_COMPRESSION_EXPANSION, true),
  CE_TR_LOOKBACK: +process.env.CE_TR_LOOKBACK || 96,
  CE_TR_WINDOW: +process.env.CE_TR_WINDOW || 16,
  CE_TR_RATIO_MAX: +process.env.CE_TR_RATIO_MAX || 0.70,
  CE_VOL_Z_MIN: +process.env.CE_VOL_Z_MIN || 1.20,
  CE_NEAR_HIGH_PCT: +process.env.CE_NEAR_HIGH_PCT || 0.05,

  ENABLE_VWAP_DRIFT: envBool(process.env.ENABLE_VWAP_DRIFT, true),
  VWAP_WINDOW: +process.env.VWAP_WINDOW || 32,
  VWAP_STREAK: +process.env.VWAP_STREAK || 2,
  VWAP_DEV_MIN: +process.env.VWAP_DEV_MIN || 0.002,
  VWAP_VOL_Z_MIN: +process.env.VWAP_VOL_Z_MIN || 0.50,

  // NEW confluence signals (non-gating, contribute to score)
  ENABLE_TURNOVER_SPIKE: envBool(process.env.ENABLE_TURNOVER_SPIKE, true),
  TURNOVER_Z_MIN: +process.env.TURNOVER_Z_MIN || 1.8,
  TURNOVER_V_RATIO_MIN: +process.env.TURNOVER_V_RATIO_MIN || 1.25,

  ENABLE_OBV_IMPULSE: envBool(process.env.ENABLE_OBV_IMPULSE, true),
  OBV_Z_MIN: +process.env.OBV_Z_MIN || 1.6,

  ENABLE_SQUEEZE_BREAKOUT: envBool(process.env.ENABLE_SQUEEZE_BREAKOUT, true),
  SQZ_BB_PERIOD: +process.env.SQZ_BB_PERIOD || 20,
  SQZ_KC_PERIOD: +process.env.SQZ_KC_PERIOD || 20,
  SQZ_KC_MULT: +process.env.SQZ_KC_MULT || 1.5,
  SQZ_VOL_Z_MIN: +process.env.SQZ_VOL_Z_MIN || 1.0,
  SQZ_CLOSE_NEAR_HIGH_PCT: +process.env.SQZ_CLOSE_NEAR_HIGH_PCT || 0.30,

  ENABLE_1M_WHALE_SWEEPS: envBool(process.env.ENABLE_1M_WHALE_SWEEPS, true),
  M1_LOOKBACK_MIN: +process.env.M1_LOOKBACK_MIN || 60,
  M1_VOL_Z_MIN: +process.env.M1_VOL_Z_MIN || 2.0,
  M1_CLOSE_NEAR_HIGH_PCT: +process.env.M1_CLOSE_NEAR_HIGH_PCT || 0.25,
  M1_MIN_SWEEPS: +process.env.M1_MIN_SWEEPS || 1,

  // Funding rate bias
  ENABLE_FUNDING_RATE_BIAS: envBool(process.env.ENABLE_FUNDING_RATE_BIAS, true),
  FUNDING_RATE_THRESHOLD: +process.env.FUNDING_RATE_THRESHOLD || 0.0005,

  // scoring
  W_VOL_SPIKE: +process.env.W_VOL_SPIKE || 2.0,
  W_15M_JUMP: +process.env.W_15M_JUMP || 1.5,
  W_TURNOVER: +process.env.W_TURNOVER || 1.2,
  W_OBV: +process.env.W_OBV || 1.0,
  W_SQUEEZE: +process.env.W_SQUEEZE || 1.0,
  W_M1_WHALE: +process.env.W_M1_WHALE || 1.3,
  W_FUNDING_RATE: +process.env.W_FUNDING_RATE || 0.8,
  SCORE_ALERT_MIN: +process.env.SCORE_ALERT_MIN || 2.6,
  ALT_SCORE_PASS_MIN: +process.env.ALT_SCORE_PASS_MIN || 4.0,

  // Batch / concurrency
  BATCH_SIZE: +process.env.BATCH_SIZE || 22,
  CONCURRENCY: +process.env.CONCURRENCY || 2,
  SLEEP_BETWEEN_BATCHES_MS: +process.env.SLEEP_BETWEEN_BATCHES_MS || 10_000,

  // Email
  EMAIL_ENABLED: envBool(process.env.EMAIL_ENABLED, true),
  EMAIL_FROM: process.env.EMAIL_FROM || '',
  EMAIL_PASS: process.env.EMAIL_PASS || '',
  EMAIL_TO: process.env.EMAIL_TO || '',
  EMAIL_DRY_RUN: envBool(process.env.EMAIL_DRY_RUN, false), // log instead of send

  // Scheduling
  DAILY_SCAN_CRON: process.env.DAILY_SCAN_CRON || '0 17 * * *', // 5pm local
  SCHEDULE_ENABLED: envBool(process.env.SCHEDULE_ENABLED, true),

  // Debug switches
  LOG_LEVEL: process.env.LOG_LEVEL || 'info', // 'silent'|'warn'|'info'|'debug'|'trace'
  LOG_PER_CANDLE: envBool(process.env.LOG_PER_CANDLE, false), // show first candle map
  TRACE_HTTP: envBool(process.env.TRACE_HTTP, false), // print request/response labels
  DUMP_JSON: envBool(process.env.DUMP_JSON, false), // dumps raw JSON on near-misses/winners
  DUMP_LIMIT: +process.env.DUMP_LIMIT || 3, // how many dumps per run
  SANITY_SAMPLE: envBool(process.env.SANITY_SAMPLE, false), // short-circuit to first 50 symbols
};

function envBool(v, def) {
  if (v === undefined) return def;
  return /^1|true|yes|on$/i.test(String(v).trim());
}

////////////////////////////////////////////////////////////////////////////////
// Logging
////////////////////////////////////////////////////////////////////////////////
const ll = ['silent','warn','info','debug','trace'];
const LIDX = Math.max(0, ll.indexOf(CFG.LOG_LEVEL));
function logAt(level, ...args) { if (ll.indexOf(level) <= LIDX && ll.indexOf(level)>=0) console.log(ts(), ...args); }
const log = {
  warn: (...a)=>logAt('warn', ...a),
  info: (...a)=>logAt('info', ...a),
  debug:(...a)=>logAt('debug',...a),
  trace:(...a)=>logAt('trace',...a),
};
function ts(){ return dayjs().format('HH:mm:ss'); }

////////////////////////////////////////////////////////////////////////////////
/** AXIOS with tracing and rate-limit friendly retries */
////////////////////////////////////////////////////////////////////////////////
const metrics = mkMetrics();
const api = axios.create({ baseURL: CFG.BASE_URL, timeout: CFG.REQUEST_TIMEOUT_MS });

api.interceptors.request.use((config) => {
  config.metadata = { start: Date.now(), label: config._label || config.url };
  if (CFG.TRACE_HTTP) log.trace(`➡️  ${config.metadata.label}`);
  metrics.requests++;
  return config;
});
api.interceptors.response.use(
  (res) => {
    metrics.ok2xx++;
    if (CFG.TRACE_HTTP) {
      const ms = Date.now() - res.config.metadata.start;
      log.trace(`✅ ${res.config.metadata.label} (${res.status}) in ${ms}ms`);
    }
    return res;
  },
  (err) => {
    const cfg = err.config || {};
    const ms = cfg.metadata?.start ? (Date.now() - cfg.metadata.start) : 'n/a';
    const status = err.response?.status;
    const label = cfg.metadata?.label || cfg.url || 'request';
    if (status === 429) {
      metrics.rate429++;
      log.warn(`📉 429 ${label} in ${ms}ms`);
    } else {
      metrics.errors++;
      log.warn(`❌ ${label} failed in ${ms}ms — ${status || 'NO_STATUS'}: ${err.message}`);
    }
    return Promise.reject(err);
  }
);

function mkMetrics() {
  return {
    startedAt: null,
    finishedAt: null,
    requests: 0,
    ok2xx: 0,
    rate429: 0,
    errors: 0,
    pauses: 0,
    retries: 0,
    retrySuccess: 0,
    retryFail: 0,
    emailsSent: 0,
  };
}

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
let globalPause = Promise.resolve();

async function pauseAll(ms, reason='rate limiting') {
  metrics.pauses++;
  log.warn(`⏸️ Pause ${ms/1000}s due to ${reason}...`);
  globalPause = sleep(ms);
  return globalPause;
}

async function retryOnRateLimit(fetchFn, label) {
  try {
    await globalPause;
    return await fetchFn();
  } catch (err) {
    if (err.response && err.response.status === 429) {
      metrics.retries++;
      await pauseAll(31_000, '429');
      try {
        const out = await fetchFn();
        metrics.retrySuccess++;
        log.debug(`🔁 Retry OK: ${label}`);
        return out;
      } catch (err2) {
        metrics.retryFail++;
        log.warn(`❌ Retry failed: ${label}: ${err2.message}`);
        return null;
      }
    }
    return null;
  }
}

////////////////////////////////////////////////////////////////////////////////
// Time window (aligned to 5pm local)
////////////////////////////////////////////////////////////////////////////////
function getDailyWindow5pmLocal() {
  const nowLocal = dayjs().tz();
  const fivePmToday = nowLocal.hour(17).minute(0).second(0).millisecond(0);
  const endLocal = nowLocal.isBefore(fivePmToday) ? fivePmToday.subtract(1, 'day') : fivePmToday;
  const startLocal = endLocal.subtract(1, 'day');
  return { startLocal, endLocal, fromMsUtc: startLocal.utc().valueOf(), toMsUtc: endLocal.utc().valueOf() };
}

////////////////////////////////////////////////////////////////////////////////
// Email
////////////////////////////////////////////////////////////////////////////////
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: CFG.EMAIL_FROM, pass: CFG.EMAIL_PASS },
});

async function sendEmail(subject, bodyText, bodyHtml) {
  if (!CFG.EMAIL_ENABLED) { log.info('✉️  Email disabled. Skipping.'); return; }
  if (!CFG.EMAIL_FROM || !CFG.EMAIL_PASS || !CFG.EMAIL_TO) {
    log.warn('✉️  Email not configured (FROM/PASS/TO). Skipping.');
    return;
  }
  if (CFG.EMAIL_DRY_RUN) {
    log.info(`✉️  [DRY RUN] ${subject}\n${bodyText}`);
    return;
  }
  try {
    await transporter.sendMail({ from: CFG.EMAIL_FROM, to: CFG.EMAIL_TO, subject, text: bodyText, html: bodyHtml });
    metrics.emailsSent++;
    log.info(`📨 Email sent: ${subject}`);
  } catch (err) {
    metrics.errors++;
    log.warn(`❌ Email error: ${err.message}`);
  }
}

////////////////////////////////////////////////////////////////////////////////
// API helpers
////////////////////////////////////////////////////////////////////////////////
async function fetchSymbols() {
  const fetchFn = async () => {
    const res = await api.get('/contracts/active', { _label: 'GET /contracts/active' });
    const list = res.data.data
      .map(c => ({
        fullSymbol: c.symbol,
        baseSymbol: `K${c.baseCurrency}`,
        fundingRate: Number(c.fundingFeeRate)
      }))
      .sort((a, b) => a.fullSymbol.localeCompare(b.fullSymbol));
    return list;
  };
  const out = await retryOnRateLimit(fetchFn, 'symbols');
  if (!out) return [];
  log.info(`🧾 Active symbols: ${out.length}`);
  return out;
}

/** KuCoin kline tuple: [time, open, close, high, low, volume, turnover] */
async function fetchKlines(symbol, granularity, fromMsUtc, toMsUtc, label) {
  const url = `/kline/query?symbol=${encodeURIComponent(symbol)}&granularity=${granularity}&from=${fromMsUtc}&to=${toMsUtc}`;
  const fetchFn = async () => {
    const res = await api.get(url, { _label: label });
    const arr = Array.isArray(res.data?.data) ? res.data.data : [];
    return arr;
  };
  return retryOnRateLimit(fetchFn, label);
}

async function fetch15mCandles(symbol) {
  const { startLocal, endLocal, fromMsUtc, toMsUtc } = getDailyWindow5pmLocal();
  const arr = await fetchKlines(symbol, CFG.GRANULARITY_MIN, fromMsUtc, toMsUtc, `GET kline 15m ${symbol}`);
  const winStr = `${startLocal.format('YYYY-MM-DD HH:mm z')} → ${endLocal.format('YYYY-MM-DD HH:mm z')}`;
  if (!arr || arr.length === 0) log.warn(`⚠️ ${symbol}: empty 15m for ${winStr}`);
  else log.debug(`📊 ${symbol}: ${arr.length} candles (15m) — ${winStr}`);
  return arr || [];
}

async function fetch1mCandles(symbol) {
  const { startLocal, endLocal, fromMsUtc, toMsUtc } = getDailyWindow5pmLocal();
  const arr = await fetchKlines(symbol, 1, fromMsUtc, toMsUtc, `GET kline 1m ${symbol}`);
  const winStr = `${startLocal.format('YYYY-MM-DD HH:mm z')} → ${endLocal.format('YYYY-MM-DD HH:mm z')}`;
  if (!arr || arr.length === 0) log.debug(`⚠️ ${symbol}: empty 1m for ${winStr}`);
  return Array.isArray(arr) ? arr.slice(-CFG.M1_LOOKBACK_MIN) : [];
}

function signalFundingRateBias(rate) {
  if (!CFG.ENABLE_FUNDING_RATE_BIAS) return null;
  if (!isFinite(rate)) return null;
  const pass = Math.abs(rate) >= CFG.FUNDING_RATE_THRESHOLD;
  return { pass, rate };
}

async function fetchDailyCandle(symbol) {
  const { fromMsUtc, toMsUtc, startLocal, endLocal } = getDailyWindow5pmLocal();
  const arr = await fetchKlines(symbol, 1440, fromMsUtc, toMsUtc, `GET kline 1d ${symbol}`);
  const one = arr?.find(k => Number(k?.[0]) >= fromMsUtc && Number(k?.[0]) < toMsUtc) || arr?.[0];
  const winStr = `${startLocal.format('YYYY-MM-DD HH:mm z')} → ${endLocal.format('YYYY-MM-DD HH:mm z')}`;
  if (!one) { log.warn(`⚠️ ${symbol}: no 1d in window ${winStr}`); return null; }
  log.debug(`🗓️  ${symbol} 1d: ${dayjs(one[0]).tz().format('YYYY-MM-DD HH:mm z')} (window ${winStr})`);
  return one;
}

// Historical daily volumes (~800 days back) in 8 chunks ~100 days each
async function fetchHistoricalDailyVolumes(symbol) {
  const calls = [];
  for (let i = 0; i < 8; i++) {
    const from = dayjs().tz().hour(17).minute(0).second(0).millisecond(0)
      .subtract((i + 1) * 100 + 1, 'day').utc().valueOf();
    const to = dayjs().tz().hour(17).minute(0).second(0).millisecond(0)
      .subtract(i * 100 + 2, 'day').utc().valueOf();
    const label = `GET 1d vols ${symbol} [${i+1}]`;
    const fetchFn = async () => {
      const res = await api.get(`/kline/query?symbol=${encodeURIComponent(symbol)}&granularity=1440&from=${from}&to=${to}`, { _label: label });
      const data = Array.isArray(res.data?.data) ? res.data.data : [];
      return data
        .map(k => ({ ts: Number(k[0]), volume: parseFloat(k[5]) }))
        .filter(v => isFinite(v.ts) && isFinite(v.volume) && v.volume > 0);
    };
    calls.push(retryOnRateLimit(fetchFn, label));
  }
  const chunks = await Promise.all(calls);
  return (chunks || []).flat().filter(Boolean);
}

async function fetchCurrentAlignedDayVolume(symbol) {
  const { fromMsUtc, toMsUtc } = getDailyWindow5pmLocal();
  const arr = await fetchKlines(symbol, 1440, fromMsUtc, toMsUtc, `GET 1d vol window ${symbol}`);
  if (!arr || arr.length === 0) return null;
  const k = arr.find(k => Number(k[0]) >= fromMsUtc && Number(k[0]) < toMsUtc) || arr[0];
  return k ? Number(k[5]) : null;
}

////////////////////////////////////////////////////////////////////////////////
// Math helpers
////////////////////////////////////////////////////////////////////////////////
function ohlcMinMax(k) {
  // Defensive: use all four values
  const open  = Number(k[1]);
  const close = Number(k[2]);
  const highF = Number(k[3]);
  const lowF  = Number(k[4]);
  const hi = Math.max(open, close, highF, lowF);
  const lo = Math.min(open, close, highF, lowF);
  if (Number.isFinite(hi) && Number.isFinite(lo) && hi < lo) {
    log.warn(`‼️ hi<lo anomaly @ ${new Date(Number(k[0])).toISOString()} k=${JSON.stringify(k)}`);
  }
  return { lo, hi, open, close };
}

function pctDelta(lo, hi) {
  if (!isFinite(lo) || !isFinite(hi) || lo <= 0) return 0;
  return (hi - lo) / lo;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a,b)=>a-b);
  const m = Math.floor(s.length/2);
  return s.length % 2 ? s[m] : (s[m-1]+s[m])/2;
}

function zScore(series, idx, lookback=64) {
  const start = Math.max(0, idx - lookback + 1);
  const window = series.slice(start, idx+1);
  if (window.length < 2) return 0;
  const mean = window.reduce((a,b)=>a+b,0)/window.length;
  const sd = Math.sqrt(window.reduce((a,b)=>a + (b-mean)*(b-mean),0)/Math.max(1, window.length-1));
  return sd === 0 ? 0 : (series[idx] - mean)/sd;
}

function computeVWAP(klines) {
  let cumPV = 0, cumV = 0;
  const out = [];
  for (let i = 0; i < klines.length; i++) {
    const { lo, hi, close } = ohlcMinMax(klines[i]);
    const v = Number(klines[i][5]) || 0;
    const typical = (hi + lo + close) / 3;
    cumPV += typical * v;
    cumV  += v;
    out.push(cumV > 0 ? (cumPV / cumV) : typical);
  }
  return out;
}

// NEW helpers
function rollingMeanStd(arr, period) {
  const out = [];
  let sum = 0, sum2 = 0, q = [];
  for (let i = 0; i < arr.length; i++) {
    const x = arr[i] ?? 0;
    q.push(x); sum += x; sum2 += x*x;
    if (q.length > period) { const y=q.shift(); sum -= y; sum2 -= y*y; }
    if (q.length < period) { out.push({mean:null, sd:null}); continue; }
    const mean = sum / period;
    const sd = Math.sqrt(Math.max(0, (sum2/period) - mean*mean));
    out.push({ mean, sd });
  }
  return out;
}

function onBalanceVolume(klines) {
  let obv = 0; const out=[0];
  for (let i=1;i<klines.length;i++){
    const prevClose = ohlcMinMax(klines[i-1]).close;
    const { close } = ohlcMinMax(klines[i]);
    const v = Number(klines[i][5])||0;
    if (close > prevClose) obv += v;
    else if (close < prevClose) obv -= v;
    out.push(obv);
  }
  return out;
}

function closeNearHighPct(k) {
  const { lo, hi, close } = ohlcMinMax(k);
  if (!(isFinite(hi) && isFinite(lo) && hi>lo)) return 0;
  return (close - lo) / (hi - lo); // 1 → closed at high
}

////////////////////////////////////////////////////////////////////////////////
// Signals
////////////////////////////////////////////////////////////////////////////////
function findIntraCandleJumps(klines) {
  const jumps = [];
  for (const k of klines) {
    const ts = Number(k[0]);
    const { lo, hi } = ohlcMinMax(k);
    if (!isFinite(ts) || lo <= 0 || !isFinite(hi)) continue;
    const ratio = (hi - lo) / lo;
    if (ratio > CFG.PRICE_JUMP_RATIO) jumps.push({ ratio, candleStartUTC: ts });
  }
  return jumps;
}

function signalCompressionExpansion(klines) {
  if (!CFG.ENABLE_COMPRESSION_EXPANSION || !klines || klines.length < (CFG.CE_TR_LOOKBACK + CFG.CE_TR_WINDOW)) return null;
  const trs = klines.map(k => {
    const { lo, hi } = ohlcMinMax(k);
    return Math.max(0, hi - lo);
  });
  const vols = klines.map(k => Number(k[5]) || 0);
  const baselineStart = Math.max(0, klines.length - CFG.CE_TR_LOOKBACK);
  const recentStart   = Math.max(0, klines.length - CFG.CE_TR_WINDOW);
  const baseTR = median(trs.slice(baselineStart));
  const recentTR = median(trs.slice(recentStart));
  const trRatio = baseTR > 0 ? (recentTR / baseTR) : 1;
  const lastIdx = klines.length - 1;
  const volZ = zScore(vols, lastIdx, Math.min(64, klines.length));
  const { hi: dayHi } = klines.slice(-96).reduce((acc, k) => {
    const { hi } = ohlcMinMax(k); return { hi: Math.max(acc.hi, hi) };
  }, { hi: -Infinity });
  const { close: lastClose } = ohlcMinMax(klines[lastIdx]);
  const nearHigh = dayHi > 0 ? ((dayHi - lastClose) / dayHi) <= CFG.CE_NEAR_HIGH_PCT : false;
  const pass = (trRatio <= CFG.CE_TR_RATIO_MAX) && (volZ >= CFG.CE_VOL_Z_MIN) && nearHigh;
  return { pass, trRatio, volZ, nearHigh, baseTR, recentTR, dayHi, lastClose };
}

function signalVWAPDrift(klines) {
  if (!CFG.ENABLE_VWAP_DRIFT || !klines || klines.length < (CFG.VWAP_WINDOW + CFG.VWAP_STREAK)) return null;
  const vwap = computeVWAP(klines);
  const closes = klines.map(k => ohlcMinMax(k).close);
  const vols = klines.map(k => Number(k[5]) || 0);
  const lastIdx = klines.length - 1;
  const dev = (closes[lastIdx] - vwap[lastIdx]) / vwap[lastIdx];
  const volZ = zScore(vols, lastIdx, Math.min(64, klines.length));
  let streakOK = true;
  for (let i = lastIdx - CFG.VWAP_STREAK + 1; i <= lastIdx; i++) {
    const d = (closes[i] - vwap[i]) / vwap[i];
    const prev = (closes[i-1] - vwap[i-1]) / vwap[i-1];
    if (!(d > 0 && d >= prev)) { streakOK = false; break; }
  }
  const pass = (dev >= CFG.VWAP_DEV_MIN) && (volZ >= CFG.VWAP_VOL_Z_MIN) && streakOK;
  return { pass, dev, volZ, streakOK };
}

function passesDailyPumpFilter(daily1d) {
  if (!CFG.ENABLE_DAILY_PUMP_FILTER || !daily1d) return true;
  const open = Number(daily1d[1]);
  const close = Number(daily1d[2]);
  if (!(isFinite(open) && open > 0 && isFinite(close))) return true;
  const pumpRatio = (close - open) / open;
  log.debug(`📅 1d O→C: open=${fmtNum(open)} close=${fmtNum(close)} Δ=${(pumpRatio*100).toFixed(2)}% (skip if > ${(CFG.DAILY_PUMP_SKIP_RATIO*100).toFixed(0)}%)`);
  if (pumpRatio > CFG.DAILY_PUMP_SKIP_RATIO) {
    log.info(`🛑 Pump-filter skip: ${(pumpRatio*100).toFixed(2)}% > ${(CFG.DAILY_PUMP_SKIP_RATIO*100).toFixed(0)}%`);
    return false;
  }
  return true;
}

async function signalVolumeSpike(symbol) {
  if (!CFG.ENABLE_VOLUME_SPIKE) return { pass: false, reason: 'disabled' };
  const [hist, todayVol] = await Promise.all([
    fetchHistoricalDailyVolumes(symbol),
    fetchCurrentAlignedDayVolume(symbol),
  ]);
  if (!hist || hist.length < 50 || !isFinite(todayVol)) return { pass: false, reason: 'insufficient' };
  const prevMax = hist.reduce((m, c) => c.volume > m ? c.volume : m, 0);
  const ratio = prevMax > 0 ? (todayVol / prevMax) : 0;
  const pass = ratio >= CFG.VOLUME_SPIKE_RATIO;
  return { pass, todayVol, prevMax, ratio, histLen: hist.length };
}

// NEW: Turnover spike (quote notional)
function signalTurnoverSpike(klines) {
  if (!CFG.ENABLE_TURNOVER_SPIKE || !klines?.length) return null;
  const turnovers = klines.map(k => Number(k[6])||0); // kline[6] = turnover
  const vols = klines.map(k => Number(k[5])||0);
  const lastIdx = turnovers.length - 1;
  const toZ = zScore(turnovers, lastIdx, Math.min(64, turnovers.length));
  const toVSeries = turnovers.map((t,i)=> (vols[i]>0? t/vols[i] : 0));
  const medToV = median(toVSeries.slice(-64).filter(Number.isFinite));
  const lastToV = (vols[lastIdx]>0? turnovers[lastIdx]/vols[lastIdx] : 0);
  const ratioOK = medToV>0 ? (lastToV/medToV) >= CFG.TURNOVER_V_RATIO_MIN : false;
  const pass = (toZ >= CFG.TURNOVER_Z_MIN) && ratioOK;
  return { pass, toZ, lastToV, medToV };
}

// NEW: OBV impulse
function signalOBVImpulse(klines) {
  if (!CFG.ENABLE_OBV_IMPULSE || !klines?.length) return null;
  const obv = onBalanceVolume(klines);
  const lastIdx = obv.length - 1;
  const obvZ = zScore(obv, lastIdx, Math.min(96, obv.length));
  const pass = obvZ >= CFG.OBV_Z_MIN;
  return { pass, obvZ };
}

// NEW: Squeeze → breakout
function signalSqueezeBreakout(klines) {
  if (!CFG.ENABLE_SQUEEZE_BREAKOUT || klines.length < Math.max(CFG.SQZ_BB_PERIOD, CFG.SQZ_KC_PERIOD)+2) return null;
  const closes = klines.map(k => ohlcMinMax(k).close);
  const trs = klines.map(k => ohlcMinMax(k).hi - ohlcMinMax(k).lo);
  const bb = rollingMeanStd(closes, CFG.SQZ_BB_PERIOD);
  const kcBase = rollingMeanStd(closes, CFG.SQZ_KC_PERIOD);
  const atrMed = median(trs.slice(-CFG.SQZ_KC_PERIOD));
  const i = closes.length - 1;
  const bbMean = bb[i]?.mean, bbSd = bb[i]?.sd;
  const kcMean = kcBase[i]?.mean;
  if (bbMean==null || kcMean==null || bbSd==null) return null;
  const bbUpper = bbMean + 2*bbSd, bbLower = bbMean - 2*bbSd;
  const kcUpper = kcMean + CFG.SQZ_KC_MULT * atrMed;
  const kcLower = kcMean - CFG.SQZ_KC_MULT * atrMed;

  const wasSqueezed = (bbUpper < kcUpper && bbLower > kcLower);
  const volZ = zScore(klines.map(k=>Number(k[5])||0), i, Math.min(64, klines.length));
  const nearHigh = closeNearHighPct(klines[i]) >= (1 - CFG.SQZ_CLOSE_NEAR_HIGH_PCT);
  const breakoutUp = ohlcMinMax(klines[i]).close > bbUpper;
  const pass = wasSqueezed && breakoutUp && nearHigh && (volZ >= CFG.SQZ_VOL_Z_MIN);
  return { pass, wasSqueezed, volZ, nearHigh, breakoutUp };
}

// NEW: 1m whale sweeps
async function signalOneMinuteWhaleSweeps(symbol) {
  if (!CFG.ENABLE_1M_WHALE_SWEEPS) return null;
  const m1 = await fetch1mCandles(symbol);
  if (!m1?.length) return null;
  const vols = m1.map(k=>Number(k[5])||0);
  const volZSeries = vols.map((_,i)=> zScore(vols, i, Math.min(120, vols.length)));
  const extreme = [];
  for (let i=0;i<m1.length;i++){
    const nearHigh = closeNearHighPct(m1[i]) >= (1 - CFG.M1_CLOSE_NEAR_HIGH_PCT);
    if ((volZSeries[i]||0) >= CFG.M1_VOL_Z_MIN && nearHigh) extreme.push({ ts:Number(m1[i][0]), volZ: volZSeries[i] });
  }
  const pass = extreme.length >= CFG.M1_MIN_SWEEPS;
  const lastVolZ = volZSeries.length ? volZSeries[volZSeries.length-1] : 0;
  return { pass, count: extreme.length, lastVolZ };
}

////////////////////////////////////////////////////////////////////////////////
// Per-symbol evaluation
////////////////////////////////////////////////////////////////////////////////
async function evaluateSymbol(symbol, fundingRate) {
  // 1) Daily pump gate
  const daily = await fetchDailyCandle(symbol);
  if (!passesDailyPumpFilter(daily)) return null;

  // 2) 15m
  const klines = await fetch15mCandles(symbol);
  if (!klines || klines.length === 0) return null;

  if (CFG.LOG_PER_CANDLE && klines[0]) {
    const k = klines[0];
    const { lo, hi, open, close } = ohlcMinMax(k);
    log.debug(`🔎 ${symbol} map: o=${open} c=${close} hi=${hi} lo=${lo}`);
  }

  // 3) Must-have signals
  const volSig = await signalVolumeSpike(symbol);
  const jumps  = findIntraCandleJumps(klines);

  // 4) Optional context
  const ceSig = signalCompressionExpansion(klines);
  const vdSig = signalVWAPDrift(klines);

  // 5) New confluence signals
  const toSig = signalTurnoverSpike(klines);
  const obvSig = signalOBVImpulse(klines);
  const sqzSig = signalSqueezeBreakout(klines);
  const m1Sig = await signalOneMinuteWhaleSweeps(symbol);
  const frSig = signalFundingRateBias(fundingRate);
  // scoring for near-miss surfacing
  let score = 0;
  if (volSig?.pass) score += CFG.W_VOL_SPIKE;
  if ((jumps?.length||0) > 0) score += CFG.W_15M_JUMP;
  if (toSig?.pass) score += CFG.W_TURNOVER;
  if (obvSig?.pass) score += CFG.W_OBV;
  if (sqzSig?.pass) score += CFG.W_SQUEEZE;
  if (m1Sig?.pass) score += CFG.W_M1_WHALE;
  if (frSig?.pass) score += CFG.W_FUNDING_RATE;

  const gatePass = CFG.REQUIRE_BOTH_GATES
    ? (Boolean(volSig?.pass) && (jumps && jumps.length > 0))
    : (Boolean(volSig?.pass) || (jumps && jumps.length > 0));
  const mustPass = gatePass || (score >= CFG.ALT_SCORE_PASS_MIN);

  return {
    symbol,
    mustPass,
    score,
    details: {
      volumeSpike: volSig,
      big15mJumps: jumps,
      compressionExpansion: ceSig,
      vwapDrift: vdSig,
      turnoverSpike: toSig,
      obvImpulse: obvSig,
      squeezeBreakout: sqzSig,
      m1WhaleSweeps: m1Sig,
      fundingRate: frSig,
      sample15mCount: klines.length,
    }
  };
}

////////////////////////////////////////////////////////////////////////////////
// Email render
////////////////////////////////////////////////////////////////////////////////
function buildEmail(windowStr, winners, confluence) {
  const gateLabel = CFG.REQUIRE_BOTH_GATES
    ? `BOTH signals hit (Vol ≥ ${CFG.VOLUME_SPIKE_RATIO.toFixed(2)}× & 15m > ${(CFG.PRICE_JUMP_RATIO*100).toFixed(0)}%)`
    : `Signal match (Vol ≥ ${CFG.VOLUME_SPIKE_RATIO.toFixed(2)}× or 15m > ${(CFG.PRICE_JUMP_RATIO*100).toFixed(0)}%)`;
  const subject = `🔥 KuCoin Futures — ${gateLabel} — ${winners.length} — ${windowStr}`;

  const linesFor = (w) => {
    const vs = w.details.volumeSpike;
    const j  = w.details.big15mJumps || [];
    const ce = w.details.compressionExpansion;
    const vd = w.details.vwapDrift;
    const to = w.details.turnoverSpike;
    const obv= w.details.obvImpulse;
    const sqz= w.details.squeezeBreakout;
    const m1 = w.details.m1WhaleSweeps;
    const fr = w.details.fundingRate;
    const lastJump = j.length ? `${(j[j.length-1].ratio*100).toFixed(2)}%` : '—';
    return [
      `• ${w.symbol} (score=${(w.score||0).toFixed(2)})`,
      `   - Volume spike: ${vs ? `${(vs.ratio*100).toFixed(1)}% of prevMax (today=${fmtNum(vs.todayVol)}, prevMax=${fmtNum(vs.prevMax)}, hist=${vs.histLen})` : '—'}`,
      `   - 15m jumps: ${j.length} (last ${lastJump})`,
      `   - CE: ${ce ? (ce.pass ? 'PASS' : '—') : '—'} | VWAP: ${vd ? (vd.pass ? 'PASS' : '—') : '—'}`,
      `   - Turnover: ${to?.pass ? `PASS (z=${(to.toZ||0).toFixed(2)})` : '—'} | OBV: ${obv?.pass ? `PASS (z=${(obv.obvZ||0).toFixed(2)})` : '—'} | Squeeze: ${sqz?.pass ? 'PASS' : '—'} | 1m: ${m1?.pass ? `PASS (count=${m1.count})` : '—'} | Funding: ${fr ? `${(fr.rate*100).toFixed(3)}%${fr.pass? ' PASS':''}` : '—'}`,
    ].join('\n');
  };

  const textLines = [
    `Window: ${windowStr}`,
    `Winners: ${winners.length}`,
    '',
    ...winners.map(linesFor),
  ];
  if (confluence.length) {
    textLines.push('', `Near‑miss (high confluence >= ${CFG.SCORE_ALERT_MIN}): ${confluence.length}`, '');
    textLines.push(...confluence.map(linesFor));
  }
  const bodyText = textLines.join('\n');

  // HTML tables
  const tableRows = (arr) => arr.map(w => {
    const vs = w.details.volumeSpike;
    const j  = w.details.big15mJumps || [];
    const ce = w.details.compressionExpansion;
    const vd = w.details.vwapDrift;
    const to = w.details.turnoverSpike;
    const obv= w.details.obvImpulse;
    const sqz= w.details.squeezeBreakout;
    const m1 = w.details.m1WhaleSweeps;
    const fr = w.details.fundingRate;
    const last = j.length ? (j[j.length-1].ratio*100).toFixed(2) + '%' : '—';
    return `<tr>
      <td>${w.symbol}</td>
      <td style="text-align:center;">${(w.score||0).toFixed(2)}</td>
      <td>${vs ? `${(vs.ratio*100).toFixed(1)}% (today ${fmtNum(vs.todayVol)} / prevMax ${fmtNum(vs.prevMax)})` : '—'}</td>
      <td style="text-align:center;">${j.length}</td>
      <td style="text-align:center;">${last}</td>
      <td>${ce ? (ce.pass ? `PASS (TRr=${ce.trRatio?.toFixed(2)}, volZ=${ce.volZ?.toFixed(2)})` : '—') : '—'}</td>
      <td>${vd ? (vd.pass ? `PASS (dev=${((vd.dev||0)*100).toFixed(2)}%, volZ=${(vd.volZ||0).toFixed(2)})` : '—') : '—'}</td>
      <td>${to ? (to.pass ? `PASS (z=${(to.toZ||0).toFixed(2)})` : '—') : '—'}</td>
      <td>${obv ? (obv.pass ? `PASS (z=${(obv.obvZ||0).toFixed(2)})` : '—') : '—'}</td>
      <td>${sqz ? (sqz.pass ? 'PASS' : '—') : '—'}</td>
      <td>${m1 ? (m1.pass ? `PASS (n=${m1.count})` : '—') : '—'}</td>
      <td>${fr ? `${(fr.rate*100).toFixed(3)}%` : '—'}</td>
    </tr>`;
  }).join('');

  const winnersTable = `
    <h2>🔥 ${gateLabel}</h2>
    <p><strong>Window:</strong> ${windowStr}</p>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse: collapse; font-family: Arial, sans-serif; font-size: 13px;">
      <thead>
        <tr style="background:#f2f2f2;">
          <th>Symbol</th>
          <th>Score</th>
          <th>Volume Spike</th>
          <th>15m Jumps</th>
          <th>Last Jump %</th>
          <th>Compression→Expansion</th>
          <th>VWAP Drift</th>
          <th>Turnover</th>
          <th>OBV</th>
          <th>Squeeze</th>
          <th>1m Whale</th>
          <th>Funding</th>
        </tr>
      </thead>
      <tbody>
        ${winners.length ? tableRows(winners) : `<tr><td colspan="12" style="text-align:center;">No matches</td></tr>`}
      </tbody>
    </table>
  `;

  const confluenceTable = !confluence.length ? '' : `
    <h3 style="margin-top:18px;">⚡ High‑confluence near‑misses (score ≥ ${CFG.SCORE_ALERT_MIN})</h3>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse: collapse; font-family: Arial, sans-serif; font-size: 13px;">
      <thead>
        <tr style="background:#f9f9f9;">
          <th>Symbol</th>
          <th>Score</th>
          <th>Volume Spike</th>
          <th>15m Jumps</th>
          <th>Last Jump %</th>
          <th>Compression→Expansion</th>
          <th>VWAP Drift</th>
          <th>Turnover</th>
          <th>OBV</th>
          <th>Squeeze</th>
          <th>1m Whale</th>
          <th>Funding</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows(confluence)}
      </tbody>
    </table>
  `;

  const bodyHtml = winnersTable + confluenceTable;
  return { subject, bodyText, bodyHtml };
}

////////////////////////////////////////////////////////////////////////////////
// Orchestrator
////////////////////////////////////////////////////////////////////////////////
async function runSmartScan() {
  metrics.startedAt = new Date();
  metrics.finishedAt = null;
  Object.assign(metrics, mkMetrics(), { startedAt: metrics.startedAt });

  const { default: pLimit } = await import('p-limit');
  const limit = pLimit(CFG.CONCURRENCY);

  let symbols = await fetchSymbols();
  if (CFG.SANITY_SAMPLE) symbols = symbols.slice(0, 50);

  const evalDesc = CFG.REQUIRE_BOTH_GATES
    ? `BOTH conditions (Vol ≥ ${CFG.VOLUME_SPIKE_RATIO.toFixed(2)}× & 15m > ${(CFG.PRICE_JUMP_RATIO*100).toFixed(0)}%)`
    : `ANY condition (Vol ≥ ${CFG.VOLUME_SPIKE_RATIO.toFixed(2)}× or 15m > ${(CFG.PRICE_JUMP_RATIO*100).toFixed(0)}%)`;
  log.info(`🔍 Evaluating ${symbols.length} symbols for ${evalDesc}...\n`);

  const results = [];
  const winners = [];
  let dumps = 0;

  for (let i = 0; i < symbols.length; i += CFG.BATCH_SIZE) {
    const batch = symbols.slice(i, i + CFG.BATCH_SIZE);
    const tasks = batch.map(({ fullSymbol, fundingRate }) => limit(() => evaluateSymbol(fullSymbol, fundingRate)));
    const batchResults = await Promise.all(tasks);

    for (const r of batchResults) {
      if (!r) continue;
      results.push(r);
      if (r.mustPass) {
        winners.push(r);
        if (CFG.DUMP_JSON && dumps < CFG.DUMP_LIMIT) {
          dumps++;
          console.log(`\n🧾 WINNER DUMP ${dumps}/${CFG.DUMP_LIMIT} — ${r.symbol}\n`, JSON.stringify(r, null, 2));
        }
      } else if (CFG.DUMP_JSON && dumps < CFG.DUMP_LIMIT) {
        // near misses with high vol or high jump or high score get dumped
        const vr = r.details.volumeSpike?.ratio || 0;
        const lj = (r.details.big15mJumps?.[r.details.big15mJumps.length - 1]?.ratio) || 0;
        const sc = r.score || 0;
        if (vr >= (CFG.VOLUME_SPIKE_RATIO * 0.9) || lj >= (CFG.PRICE_JUMP_RATIO * 0.9) || sc >= CFG.SCORE_ALERT_MIN) {
          dumps++;
          console.log(`\n🧾 NEAR-MISS DUMP ${dumps}/${CFG.DUMP_LIMIT} — ${r.symbol}\n`, JSON.stringify(r, null, 2));
        }
      }
    }

    if (i + CFG.BATCH_SIZE < symbols.length) {
      log.debug(`⏳ Sleeping ${CFG.SLEEP_BETWEEN_BATCHES_MS/1000}s before next batch...`);
      await sleep(CFG.SLEEP_BETWEEN_BATCHES_MS);
    }
  }

  // Email once
  const { startLocal, endLocal } = getDailyWindow5pmLocal();
  const windowStr = `${startLocal.format('YYYY-MM-DD HH:mm z')} → ${endLocal.format('YYYY-MM-DD HH:mm z')}`;

  // Rank winners
  winners.sort((a, b) => {
    const ra = a.details.volumeSpike?.ratio || 0;
    const rb = b.details.volumeSpike?.ratio || 0;
    if (rb !== ra) return rb - ra;
    const ja = (a.details.big15mJumps?.[a.details.big15mJumps.length - 1]?.ratio) || 0;
    const jb = (b.details.big15mJumps?.[b.details.big15mJumps.length - 1]?.ratio) || 0;
    return jb - ja;
  });

  // Score-based confluence near-misses
  const confluence = results
    .filter(r => !r.mustPass && (r.score||0) >= CFG.SCORE_ALERT_MIN)
    .sort((a,b)=> (b.score - a.score))
    .slice(0, 15);

  const scored = results.map(r => {
    const vr = r.details.volumeSpike?.ratio || 0;
    const lj = (r.details.big15mJumps?.[r.details.big15mJumps.length - 1]?.ratio) || 0;
    return { symbol: r.symbol, vr, lj, mustPass: r.mustPass, score: r.score||0 };
  }).sort((a,b)=> (b.mustPass - a.mustPass) || (b.score - a.score) || (b.vr - a.vr) || (b.lj - a.lj));

  console.log('Top 15 candidates (including near-misses):');
  for (const row of scored.slice(0, 15)) {
    console.log(`${row.symbol} mustPass=${row.mustPass} score=${row.score.toFixed(2)} volSpikeRatio=${(row.vr*100).toFixed(1)}% lastJump=${(row.lj*100).toFixed(2)}%`);
  }

  if (winners.length > 0 || confluence.length > 0) {
    const { subject, bodyText, bodyHtml } = buildEmail(windowStr, winners, confluence);
    await sendEmail(subject, bodyText, bodyHtml);
  } else {
    log.info(`No symbols satisfied ${CFG.REQUIRE_BOTH_GATES ? 'BOTH conditions' : 'gating'} or confluence threshold; no email sent.`);
  }

  metrics.finishedAt = new Date();
  const durSec = ((metrics.finishedAt - metrics.startedAt) / 1000).toFixed(1);

  console.log('\n===== RUN SUMMARY =====');
  console.log(`Duration: ${durSec}s`);
  console.log(`Requests: total=${metrics.requests}, ok=${metrics.ok2xx}, 429=${metrics.rate429}, otherErr=${metrics.errors}`);
  console.log(`Rate limit handling: pauses=${metrics.pauses}, retries=${metrics.retries}, retryOK=${metrics.retrySuccess}, retryFail=${metrics.retryFail}`);
  console.log(`Emails sent: ${metrics.emailsSent}`);
  console.log(`Winners: ${winners.length} | Confluence near-misses: ${confluence.length}`);
  console.log('=======================\n');

  console.log('✅ Smart pre‑pump scan complete.');
}

////////////////////////////////////////////////////////////////////////////////
// Schedule (daily at 5pm local) + immediate kick-off
////////////////////////////////////////////////////////////////////////////////
if (CFG.SCHEDULE_ENABLED) {
  cron.schedule(CFG.DAILY_SCAN_CRON, () => {
    console.log(`🕔 Scheduled smart scan at ${dayjs().tz().format('YYYY-MM-DD HH:mm:ss z')}`);
    runSmartScan();
  }, { timezone: dayjs.tz.guess() });
}

// Kick off immediately
runSmartScan();

////////////////////////////////////////////////////////////////////////////////
// Utils
////////////////////////////////////////////////////////////////////////////////
function fmtNum(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 12 });
}
