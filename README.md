# KuCoin Futures Pre‑Pump Scanner

A production‑oriented Node.js scanner that hunts for **coins about to pump** on **KuCoin Futures** by combining strict **gating** filters with several **early confluence** signals that often precede “whale attack” markups. Everything is aligned to a **5:00 PM local → 5:00 PM next day** analysis window to match the common UTC 00:00 daily close.

---

## TL;DR

- **Gating (must-pass):** pass if either condition below is true (set `REQUIRE_BOTH_GATES=true` to demand both)
  1) Today’s aligned **1D volume** ≥ `VOLUME_SPIKE_RATIO` × **historical daily max**
  2) At least one **15m intrabar jump** > `PRICE_JUMP_RATIO` (High–Low vs Low)

- **Confluence (non-gating, score-based):**
  Turnover spike, OBV impulse, Squeeze→Breakout, 1m whale sweeps, funding rate bias

- **Output:** one consolidated email with **winners** (must-pass) plus a table of **near‑misses** with high **score** (>= `SCORE_ALERT_MIN`). High‑scoring symbols (`score ≥ ALT_SCORE_PASS_MIN`, default 4.0) are also treated as winners.

---

## Contents

- [Architecture](#architecture)
- [Data & Time Windows](#data--time-windows)
- [Signals & Math](#signals--math)
- [Execution Flow](#execution-flow)
- [Configuration (.env)](#configuration-env)
- [Install & Run](#install--run)
- [Tuning Guide](#tuning-guide)
- [Troubleshooting](#troubleshooting)
- [Security Notes](#security-notes)
- [Appendix: Functions Reference](#appendix-functions-reference)

---

## Architecture

**Files**
```
KucoinCoinFinderUltra.js   # Main executable
.env                        # Environment variables (thresholds, email, schedule)
```

**High level**
1. **load config → fetch active futures → batch-evaluate symbols (p-limit)**
2. For each symbol: **align window → fetch klines → compute signals → gate + score**
3. Create report with **winners** and **near-misses**; send **one email**
4. Print **run summary**; optionally scheduled (CRON) at **5:00 PM local**

**Resilience**
- Centralized **Axios client** with request/response tracing
- **429 backoff**: on first rate-limit, **global pause = 31s**; retry once
- Batch scanning with **BATCH_SIZE**, **CONCURRENCY**, and sleep between batches
- Defensive math (NaN/Inf guards), structured logs, and optional JSON dumps

---

## Data & Time Windows

### Time alignment (5 PM local)
We analyze from **yesterday 17:00** (local timezone) to **today 17:00**.

- This window is converted to UTC for API calls.
- 1D volume comparison is computed using the same 5pm‑aligned window historically.

**Helper:** `getDailyWindow5pmLocal()`

### KuCoin kline tuple
All klines returned by `/kline/query` are parsed as:
```
[0]=time(ms), [1]=open, [2]=close, [3]=high, [4]=low, [5]=volume, [6]=turnover
```

**Granularity mapping**
- 1 minute → `granularity=1`
- 15 minutes → `granularity=15`
- 1 day → `granularity=1440`

---

## Signals & Math

### 1) Gating (must-pass)

#### A. 1D Volume Spike — `signalVolumeSpike(symbol)`
- Fetch ~800 aligned days of 1D volumes.
- Let:
  - \( V_t \) = today’s aligned daily volume
  - \( V_{\max} \) = maximum historical aligned daily volume
- Ratio:
  \[
    R_v = \frac{V_t}{V_{\max}}
  \]
- Pass if \( R_v \ge \texttt{VOLUME\_SPIKE\_RATIO} \).

#### B. 15m Intrabar Jump — `findIntraCandleJumps(klines15m)`
- For each 15m candle
  \[
    R_c = \frac{\text{High} - \text{Low}}{\text{Low}}
  \]
- Pass if any \( R_c > \texttt{PRICE\_JUMP\_RATIO} \).

> By default the **must-pass** condition succeeds if **either** A or B is true. Set `REQUIRE_BOTH_GATES=true` to force both.

---

### 2) Confluence (non-gating, contributes to score)

#### C. Turnover Spike — `signalTurnoverSpike(klines15m)`
**Turnover** is the quote notional traded per candle (`kline[6]`).
- Z‑score on recent turnover:
  \[
    Z_{\text{to}} = \frac{T_{\text{last}} - \mu_T}{\sigma_T}
  \]
  (lookback = min(64, series length))
- Turnover‑to‑Volume ratio expansion:
  \[
    \text{ratio} = \frac{(T/V)_{\text{last}}}{\operatorname*{median}\limits_{\text{lookback}} (T/V)}
  \]
- Pass if \( Z_{\text{to}} \ge \texttt{TURNOVER\_Z\_MIN} \) **and** `ratio` ≥ `TURNOVER_V_RATIO_MIN`.

**Why it matters:** Whales can push **notional** harder than prints count; a sharp rise in **T/V** often accompanies aggressive market buys.

#### D. OBV Impulse — `signalOBVImpulse(klines15m)`
- OBV definition:
  \[
    OBV_i = OBV_{i-1} +
      \begin{cases}
        V_i & \text{if } \text{Close}_i > \text{Close}_{i-1} \\
        -V_i & \text{if } \text{Close}_i < \text{Close}_{i-1} \\
        0 & \text{otherwise}
      \end{cases}
  \]
- Z‑score on OBV:
  \[
    Z_{\text{obv}} = \frac{OBV_{\text{last}} - \mu_{OBV}}{\sigma_{OBV}}
  \]
- Pass if \( Z_{\text{obv}} \ge \texttt{OBV\_Z\_MIN} \).

**Why it matters:** Sustained **accumulation** pressure often registers on OBV even before price markup accelerates.

#### E. Squeeze → Breakout — `signalSqueezeBreakout(klines15m)`
- **Bollinger Bands (BB)** on close (period = `SQZ_BB_PERIOD`): mean ± 2σ
- **Keltner Channels (KC)** use mean ± ATR × `SQZ_KC_MULT` (ATR approximated as **median(TR)** over `SQZ_KC_PERIOD`)
- **Squeeze** when **BB** lies **inside KC**
- **Bull breakout** if:
  - `close > BB.upper`
  - **volume Z‑score** ≥ `SQZ_VOL_Z_MIN`
  - **close near high** ≥ `1 - SQZ_CLOSE_NEAR_HIGH_PCT`

**Why it matters:** Coiling ranges precede expansions; volume + close near high support break direction.

#### F. Funding Rate Bias — `signalFundingRateBias(symbol)`
- Fetch latest funding rate via `/funding-rate?symbol=...`.
- Pass if absolute funding rate ≥ `FUNDING_RATE_THRESHOLD`.

**Why it matters:** Elevated funding often precedes aggressive long pressure and can hint at imminent markup.

#### G. 1m Whale Sweeps — `signalOneMinuteWhaleSweeps(symbol)`
- Fetch last `M1_LOOKBACK_MIN` **1m** candles within the aligned day.
- Mark an **extreme minute** if:
  - volume Z‑score ≥ `M1_VOL_Z_MIN`
  - close near high ≥ `1 - M1_CLOSE_NEAR_HIGH_PCT`
- Pass if count of extreme minutes ≥ `M1_MIN_SWEEPS`.

**Why it matters:** Short, forceful bursts often show up on the 1‑minute tape before 15m signals register.

---

### 3) Score

Let the indicator weights be:
```
W_VOL_SPIKE, W_15M_JUMP, W_TURNOVER, W_OBV, W_SQUEEZE, W_M1_WHALE, W_FUNDING_RATE
```

\[
\text{Score} = \sum_{\text{signal passes}} W_{\text{signal}}
\]

- **Winners:** `mustPass === true`
- **Near‑misses (high confluence):** `score ≥ SCORE_ALERT_MIN` (listed in a second email table)
- **Alt pass:** if `ALT_SCORE_PASS_MIN` is set, any symbol with `score ≥ ALT_SCORE_PASS_MIN` is also considered a winner.

---

### Shared Math Helpers

- **Z‑score** \( Z = (x - \mu) / \sigma \) with windowed mean/std
- **Median** for robust baselines
- **TR (true range surrogate):** `high - low`
- **VWAP** (cumulative typical‑price weighted by volume):
  \[
    VWAP_i = \frac{\sum_{j=1}^i P^{\text{typical}}_j \cdot V_j}{\sum_{j=1}^i V_j},
    \quad P^{\text{typical}} = \frac{H+L+C}{3}
  \]
- **Close‑near‑high** fraction:
  \[
    \frac{C - L}{H - L} \in [0,1]
  \]

All helpers are implemented defensively against 0/NaN/Inf.

---

## Execution Flow

1. **`runSmartScan()`**
   - Sets up metrics
   - Loads `p-limit` and symbol list
   - Iterates in batches with per‑batch sleep
2. **`evaluateSymbol(symbol)`**
   - Daily pump gate (`passesDailyPumpFilter`)
   - Fetch **15m**, compute **must‑pass** + **confluences** + **score**
   - Return record with `mustPass`, `score`, and `details`
3. **Aggregate**
   - Winners = `mustPass === true`
   - Near‑misses = `!mustPass && score ≥ SCORE_ALERT_MIN`
4. **Email**
   - Two HTML tables: **Winners** and **Near‑misses**
5. **Summary**
   - Requests, 429s, retries, emails, counts

**Scheduling:** runs once at startup and (optionally) **daily at 17:00 local** via CRON.

---

## Configuration (.env)

**Core / Gating**
```
ENABLE_DAILY_PUMP_FILTER=true
DAILY_PUMP_SKIP_RATIO=0.20        # skip coins that already pumped >20% O→C
ENABLE_VOLUME_SPIKE=true
VOLUME_SPIKE_RATIO=1.10
PRICE_JUMP_RATIO=0.10             # 10% intrabar jump on 15m
GRANULARITY_MIN=15
REQUIRE_BOTH_GATES=false          # true → demand both volume spike and price jump
```

**Confluence (non-gating)**
```
ENABLE_TURNOVER_SPIKE=true
TURNOVER_Z_MIN=1.80
TURNOVER_V_RATIO_MIN=1.25

ENABLE_OBV_IMPULSE=true
OBV_Z_MIN=1.60

ENABLE_SQUEEZE_BREAKOUT=true
SQZ_BB_PERIOD=20
SQZ_KC_PERIOD=20
SQZ_KC_MULT=1.5
SQZ_VOL_Z_MIN=1.00
SQZ_CLOSE_NEAR_HIGH_PCT=0.30

ENABLE_1M_WHALE_SWEEPS=true
M1_LOOKBACK_MIN=60
M1_VOL_Z_MIN=2.00
M1_CLOSE_NEAR_HIGH_PCT=0.25
M1_MIN_SWEEPS=1

ENABLE_FUNDING_RATE_BIAS=true
FUNDING_RATE_THRESHOLD=0.0005
```

**Scoring**
```
W_VOL_SPIKE=2.0
W_15M_JUMP=1.5
W_TURNOVER=1.2
W_OBV=1.0
W_SQUEEZE=1.0
W_M1_WHALE=1.3
W_FUNDING_RATE=0.8
SCORE_ALERT_MIN=2.6
ALT_SCORE_PASS_MIN=4.0      # score ≥ this also counts as winner (raise to disable)
```

**Batch / Network**
```
BATCH_SIZE=22
CONCURRENCY=2
SLEEP_BETWEEN_BATCHES_MS=10000
REQUEST_TIMEOUT_MS=20000
KUCOIN_BASE_URL=https://api-futures.kucoin.com/api/v1   # optional override
```

**Email**
```
EMAIL_ENABLED=true
EMAIL_FROM=you@gmail.com
EMAIL_PASS=your_gmail_app_password
EMAIL_TO=alerts@yourdomain.com
EMAIL_DRY_RUN=false   # true → print email to console only
```

**Debug**
```
LOG_LEVEL=trace         # silent|warn|info|debug|trace
TRACE_HTTP=true
LOG_PER_CANDLE=false
DUMP_JSON=false
DUMP_LIMIT=3
SANITY_SAMPLE=false     # true → limit to first 50 symbols
```

**Schedule / Timezone**
```
SCHEDULE_ENABLED=true
DAILY_SCAN_CRON=0 17 * * *
TZ=America/Vancouver
```

> **Tip:** Keep credentials out of version control; use `.gitignore` for `.env`.

---

## Install & Run

**Prereqs**
- Node.js ≥ 18 (works great on 20+)
- Gmail App Password if using Gmail SMTP

**Install deps**
```bash
npm i axios dayjs nodemailer node-cron p-limit dotenv
```

**Run once**
```bash
node KucoinCoinFinderMaster.js
```

**Scheduled run**
- Enabled by default: `SCHEDULE_ENABLED=true`, at 5 PM local (`DAILY_SCAN_CRON=0 17 * * *`)
- The script runs **immediately once** and then on schedule

---

## Tuning Guide

- **Too few winners?** Lower `VOLUME_SPIKE_RATIO` (e.g., 1.05) and/or `PRICE_JUMP_RATIO` (e.g., 0.08).  
- **Too many near‑misses?** Increase `SCORE_ALERT_MIN` (e.g., 3.0) or reduce some weights.  
- **Earlier alerts:** Emphasize turnover / OBV / 1m sweeps by raising their weights.  
- **Noisy symbols:** Enable `ENABLE_DAILY_PUMP_FILTER` and maybe set `DAILY_PUMP_SKIP_RATIO=0.15`.  
- **Rate limits:** Reduce `CONCURRENCY`, `BATCH_SIZE`, or increase `SLEEP_BETWEEN_BATCHES_MS`.  
- **Verbose diagnostics:** `LOG_LEVEL=trace`, `TRACE_HTTP=true`, `DUMP_JSON=true`.

---

## Troubleshooting

- **429 errors**  
  The scanner globally **pauses 31s** on first 429 and retries once. If persistent, slow down batches/concurrency.

- **Email not delivered**  
  - Use a **Gmail App Password** (not your normal password).  
  - Verify `EMAIL_ENABLED=true`, valid `EMAIL_FROM`/`EMAIL_TO`.  
  - Try `EMAIL_DRY_RUN=true` to preview the HTML in console.

- **Empty 15m/1m data**  
  Newly listed or paused symbols can return sparse klines within the aligned window.

- **Wrong timezone**  
  Set `TZ=<Your/Region>` in `.env`.

---

## Security Notes

- Store SMTP credentials only in `.env` (never commit).  
- Consider creating a **dedicated mailbox** and app password for alerts.  
- Rate‑limit handling is conservative; nonetheless, respect the exchange’s API ToS.

---

## Appendix: Functions Reference

### Time & email
- `getDailyWindow5pmLocal()` — Returns local start/end and UTC millis for aligned day
- `sendEmail(subject, text, html)` — Gmail SMTP with dry‑run mode
- `buildEmail(...)` — Renders Winners and Near‑Misses as 2 HTML tables

### API & orchestration
- `fetchSymbols()` — Active futures with `symbol` & `baseCurrency`
- `fetchKlines(symbol, granularity, fromMs, toMs, label)` — Generic kline pull
- `fetch15mCandles(symbol)` — Aligned 15m klines (logging & sanity)
- `fetch1mCandles(symbol)` — Last `M1_LOOKBACK_MIN` 1m klines in window
- `fetchDailyCandle(symbol)` — Aligned 1D kline (for daily pump filter)
- `fetchFundingRate(symbol)` — Latest funding rate for symbol
- `fetchHistoricalDailyVolumes(symbol)` — ~800 days in chunked requests
- `fetchCurrentAlignedDayVolume(symbol)` — Today’s aligned 1D volume
- `runSmartScan()` — Batching, evaluation, email, summary
- `evaluateSymbol(symbol)` — Applies gates, computes signals, score, details
- `retryOnRateLimit(fn, label)` — One‑retry with **31s** global pause on 429
- `pauseAll(ms, reason)` — Blocks subsequent requests pipeline‑wide

### Signals
- `findIntraCandleJumps(klines15m)` — Count intrabar (H–L)/L jumps
- `signalVolumeSpike(symbol)` — Today’s 1D vol vs historical max
- `passesDailyPumpFilter(daily1d)` — Skip if O→C pump already too big
- `signalCompressionExpansion(klines15m)` — Low TR → Expansion w/ vol & near‑high
- `signalVWAPDrift(klines15m)` — Positive VWAP deviation + streak + vol
- `signalTurnoverSpike(klines15m)` — Turnover Z + T/V expansion
- `signalOBVImpulse(klines15m)` — OBV Z‑score thrust
- `signalSqueezeBreakout(klines15m)` — BB‑in‑KC squeeze → breakout
- `signalFundingRateBias(symbol)` — Elevated funding rate
- `signalOneMinuteWhaleSweeps(symbol)` — Extreme 1m bursts near highs

### Math & utils
- `ohlcMinMax(k)` — Defensive OHLC parser; also guards hi<lo anomalies
- `pctDelta(lo, hi)` — Relative rise
- `median(arr)` — Robust median
- `zScore(series, idx, lookback)` — Windowed Z
- `computeVWAP(klines)` — Cumulative VWAP on typical price
- `rollingMeanStd(arr, period)` — Rolling μ and σ
- `onBalanceVolume(klines)` — OBV series
- `closeNearHighPct(k)` — Fractional close position in range
- `fmtNum(n)` — Locale‑aware compact formatting

---

## License

This project is provided as‑is for research/trading tooling. Use at your own risk; no warranty. Respect exchange rate limits and terms of service.

