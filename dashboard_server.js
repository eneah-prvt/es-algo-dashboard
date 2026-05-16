/**
 * ES Algo — Combined Server v3
 * Dashboard + Algo Engine in einem Node.js Prozess
 * Railway: ein Projekt, ein Repo, alles zusammen
 *
 * Endpoints:
 *   GET  /health         → Status
 *   GET  /algo/state     → Kompletter Algo State (Dashboard holt das)
 *   POST /algo/risk      → Risk Parameter updaten
 *   POST /algo/gates     → Gates an/aus
 *   POST /algo/kill      → Kill Switch
 *   POST /algo/trade     → Manuellen Trade aufzeichnen
 *   POST /algo/refresh   → Sofortiger Datenfetch
 *   POST /algo/news      → News Event hinzufügen
 *   GET  *               → Dashboard HTML
 */

const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const app     = express();
app.use(express.json());
app.use(express.static(__dirname));

// ── Environment ───────────────────────────────────────────────────────────

const ALPHA_BIAS_URL    = process.env.ALPHA_BIAS_URL     || 'https://alpha-bias.com';
const EMAIL             = process.env.ALPHA_BIAS_EMAIL   || '';
const PASSWORD          = process.env.ALPHA_BIAS_PASSWORD|| '';
const SUPABASE_URL      = 'https://svnmcthtxppbahwimzjx.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY  || '';
const PORT              = parseInt(process.env.PORT)     || 8080;

// ── Topstep Limits ────────────────────────────────────────────────────────

const TOPSTEP = { maxDailyLoss: 1000, trailingDD: 2000, maxContracts: 5 };

// ── Auth ──────────────────────────────────────────────────────────────────

const auth = { accessToken: '', refreshToken: '', expiresAt: 0 };

function decodeExp(token) {
  try {
    const payload = Buffer.from(token.split('.')[1], 'base64').toString();
    return JSON.parse(payload).exp || 0;
  } catch { return 0; }
}

async function login() {
  console.log(`[AUTH] Logging in as ${EMAIL}...`);
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`Login failed ${r.status}: ${await r.text()}`);
  const d = await r.json();
  auth.accessToken  = d.access_token;
  auth.refreshToken = d.refresh_token;
  auth.expiresAt    = decodeExp(d.access_token);
  const mins = Math.round((auth.expiresAt - Date.now()/1000) / 60);
  console.log(`[AUTH] Login ✓ — token valid ${mins} min`);
}

async function doRefresh() {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: auth.refreshToken }),
  });
  if (!r.ok) { await login(); return; }
  const d = await r.json();
  auth.accessToken  = d.access_token;
  auth.refreshToken = d.refresh_token || auth.refreshToken;
  auth.expiresAt    = decodeExp(d.access_token);
  console.log('[AUTH] Token refreshed ✓');
}

async function ensureAuth() {
  if (!auth.accessToken) { await login(); return; }
  if (Date.now()/1000 >= auth.expiresAt - 300) {
    try { await doRefresh(); } catch { await login(); }
  }
}

// ── State ─────────────────────────────────────────────────────────────────

const state = {
  macro: null, gex: null, cot: null, session: null, prices: null,
  bias:       { score: 0, conf: 0, label: 'NEUTRAL' },
  gates:      {},
  signal:     null,
  kelly:      { fraction: 0.5, contracts: 1, reason: '—' },
  dependency: { streak: 0, multiplier: 1.0, trades: [] },
  pnl:        { today: 0, trades: 0, wins: 0, peak: 0, allTime: 0, trailingDD: 0, dailyLoss: 0 },
  trades:     [],
  log:        [],
  lastUpdate: null,
  newsBlackout: false,
  blackoutReason: '',
  // Rithmic Bridge Data
  rithmic: {
    connected:        false,
    price:            null,
    cumulative_delta: 0,
    buy_sell_ratio:   0.5,
    large_print_bias: 'neutral',
    delta_divergence: 'none',
    vwap:             0,
    vwap_upper1:      0,
    vwap_lower1:      0,
    vwap_upper2:      0,
    vwap_lower2:      0,
    price_vs_vwap:    'unknown',
    atr_14:           0,
    dynamic_stop:     0,
    dynamic_target:   0,
    market_structure: 'unknown',
    swing_high:       null,
    swing_low:        null,
    ema_9:            0,
    ema_21:           0,
    ema_trend:        'neutral',
    dom_imbalance:    0,
    stacked_bids:     false,
    stacked_asks:     false,
    bid_absorption:   false,
    ask_absorption:   false,
    absorption_signal:'none',
    poc:              0,
    session_volume:   0,
    lastUpdate:       null,
  },
};

const risk = {
  baseContracts: 1, maxContracts: 3,
  stopPts: 4.0,  targetPts: 8.0,
  partialPct: 0.25, partialAtPct: 0.50,
  useKelly: true, useDependency: true,
  killSwitch: false,
  maxDailyLoss: TOPSTEP.maxDailyLoss,
  trailingDD:   TOPSTEP.trailingDD,
};

const gatesCfg = {
  bias: true, regime: true, gammaFlip: true, gexWalls: true,
  news: true, dailyLoss: true, trailingDD: true,
  delta: true, vwap: true, dom: false,
};

const NEWS_EVENTS = [];

function addLog(msg, level = 'info') {
  const ts = new Date().toISOString().split('T')[1].slice(0,8);
  state.log.unshift({ ts, msg, level });
  if (state.log.length > 150) state.log.pop();
  level === 'error' ? console.error(`[ALGO] ${msg}`)
    : level === 'warn' ? console.warn(`[ALGO] ${msg}`)
    : console.log(`[ALGO] ${msg}`);
}

// ── API Fetch ─────────────────────────────────────────────────────────────

async function apiGet(endpoint) {
  await ensureAuth();
  const r = await fetch(ALPHA_BIAS_URL + endpoint, {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    timeout: 12000,
  });
  if (r.status === 401) { await login(); return null; }
  if (!r.ok) return null;
  return r.json();
}

async function fetchAll() {
  addLog('Fetching all data...');
  const keys    = ['gex','macro','cot','session','prices'];
  const paths   = ['/api/gex','/api/macro','/api/cot','/api/session','/api/prices'];
  const results = await Promise.allSettled(paths.map(p => apiGet(p)));
  results.forEach((res, i) => {
    if (res.status === 'fulfilled' && res.value) {
      state[keys[i]] = res.value;
      addLog(`${keys[i]} ✓`);
    } else {
      addLog(`${keys[i]} failed: ${res.reason?.message || 'no data'}`, 'warn');
    }
  });
  checkNewsBlackout();
  computeBias();
  computeKelly();
  evaluateSignal();
  state.lastUpdate = new Date().toISOString();
}

// ── News Blackout ─────────────────────────────────────────────────────────

function checkNewsBlackout() {
  state.newsBlackout   = false;
  state.blackoutReason = '';
  const now = Date.now();
  for (const ev of NEWS_EVENTS) {
    const evTime = new Date(ev).getTime();
    if (!isNaN(evTime) && Math.abs(now - evTime) < 30 * 60 * 1000) {
      state.newsBlackout   = true;
      state.blackoutReason = `News blackout: ${ev}`;
      addLog(state.blackoutReason, 'warn');
      return;
    }
  }
  // VIX spike proxy for surprise events
  const vix = state.macro?.vix;
  if (vix && vix > 30) {
    state.newsBlackout   = true;
    state.blackoutReason = `VIX spike: ${vix.toFixed(1)} — pausing trades`;
    addLog(state.blackoutReason, 'warn');
  }
}

// ── Bias Computation ──────────────────────────────────────────────────────

function computeBias() {
  let score = 0;
  const conf   = [];
  const spy    = state.gex?.SPY    || {};
  const macro  = state.macro       || {};
  const cot    = state.cot         || {};
  const sess   = state.session     || {};
  const ep     = state.prices?.ES?.price;
  const regime = state.gex?.sessionRegime || 'MIXED';

  // GEX 40%
  if (Object.keys(spy).length) {
    const above = ep != null && spy.gamma_flip != null ? ep > spy.gamma_flip : null;
    const regimeScores = {
      'MEAN REVERSION': spy.net_gex_label === 'positive' ? 0.1 : -0.1,
      'TRENDING':        above === true ? 0.6 : above === false ? -0.6 : 0,
      'HIGH VOL':       -0.3,
      'CAUTION':        -0.4,
      'MIXED':           0,
    };
    score += (regimeScores[regime] ?? 0) * 0.4;
    conf.push(regime !== 'MIXED' ? 0.85 : 0.4);
  }

  // COT 30% — Leveraged Funds Smart Money
  if (cot.ES) {
    const lf  = cot.ES.leveragedFunds || {};
    const ss  = cot.ES.smallSpec      || {};
    const lfs = ((lf.index || 50) - 50) / 50;
    score += lfs * 0.3;
    if ((ss.index || 50) > 80) score -= 0.08; // Retail extreme long = contrarian bearish
    if ((ss.index || 50) < 20) score += 0.08; // Retail extreme short = contrarian bullish
    conf.push(Math.min(Math.abs(lfs) + 0.3, 1));
  }

  // Macro 20%
  if (macro.macroRegime4) {
    const macroScores = { GOLDILOCKS: 0.7, REFLATION: 0.3, DEFLATION: -0.3, STAGFLATION: -0.8 };
    const ms   = macroScores[macro.macroRegime4] || 0;
    const vix  = macro.vix || 15;
    const damp = vix > 30 ? 0.3 : vix > 25 ? 0.5 : vix > 20 ? 0.75 : 1.0;
    score += ms * damp * 0.2;
    conf.push(0.7);
  }

  // Session 10%
  const a = sess.asia?.bias, l = sess.london?.bias;
  if (a || l) {
    const ss = a === 'bullish' && l === 'bullish' ? 0.5
      : a === 'bearish' && l === 'bearish' ? -0.5
      : (a === 'bullish' || l === 'bullish') ? 0.2 : 0;
    score += ss * 0.1;
    conf.push(0.5);
  }

  score = Math.max(-1, Math.min(1, score));
  const c   = conf.length ? conf.reduce((a,b) => a+b, 0) / conf.length : 0;
  const lbl = score > 0.5  ? 'STRONG BULL'
    : score > 0.15 ? 'BULL'
    : score < -0.5 ? 'STRONG BEAR'
    : score < -0.15 ? 'BEAR'
    : 'NEUTRAL';

  state.bias = { score: +score.toFixed(3), conf: +c.toFixed(3), label: lbl };
}

// ── Kelly Position Sizing ─────────────────────────────────────────────────

function computeKelly() {
  const b      = state.bias;
  const pnl    = state.pnl;
  const dep    = state.dependency;
  const vix    = state.macro?.vix || 15;

  // Base Kelly from win probability estimate
  const pWin    = Math.min(0.7, Math.max(0.3, 0.5 + b.conf * 0.2));
  const rr      = risk.targetPts / risk.stopPts;
  const kelly   = Math.max(0, Math.min(1, (pWin * rr - (1 - pWin)) / rr));
  const halfK   = kelly * 0.5; // Half-Kelly for safety

  // VIX adjustment (Fat Tail dampening)
  const vixAdj  = vix > 30 ? 0.3 : vix > 25 ? 0.5 : vix > 20 ? 0.75 : 1.0;

  // Drawdown Aversion
  const ddPct   = risk.trailingDD > 0 ? pnl.trailingDD / risk.trailingDD : 0;
  const ddAdj   = ddPct > 0.75 ? 0.25 : ddPct > 0.5 ? 0.5 : ddPct > 0.25 ? 0.75 : 1.0;

  // Dependency (Streak-based sizing)
  const streak  = dep.streak;
  const strMult = streak >= 3 ? 1.5 : streak >= 2 ? 1.25
    : streak <= -3 ? 0.25 : streak <= -2 ? 0.5 : 1.0;

  const final   = Math.max(0.1, Math.min(1, halfK * vixAdj * ddAdj * strMult));
  const cts     = Math.max(1, Math.min(risk.maxContracts,
    Math.round(risk.baseContracts * final / 0.5)));

  state.kelly = {
    fraction:   +final.toFixed(3),
    contracts:  cts,
    kellyFull:  +kelly.toFixed(3),
    kellyHalf:  +halfK.toFixed(3),
    vixAdj, ddAdj, streakMult: strMult,
    pWin:       +pWin.toFixed(3),
    reason:     `Kelly=${final.toFixed(2)} VIX=${vix.toFixed(0)}→${vixAdj} ` +
                `DD=${(ddPct*100).toFixed(0)}%→${ddAdj} ` +
                `Streak=${streak >= 0 ? '+' : ''}${streak}→${strMult}`,
  };
}

// ── Gate Evaluation + Signal ──────────────────────────────────────────────

function evaluateSignal() {
  const b      = state.bias;
  const spy    = state.gex?.SPY || {};
  const ep     = state.prices?.ES?.price;
  const regime = state.gex?.sessionRegime || '';
  const pnl    = state.pnl;
  const kelly  = state.kelly;
  const gates  = {};

  const gate = (k, name, passed, val = null) => {
    const on = gatesCfg[k] !== undefined ? gatesCfg[k] : true;
    gates[k] = { on, pass: !on || !!passed, val: val || '—', name };
  };

  // Bias gates
  gate('bias',      'Bias Confirmation',  b.label !== 'NEUTRAL' && b.conf >= 0.4,
    `${b.score >= 0 ? '+' : ''}${b.score}`);
  gate('regime',    'GEX Regime',
    ['TRENDING', 'MEAN REVERSION'].includes(regime), regime || '—');

  // GEX level gates
  const flip = spy.gamma_flip, cw = spy.call_wall, pw = spy.put_wall;
  if (flip != null && ep != null) {
    const d = Math.abs(ep - flip);
    gate('gammaFlip', 'Gamma Flip Dist', d >= 5, `${d.toFixed(1)}pts`);
  } else {
    gate('gammaFlip', 'Gamma Flip Dist', true, 'N/A');
  }
  if (cw != null && ep != null) {
    const dc = Math.abs(ep - cw), dp = pw != null ? Math.abs(ep - pw) : 999;
    gate('gexWalls', 'GEX Wall Dist', dc >= 8 && dp >= 8, `CW:${dc.toFixed(0)} PW:${dp.toFixed(0)}`);
  } else {
    gate('gexWalls', 'GEX Wall Dist', true, 'N/A');
  }

  // Risk gates
  gate('news',      'News Blackout',
    !state.newsBlackout, state.newsBlackout ? state.blackoutReason : 'Clear');
  gate('dailyLoss', 'Daily Loss Limit',
    pnl.dailyLoss < risk.maxDailyLoss, `-$${pnl.dailyLoss.toFixed(0)} / $${risk.maxDailyLoss}`);
  gate('trailingDD','Trailing Drawdown',
    pnl.trailingDD < risk.trailingDD,  `-$${pnl.trailingDD.toFixed(0)} / $${risk.trailingDD}`);

  // Rithmic gates (live when bridge connected)
  const rth = state.rithmic;
  const rConnected = rth.connected;
  
  // Delta Gate: cumulative delta confirms direction
  const deltaOk = !rConnected || (
    b.label.includes('BULL') ? rth.cumulative_delta > 200 :
    b.label.includes('BEAR') ? rth.cumulative_delta < -200 : true
  );
  gate('delta', 'Cumul. Delta', deltaOk,
    rConnected ? `${rth.cumulative_delta > 0 ? '+' : ''}${rth.cumulative_delta.toFixed(0)} (${rth.delta_divergence})` : 'Bridge offline');

  // VWAP Gate: price in VWAP band
  const vwapOk = !rConnected || rth.vwap === 0 || (
    ep >= rth.vwap_lower2 && ep <= rth.vwap_upper2
  );
  gate('vwap', 'VWAP Band', vwapOk,
    rConnected && rth.vwap > 0 ? `${rth.price_vs_vwap} VWAP=${rth.vwap.toFixed(2)}` : 'Bridge offline');

  // DOM Gate: imbalance in signal direction
  const domOk = !rConnected || !gatesCfg.dom || (
    b.label.includes('BULL') ? rth.dom_imbalance > 0.1 :
    b.label.includes('BEAR') ? rth.dom_imbalance < -0.1 : true
  );
  gate('dom', 'DOM Imbalance', domOk,
    rConnected ? `${(rth.dom_imbalance * 100).toFixed(1)}% (${rth.absorption_signal})` : 'Bridge offline');

  state.gates = gates;

  // Kill switch check
  if (risk.killSwitch || ep == null) { state.signal = null; return; }

  // All active gates must pass
  const allPass = Object.values(gates).every(g => !g.on || g.pass);
  if (!allPass || b.label === 'NEUTRAL') { state.signal = null; return; }

  // Direction
  const dir = b.score > 0 ? 'long' : 'short';
  const cts = risk.useKelly ? kelly.contracts : risk.baseContracts;

  // Stop Loss
  const slPts = risk.stopPts;
  const sl    = Math.round((dir === 'long' ? ep - slPts : ep + slPts) / 0.25) * 0.25;

  // Take Profit — prefer GEX wall if reachable
  const wall  = dir === 'long' ? cw : pw;
  let tp, tgtPts = risk.targetPts;
  if (wall != null && Math.abs(wall - ep) > slPts * 1.5) {
    tp = wall; tgtPts = Math.abs(wall - ep);
  } else {
    tp = Math.round((dir === 'long' ? ep + tgtPts : ep - tgtPts) / 0.25) * 0.25;
  }

  // Partial exit (25% at 50% of way to target)
  const partialPrice = Math.round(
    (dir === 'long' ? ep + tgtPts * risk.partialAtPct : ep - tgtPts * risk.partialAtPct) / 0.25) * 0.25;
  const partialCts = Math.max(1, Math.round(cts * risk.partialPct));

  // R/R and EV
  const rr = +(Math.abs(tp - ep) / Math.max(Math.abs(sl - ep), 0.25)).toFixed(2);
  const ev = +((kelly.pWin * tgtPts * 50 * cts) - ((1 - kelly.pWin) * slPts * 50 * cts)).toFixed(2);

  state.signal = {
    direction: dir, price: ep, stopLoss: sl, takeProfit: tp,
    partialPrice, partialContracts: partialCts,
    contracts: cts, rr, evUsd: ev,
    confidence: b.conf, kellyFraction: kelly.fraction,
    gexRegime: regime, gammaFlip: flip, callWall: cw, putWall: pw,
    reason: `${dir.toUpperCase()} | ${b.label} | ${regime} | ` +
            `conf=${(b.conf * 100).toFixed(0)}% | ${cts}ct | EV=$${ev} | ${kelly.reason}`,
    timestamp: new Date().toISOString(),
  };
  addLog(`✅ Signal: ${state.signal.reason}`);
}

// ── Trade Recording ───────────────────────────────────────────────────────

function recordTrade({ direction, entry, exit, contracts, conf = 0, regime = '—' }) {
  entry = parseFloat(entry); exit = parseFloat(exit);
  contracts = parseInt(contracts) || 1;
  const pts    = direction === 'long' ? exit - entry : entry - exit;
  const pnlUsd = pts * 50 * contracts;
  const win    = pnlUsd > 0;
  const p      = state.pnl;

  p.allTime  += pnlUsd;
  p.trades   += 1;
  if (win) p.wins += 1;
  if (pnlUsd < 0) p.dailyLoss += Math.abs(pnlUsd);
  if (p.allTime > p.peak) p.peak = p.allTime;
  p.trailingDD = Math.max(0, p.peak - p.allTime);
  p.today      = p.allTime;

  // Dependency streak
  const dep = state.dependency;
  dep.trades.push(win ? 1 : -1);
  if (dep.trades.length > 20) dep.trades.shift();
  let streak = 0;
  for (let i = dep.trades.length - 1; i >= 0; i--) {
    const t = dep.trades[i];
    if ((win && t === 1) || (!win && t === -1)) { streak += t; }
    else break;
  }
  dep.streak = streak;

  // Log trade
  state.trades.unshift({
    time: new Date().toISOString().split('T')[1].slice(0,8),
    direction, entry, exit, contracts,
    pnl:    +pnlUsd.toFixed(2),
    pts:    +pts.toFixed(2),
    conf, regime, win,
  });
  if (state.trades.length > 100) state.trades.pop();

  addLog(
    `Trade: ${direction.toUpperCase()} ${pts >= 0 ? '+' : ''}${pts.toFixed(2)}pts = ` +
    `$${pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(0)} | ` +
    `DD=$${p.trailingDD.toFixed(0)} | Streak=${streak >= 0 ? '+' : ''}${streak}`,
    win ? 'info' : 'warn'
  );

  // Topstep safety kills
  if (p.dailyLoss >= TOPSTEP.maxDailyLoss) {
    risk.killSwitch = true;
    addLog(`KILL SWITCH: Daily loss $${p.dailyLoss.toFixed(0)} >= limit $${TOPSTEP.maxDailyLoss}`, 'error');
  }
  if (p.trailingDD >= TOPSTEP.trailingDD) {
    risk.killSwitch = true;
    addLog(`KILL SWITCH: Trailing DD $${p.trailingDD.toFixed(0)} >= limit $${TOPSTEP.trailingDD}`, 'error');
  }

  computeKelly();
  evaluateSignal();
}

// ── Polling ───────────────────────────────────────────────────────────────

async function startPolling() {
  // Initial login + fetch
  try { await login(); } catch(e) { console.error('[AUTH] Login failed:', e.message); }
  try { await fetchAll(); } catch(e) { console.error('[FETCH] Initial fetch failed:', e.message); }

  // Fetch all data every 60 seconds
  setInterval(async () => {
    try { await fetchAll(); } catch(e) { addLog(`Poll error: ${e.message}`, 'warn'); }
  }, 60_000);

  // Refresh token every 50 minutes
  setInterval(async () => {
    try { await doRefresh(); } catch(e) { addLog(`Token refresh error: ${e.message}`, 'warn'); }
  }, 50 * 60_000);

  // Daily reset at 23:00 UTC (18:00 ET = CME day end)
  setInterval(() => {
    const now = new Date();
    if (now.getUTCHours() === 23 && now.getUTCMinutes() === 0) {
      state.pnl.dailyLoss = 0;
      if (risk.killSwitch && state.pnl.trailingDD < TOPSTEP.trailingDD) {
        risk.killSwitch = false;
      }
      addLog('Daily PnL reset — new trading day');
    }
  }, 60_000);
}

// ── Express Routes ────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({
  ok:         true,
  loggedIn:   !!auth.accessToken,
  lastUpdate: state.lastUpdate,
  signal:     state.signal?.direction || 'none',
  bias:       state.bias.label,
}));

app.get('/algo/state', (req, res) => res.json({
  bias:           state.bias,
  signal:         state.signal,
  gates:          state.gates,
  kelly:          state.kelly,
  dependency:     state.dependency,
  rithmic:        state.rithmic,
  gex:            state.gex,
  macro:          state.macro,
  cot:            state.cot,
  session:        state.session,
  prices:         state.prices,
  pnl:            state.pnl,
  trades:         state.trades.slice(0, 50),
  log:            state.log.slice(0, 40),
  risk,
  topstep:        TOPSTEP,
  newsBlackout:   state.newsBlackout,
  blackoutReason: state.blackoutReason,
  lastUpdate:     state.lastUpdate,
}));

app.post('/algo/risk', (req, res) => {
  const allowed = Object.keys(risk);
  for (const [k, v] of Object.entries(req.body)) {
    if (allowed.includes(k)) risk[k] = v;
  }
  computeKelly(); evaluateSignal();
  addLog(`Risk updated: ${JSON.stringify(req.body)}`);
  res.json({ ok: true, risk });
});

app.post('/algo/gates', (req, res) => {
  const allowed = Object.keys(gatesCfg);
  for (const [k, v] of Object.entries(req.body)) {
    if (allowed.includes(k)) gatesCfg[k] = !!v;
  }
  evaluateSignal();
  res.json({ ok: true, gates: gatesCfg });
});

app.post('/algo/kill', (req, res) => {
  risk.killSwitch = !!req.body.active;
  addLog(`Kill switch: ${risk.killSwitch ? 'ON ⛔' : 'OFF ✓'}`,
    risk.killSwitch ? 'warn' : 'info');
  evaluateSignal();
  res.json({ ok: true, killSwitch: risk.killSwitch });
});

app.post('/algo/trade', (req, res) => {
  try {
    recordTrade(req.body);
    res.json({ ok: true, pnl: state.pnl });
  } catch(e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/algo/refresh', async (req, res) => {
  try {
    await fetchAll();
    res.json({ ok: true, lastUpdate: state.lastUpdate });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/algo/news', (req, res) => {
  if (req.body.add) {
    NEWS_EVENTS.push(req.body.add);
    addLog(`News event added: ${req.body.add}`);
  }
  if (req.body.remove) {
    const i = NEWS_EVENTS.indexOf(req.body.remove);
    if (i > -1) NEWS_EVENTS.splice(i, 1);
  }
  checkNewsBlackout();
  res.json({ ok: true, events: NEWS_EVENTS });
});

// Rithmic Bridge endpoint
app.post('/algo/rithmic', (req, res) => {
  const d = req.body;
  // Update rithmic state
  Object.assign(state.rithmic, d);
  state.rithmic.connected  = d.connected || false;
  state.rithmic.lastUpdate = new Date().toISOString();

  // Update live price from Rithmic (more accurate than Yahoo)
  if (d.price && d.price > 0) {
    if (!state.prices) state.prices = {};
    state.prices.ES = { price: d.price };
  }

  // Update ATR-based dynamic stops in risk
  if (d.atr_14 && d.atr_14 > 0) {
    risk.stopPts   = Math.max(2, Math.round(d.atr_14 * 1.5 / 0.25) * 0.25);
    risk.targetPts = Math.max(4, Math.round(d.atr_14 * 3.0 / 0.25) * 0.25);
  }

  // Re-evaluate signal with new data
  computeKelly();
  evaluateSignal();

  addLog(`Rithmic: price=${d.price} Δ=${d.cumulative_delta > 0 ? '+' : ''}${d.cumulative_delta} vwap=${d.vwap} struct=${d.market_structure}`);
  res.json({ ok: true });
});

// Dashboard — must be last
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'es_algo_dashboard.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`╔═══════════════════════════════════════╗`);
  console.log(`║  ES Algo Combined Server v3           ║`);
  console.log(`║  Port: ${PORT}                           ║`);
  console.log(`║  Alpha-Bias: ${ALPHA_BIAS_URL.slice(8,32)}...  ║`);
  console.log(`╚═══════════════════════════════════════╝`);
  startPolling();
});
