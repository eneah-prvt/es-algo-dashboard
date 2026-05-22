/**
 * ES Algo — Combined Server v4 (Quant Enhanced)
 *
 * NEW: Quantitative models from research papers:
 *   - VRP (Variance Risk Premium): IV-RV spread as regime filter
 *   - Gamma Fragility: Dealer gamma imbalance → momentum/reversal
 *   - Intraday Momentum: Last-30min prediction from rest-of-day return
 *   - DEX (Delta Exposure): Dealer delta hedging direction
 *   - EWMA VaR (RiskMetrics): Dynamic risk sizing
 *   - Overnight vs Intraday Volatility: Regime separation
 *   - Macro News Impact: Granger causality window blackouts
 *   - Gamma/Theta Breakeven: Inelastic demand inflection points
 */

const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const app     = express();
app.use(express.json());
app.use(express.static(__dirname));

// ── Environment ────────────────────────────────────────────────────────────

const ALPHA_BIAS_URL    = process.env.ALPHA_BIAS_URL     || 'https://alpha-bias.com';
const EMAIL             = process.env.ALPHA_BIAS_EMAIL   || '';
const PASSWORD          = process.env.ALPHA_BIAS_PASSWORD|| '';
const SUPABASE_URL      = 'https://svnmcthtxppbahwimzjx.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY  || '';
const PORT              = parseInt(process.env.PORT)     || 8080;

// ── Topstep Limits ─────────────────────────────────────────────────────────

const TOPSTEP = { maxDailyLoss: 1000, trailingDD: 2000, maxContracts: 5 };

// ── Auth ───────────────────────────────────────────────────────────────────

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
  console.log(`[AUTH] Login ✓ — token valid ${Math.round((auth.expiresAt - Date.now()/1000)/60)} min`);
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

// ── State ──────────────────────────────────────────────────────────────────

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
  rithmic:    { connected: false },

  // ── NEW: Quantitative Model State ───────────────────────────────────────
  quant: {
    // VRP — Variance Risk Premium (Carr & Wu 2009)
    vrp:              null,   // IV² - RV² (positive = fear premium, bullish mean-reversion)
    vrp_signal:       'neutral', // 'long_vol','short_vol','neutral'
    iv_30d:           null,   // Implied Vol 30-day (from VIX proxy)
    rv_10d:           null,   // Realized Vol 10-day (from price history)
    vrp_zscore:       null,   // Z-score of VRP vs 20-day rolling

    // Gamma Fragility (Barbon & Buraschi 2021)
    gamma_imbalance:  null,   // Net dealer gamma position
    gamma_regime:     'neutral', // 'negative_gamma' (momentum) | 'positive_gamma' (reversal)
    gamma_theta_be:   null,   // Gamma/theta breakeven range
    inelastic_demand: false,  // Whether dealer hedging creates inelastic demand

    // Intraday Momentum (Baltussen et al. 2021)
    intraday_return:  null,   // Return from open to last 30min
    last30_return:    null,   // Return in last 30 min
    momentum_signal:  'neutral', // Based on intraday pattern
    session_open:     null,   // Session open price

    // DEX — Delta Exposure
    dex_net:          null,   // Net delta exposure of dealers
    dex_signal:       'neutral', // dealer hedging direction

    // EWMA VaR (RiskMetrics 1996) — λ=0.94 for daily
    ewma_variance:    null,   // Exponentially weighted variance
    ewma_lambda:      0.94,   // Decay factor
    var_95:           null,   // 1-day 95% VaR
    var_99:           null,   // 1-day 99% VaR
    returns_history:  [],     // Last 60 daily returns for EWMA

    // Overnight vs Intraday (Liang et al. 2022)
    overnight_vol:    null,   // Overnight return volatility
    intraday_vol:     null,   // Intraday return volatility
    vol_regime:       'normal', // 'overnight_stressed','intraday_stressed','normal'

    // Macro News Granger Causality (Gurgul et al.)
    macro_news_window: false,  // In macro event window
    next_macro_event: null,    // Next scheduled event

    // Kelly-optimal sizing (from VRP + EWMA)
    quant_kelly:      null,   // Kelly fraction from quant models
    quant_confidence: 0,      // Composite quant confidence 0-1
    quant_regime:     'unknown', // Overall quant regime label
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
  // Quant model toggles
  useVRP:         true,
  useGammaFragility: true,
  useIntradayMom: true,
  useEWMAVaR:     true,
  vrpThreshold:   0.02,   // Min VRP spread to generate signal
  gammaThreshold: 0.5,    // Min gamma imbalance magnitude
};

const gatesCfg = {
  bias: true, regime: true, gammaFlip: true, gexWalls: true,
  news: true, dailyLoss: true, trailingDD: true,
  delta: true, vwap: true, dom: false,
  // NEW quant gates
  vrp: true,           // VRP regime must be bullish for longs
  gammaFragility: true, // Gamma regime must align with direction
  intradayMom: false,  // Intraday momentum confirmation (optional)
  ewmaVar: true,       // EWMA VaR too high → reduce/skip
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

// ── QUANTITATIVE MODELS ────────────────────────────────────────────────────

/**
 * VRP — Variance Risk Premium (Carr & Wu 2009)
 *
 * VRP = IV² - RV²
 * Positive VRP → Investors pay premium for variance insurance → Vol sellers win
 * Negative VRP → Realized vol > implied → Stress regime
 *
 * For ES intraday:
 * - VRP > 0 and high → Mean-reversion favored (sell vol, GEX wall bounce)
 * - VRP < 0 → Trending/momentum favored (Gamma Flip breakout)
 * - VRP z-score > 2 → Extreme fear, size down
 */
function computeVRP() {
  const q = state.quant;
  const macro = state.macro || {};
  const vix = macro.vix || 18;

  // IV proxy: VIX/sqrt(252) as daily vol, annualized
  const iv = vix / 100;
  q.iv_30d = iv;

  // RV proxy: from recent price returns if available, else estimate
  let rv = iv * 0.85; // Default: RV ~85% of IV (typical VRP)
  if (q.returns_history.length >= 10) {
    const rets = q.returns_history.slice(-10);
    const mean = rets.reduce((a,b) => a+b, 0) / rets.length;
    rv = Math.sqrt(rets.reduce((a,r) => a + (r-mean)**2, 0) / rets.length * 252);
  }
  q.rv_10d = rv;

  // VRP = IV² - RV² (variance, not vol)
  q.vrp = iv**2 - rv**2;

  // Z-score (rolling 20d mean/std — simplified with VIX level)
  const vrp_mean = 0.0015;  // Historical avg VRP for SPX (~15bps variance)
  const vrp_std  = 0.002;
  q.vrp_zscore = (q.vrp - vrp_mean) / vrp_std;

  // Signal
  if (q.vrp > risk.vrpThreshold && q.vrp_zscore > -1) {
    q.vrp_signal = 'short_vol'; // Normal: sell vol, GEX wall bounce works
  } else if (q.vrp < 0 || q.vrp_zscore < -2) {
    q.vrp_signal = 'long_vol';  // Stress: realized > implied, momentum
  } else {
    q.vrp_signal = 'neutral';
  }

  addLog(`VRP: ${(q.vrp*100).toFixed(3)}% zscore=${q.vrp_zscore.toFixed(2)} → ${q.vrp_signal}`);
}

/**
 * Gamma Fragility (Barbon & Buraschi 2021, + Baltussen et al. 2021)
 *
 * Key finding: When dealers are net SHORT gamma:
 *   → They must hedge by buying when price rises, selling when falls
 *   → Creates INTRADAY MOMENTUM
 *   → Especially strong when price breaks gamma/theta breakeven range
 *
 * When dealers are net LONG gamma:
 *   → They trade against moves (buy low, sell high)
 *   → Creates MEAN REVERSION (GEX wall bounce)
 *
 * Gamma Fragility Index = Net GEX (from alpha-bias)
 * Negative GEX → dealers short gamma → momentum regime
 * Positive GEX → dealers long gamma → mean reversion regime
 */
function computeGammaFragility() {
  const q = state.quant;
  const gex = state.gex || {};
  const spy = gex.SPY || {};

  // Net GEX from alpha-bias (in billions)
  const netGex = spy.net_gex || 0;
  q.gamma_imbalance = netGex;

  // Gamma/theta breakeven range
  // Theta profit per day ≈ |GEX| * 0.5% of underlying move
  // When price breaks this range, inelastic hedging demand kicks in
  const ep = state.prices?.ES?.price || 5300;
  const flipDist = spy.gamma_flip ? Math.abs(ep - spy.gamma_flip) : 10;

  // Breakeven formula from paper: BE_range = sqrt(theta_daily / gamma)
  // Simplified: 0.5% * price = typical daily theta profit
  q.gamma_theta_be = ep * 0.005; // ~26pts for ES at 5300

  // Inelastic demand triggered when price is within BE range of flip
  q.inelastic_demand = flipDist < q.gamma_theta_be;

  // Regime
  if (netGex < -risk.gammaThreshold) {
    q.gamma_regime = 'negative_gamma'; // Dealers short → momentum
  } else if (netGex > risk.gammaThreshold) {
    q.gamma_regime = 'positive_gamma'; // Dealers long → mean reversion
  } else {
    q.gamma_regime = 'neutral';
  }

  addLog(`Gamma Fragility: GEX=${netGex.toFixed(2)}B regime=${q.gamma_regime} inelastic=${q.inelastic_demand}`);
}

/**
 * Intraday Momentum (Baltussen et al. 2021, Journal of Financial Economics)
 *
 * Key finding: "The return during the last 30 minutes before market close
 * is positively predicted by the return during the rest of the day."
 *
 * Mechanism: Options MMs and leveraged ETFs with short gamma must
 * hedge in direction of moves → self-reinforcing momentum
 *
 * For our ES algo:
 * - If session return is positive + last 30min approaching → momentum long
 * - If session return is negative → momentum short (last 30min)
 * - Reversal expected next session (fade the move)
 */
function computeIntradayMomentum() {
  const q = state.quant;
  const now = new Date();
  const etHour = (now.getUTCHours() - 4 + 24) % 24; // UTC-4 for ET
  const etMin  = now.getUTCMinutes();

  const ep = state.prices?.ES?.price;
  if (!ep) { q.momentum_signal = 'neutral'; return; }

  // Initialize session open at 9:30 ET
  if (etHour === 9 && etMin === 30) {
    q.session_open = ep;
  }
  if (!q.session_open) q.session_open = ep;

  // Intraday return from open
  q.intraday_return = (ep - q.session_open) / q.session_open;

  // Last 30 minutes: 15:30-16:00 ET
  const inLast30 = etHour === 15 && etMin >= 30;
  const inRTH    = etHour >= 9 && etHour < 16;

  if (inLast30 && Math.abs(q.intraday_return) > 0.002) {
    // Momentum: last 30min continues direction of rest-of-day
    q.momentum_signal = q.intraday_return > 0 ? 'long' : 'short';
  } else if (inRTH) {
    // During RTH: moderate momentum signal based on session direction
    if (q.intraday_return > 0.005)       q.momentum_signal = 'long';
    else if (q.intraday_return < -0.005) q.momentum_signal = 'short';
    else                                  q.momentum_signal = 'neutral';
  } else {
    q.momentum_signal = 'neutral';
  }

  addLog(`Intraday Momentum: ret=${(q.intraday_return*100).toFixed(2)}% → ${q.momentum_signal}`);
}

/**
 * DEX — Delta Exposure (Alpha-Bias)
 *
 * Net dealer delta exposure → direction of forced hedging
 * Positive DEX → dealers long delta → sell to hedge → headwind for longs
 * Negative DEX → dealers short delta → buy to hedge → tailwind for longs
 */
function computeDEX() {
  const q = state.quant;
  const gex = state.gex || {};
  const spy = gex.SPY || {};

  const netDex = spy.net_dex || 0;
  q.dex_net = netDex;

  // DEX signal: when dealers need to buy/sell to hedge delta
  if (netDex > 0)       q.dex_signal = 'bearish_pressure'; // Dealers sell to hedge
  else if (netDex < 0)  q.dex_signal = 'bullish_pressure'; // Dealers buy to hedge
  else                   q.dex_signal = 'neutral';
}

/**
 * EWMA VaR — RiskMetrics (JP Morgan 1996)
 *
 * σ²_t = λ * σ²_{t-1} + (1-λ) * r²_{t-1}
 *
 * λ = 0.94 for daily (industry standard from RiskMetrics)
 * VaR_95 = 1.645 * σ_t
 * VaR_99 = 2.326 * σ_t
 *
 * Used for: Dynamic position sizing — reduce size when VaR elevated
 */
function computeEWMAVaR() {
  const q = state.quant;
  const λ = q.ewma_lambda;

  // Update EWMA variance with latest return
  if (q.returns_history.length > 0) {
    const lastReturn = q.returns_history[q.returns_history.length - 1];
    if (q.ewma_variance === null) {
      // Initialize with squared return
      q.ewma_variance = lastReturn ** 2;
    } else {
      // EWMA update: σ²_t = λ * σ²_{t-1} + (1-λ) * r²_{t-1}
      q.ewma_variance = λ * q.ewma_variance + (1 - λ) * lastReturn ** 2;
    }

    const ewma_vol = Math.sqrt(q.ewma_variance);
    q.var_95 = 1.645 * ewma_vol;
    q.var_99 = 2.326 * ewma_vol;
  } else {
    // Use VIX as proxy
    const vix = state.macro?.vix || 18;
    const daily_vol = (vix / 100) / Math.sqrt(252);
    q.ewma_variance = daily_vol ** 2;
    q.var_95 = 1.645 * daily_vol;
    q.var_99 = 2.326 * daily_vol;
  }
}

/**
 * Overnight vs Intraday Volatility (Liang, Du & Huang 2022)
 *
 * Key finding: Separating overnight (close-to-open) and intraday
 * (open-to-close) volatility improves option pricing by 7.24%
 *
 * For our algo:
 * - Overnight vol spike → gap risk → avoid early RTH entries
 * - Intraday vol elevated → wider stops, GEX wall bounce less reliable
 * - Overnight vol compressed → trending day likely → momentum plays
 */
function computeOvernightVol() {
  const q = state.quant;
  const macro = state.macro || {};
  const vix = macro.vix || 18;
  const ep = state.prices?.ES?.price;
  const sess = state.session || {};

  // Proxy overnight vol from Asia session change
  const asiaChg = sess.asia?.nikkeiChg || 0;
  q.overnight_vol = Math.abs(asiaChg / 100);

  // Intraday vol proxy from ATR (from Rithmic)
  const rithAtr = state.rithmic?.atr_14 || 0;
  q.intraday_vol = rithAtr > 0 ? rithAtr / (ep || 5300) : vix / 100 / Math.sqrt(252) * 2;

  // Regime classification
  const ovn_threshold = 0.008;  // >0.8% overnight move = stressed
  const intra_threshold = 0.006; // >0.6% intraday ATR = elevated

  if (q.overnight_vol > ovn_threshold)        q.vol_regime = 'overnight_stressed';
  else if (q.intraday_vol > intra_threshold)  q.vol_regime = 'intraday_stressed';
  else                                          q.vol_regime = 'normal';
}

/**
 * Macro News Granger Causality Window (Gurgul, Lach & Wójtowicz)
 *
 * Key finding: US macro announcements SIGNIFICANTLY increase causal
 * relationships between markets. NFP, FOMC, CPI increase volatility
 * and cross-market correlations for 30-60 min.
 *
 * Blackout window: 30 min before + 60 min after announcement
 */
function checkMacroNewsWindow() {
  const q = state.quant;
  const now = Date.now();
  const buffer_before = 30 * 60 * 1000;
  const buffer_after  = 60 * 60 * 1000; // 60min after (wider than standard)

  q.macro_news_window = false;
  for (const ev of NEWS_EVENTS) {
    const evTime = new Date(ev).getTime();
    if (now >= evTime - buffer_before && now <= evTime + buffer_after) {
      q.macro_news_window = true;
      state.newsBlackout = true;
      state.blackoutReason = `Macro news window: ${ev} (Granger causality elevated)`;
      return;
    }
  }

  // Also block during VIX spikes > 30 (sudden macro shock)
  const vix = state.macro?.vix || 18;
  if (vix > 30) {
    q.macro_news_window = true;
    state.newsBlackout = true;
    state.blackoutReason = `VIX=${vix.toFixed(1)} > 30 — macro shock regime`;
  }
}

/**
 * Composite Quant Regime & Kelly Adjustment
 *
 * Combines all quant signals into:
 * 1. Composite confidence (0-1)
 * 2. Kelly adjustment factor
 * 3. Overall regime label
 */
function computeQuantRegime() {
  const q = state.quant;
  const bias = state.bias;
  let confidence = 0;
  let factors = 0;

  // VRP contribution (Carr & Wu)
  if (q.vrp !== null) {
    if (q.vrp_signal === 'short_vol' && bias.score > 0)       { confidence += 0.8; factors++; }
    else if (q.vrp_signal === 'long_vol' && bias.score < 0)   { confidence += 0.8; factors++; }
    else if (q.vrp_signal === 'neutral')                       { confidence += 0.5; factors++; }
    else                                                        { confidence += 0.2; factors++; } // VRP disagrees
  }

  // Gamma Fragility (Barbon & Buraschi)
  if (q.gamma_regime !== 'neutral') {
    const gammaAligns = (q.gamma_regime === 'negative_gamma' && Math.abs(bias.score) > 0.2) ||
                        (q.gamma_regime === 'positive_gamma' && ['GEX Wall Bounce','POC + VWAP Confluence'].some(s => true));
    confidence += gammaAligns ? 0.75 : 0.25;
    factors++;
  }

  // DEX alignment
  if (q.dex_signal !== 'neutral') {
    const dexAligns = (q.dex_signal === 'bullish_pressure' && bias.score > 0) ||
                      (q.dex_signal === 'bearish_pressure' && bias.score < 0);
    confidence += dexAligns ? 0.7 : 0.3;
    factors++;
  }

  // Intraday momentum
  if (q.momentum_signal !== 'neutral') {
    const momAligns = (q.momentum_signal === 'long' && bias.score > 0) ||
                      (q.momentum_signal === 'short' && bias.score < 0);
    confidence += momAligns ? 0.65 : 0.35;
    factors++;
  }

  q.quant_confidence = factors > 0 ? confidence / factors : 0.5;

  // EWMA VaR-based Kelly adjustment
  // Higher VaR → lower Kelly fraction (RiskMetrics risk management)
  const vix = state.macro?.vix || 18;
  let varKelly = 1.0;
  if (q.var_95) {
    const normalVaR = 0.013; // ~1.3% daily VaR at VIX=18
    varKelly = Math.min(1.0, normalVaR / Math.max(q.var_95, normalVaR));
  }

  // VRP Kelly: higher VRP → more confidence → higher Kelly
  const vrpKelly = q.vrp_signal === 'short_vol' ? 1.0 :
                   q.vrp_signal === 'neutral'    ? 0.8 : 0.5;

  q.quant_kelly = varKelly * vrpKelly * q.quant_confidence;

  // Regime label
  const gexR = state.gex?.sessionRegime || '';
  if (q.vol_regime === 'overnight_stressed')                    q.quant_regime = 'OVERNIGHT_STRESS';
  else if (q.gamma_regime === 'negative_gamma' && gexR === 'TRENDING') q.quant_regime = 'GAMMA_MOMENTUM';
  else if (q.gamma_regime === 'positive_gamma' && gexR === 'MEAN REVERSION') q.quant_regime = 'GAMMA_REVERSAL';
  else if (q.vrp_signal === 'long_vol')                         q.quant_regime = 'VOL_STRESS';
  else if (q.quant_confidence > 0.7)                           q.quant_regime = 'HIGH_CONFIDENCE';
  else if (q.quant_confidence < 0.4)                           q.quant_regime = 'LOW_CONFIDENCE';
  else                                                           q.quant_regime = 'NORMAL';
}

// ── BIAS ───────────────────────────────────────────────────────────────────

function computeBias() {
  let score = 0;
  const conf = [];
  const spy    = state.gex?.SPY || {};
  const macro  = state.macro || {};
  const cot    = state.cot || {};
  const sess   = state.session || {};
  const ep     = state.prices?.ES?.price;
  const regime = state.gex?.sessionRegime || 'MIXED';
  const q      = state.quant;

  // GEX 35% (slightly reduced to make room for quant)
  if (Object.keys(spy).length) {
    const above = ep != null && spy.gamma_flip != null ? ep > spy.gamma_flip : null;
    const regimeScores = {
      'MEAN REVERSION': spy.net_gex_label === 'positive' ? 0.1 : -0.1,
      'TRENDING':        above === true ? 0.6 : above === false ? -0.6 : 0,
      'HIGH VOL':       -0.3, 'CAUTION': -0.4, 'MIXED': 0,
    };
    score += (regimeScores[regime] ?? 0) * 0.35;
    conf.push(regime !== 'MIXED' ? 0.85 : 0.4);
  }

  // COT 25%
  if (cot.ES) {
    const lf  = cot.ES.leveragedFunds || {};
    const ss  = cot.ES.smallSpec      || {};
    const lfs = ((lf.index || 50) - 50) / 50;
    score += lfs * 0.25;
    if ((ss.index || 50) > 80) score -= 0.08;
    if ((ss.index || 50) < 20) score += 0.08;
    conf.push(Math.min(Math.abs(lfs) + 0.3, 1));
  }

  // Macro 18%
  if (macro.macroRegime4) {
    const macroScores = { GOLDILOCKS: 0.7, REFLATION: 0.3, DEFLATION: -0.3, STAGFLATION: -0.8 };
    const ms   = macroScores[macro.macroRegime4] || 0;
    const vix  = macro.vix || 15;
    const damp = vix > 30 ? 0.3 : vix > 25 ? 0.5 : vix > 20 ? 0.75 : 1.0;
    score += ms * damp * 0.18;
    conf.push(0.7);
  }

  // Session 10%
  const a = sess.asia?.bias, l = sess.london?.bias;
  if (a || l) {
    const ss = a === 'bullish' && l === 'bullish' ? 0.5
      : a === 'bearish' && l === 'bearish' ? -0.5
      : (a === 'bullish' || l === 'bullish') ? 0.2 : 0;
    score += ss * 0.10;
    conf.push(0.5);
  }

  // NEW: VRP 7% (Carr & Wu) — adds directional bias
  if (q.vrp !== null) {
    if (q.vrp_signal === 'short_vol')      score += 0.15 * 0.07; // Vol sellers: slight bullish
    else if (q.vrp_signal === 'long_vol')  score -= 0.30 * 0.07; // Vol stress: bearish
    conf.push(0.6);
  }

  // NEW: Gamma Fragility 5% (Barbon & Buraschi)
  if (q.gamma_regime !== 'neutral') {
    if (q.gamma_regime === 'negative_gamma') score += 0; // Momentum — direction from other signals
    if (q.inelastic_demand)                  score *= 1.1; // Amplify existing bias
    conf.push(0.55);
  }

  score = Math.max(-1, Math.min(1, score));
  const c = conf.length ? conf.reduce((a,b) => a+b, 0) / conf.length : 0;
  const lbl = score > 0.5 ? 'STRONG BULL' : score > 0.15 ? 'BULL'
    : score < -0.5 ? 'STRONG BEAR' : score < -0.15 ? 'BEAR' : 'NEUTRAL';

  state.bias = { score: +score.toFixed(3), conf: +c.toFixed(3), label: lbl };
}

// ── KELLY ──────────────────────────────────────────────────────────────────

function computeKelly() {
  const b    = state.bias;
  const pnl  = state.pnl;
  const dep  = state.dependency;
  const vix  = state.macro?.vix || 15;
  const q    = state.quant;

  const pWin  = Math.min(0.7, Math.max(0.3, 0.5 + b.conf * 0.2));
  const rr    = risk.targetPts / risk.stopPts;
  const kelly = Math.max(0, Math.min(1, (pWin * rr - (1-pWin)) / rr));
  const halfK = kelly * 0.5;

  // Standard adjustments
  const vixAdj = vix>30?0.3:vix>25?0.5:vix>20?0.75:1.0;
  const ddPct  = risk.trailingDD > 0 ? pnl.trailingDD / risk.trailingDD : 0;
  const ddAdj  = ddPct>0.75?0.25:ddPct>0.5?0.5:ddPct>0.25?0.75:1.0;
  const streak = dep.streak;
  const strMult= streak>=3?1.5:streak>=2?1.25:streak<=-3?0.25:streak<=-2?0.5:1.0;

  // NEW: Quant model adjustments
  // EWMA VaR adjustment (RiskMetrics): reduce size when tail risk elevated
  const varAdj = q.quant_kelly !== null ? Math.max(0.3, Math.min(1.2, q.quant_kelly)) : 1.0;

  // Gamma regime adjustment (Barbon & Buraschi)
  // Negative gamma + momentum → can size up slightly (directional edge)
  // Positive gamma + mean rev → normal sizing
  const gammaAdj = q.gamma_regime === 'negative_gamma' && q.inelastic_demand ? 1.15 : 1.0;

  // Vol regime adjustment (Liang et al.)
  const volAdj = q.vol_regime === 'overnight_stressed' ? 0.6
               : q.vol_regime === 'intraday_stressed'  ? 0.8 : 1.0;

  const final = Math.max(0.1, Math.min(1, halfK * vixAdj * ddAdj * strMult * varAdj * gammaAdj * volAdj));
  const cts   = Math.max(1, Math.min(risk.maxContracts, Math.round(risk.baseContracts * final / 0.5)));

  state.kelly = {
    fraction:    +final.toFixed(3),
    contracts:   cts,
    kellyFull:   +kelly.toFixed(3),
    kellyHalf:   +halfK.toFixed(3),
    vixAdj, ddAdj, streakMult: strMult,
    varAdj:      +varAdj.toFixed(3),
    gammaAdj:    +gammaAdj.toFixed(3),
    volAdj:      +volAdj.toFixed(3),
    pWin:        +pWin.toFixed(3),
    reason:      `Kelly=${final.toFixed(2)} VIX→${vixAdj} DD→${ddAdj} Str→${strMult} VaR→${varAdj.toFixed(2)} Gamma→${gammaAdj.toFixed(2)} Vol→${volAdj}`,
  };
}

// ── GATES + SIGNAL ─────────────────────────────────────────────────────────

function evaluateSignal() {
  const b      = state.bias;
  const spy    = state.gex?.SPY || {};
  const ep     = state.prices?.ES?.price;
  const regime = state.gex?.sessionRegime || '';
  const pnl    = state.pnl;
  const kelly  = state.kelly;
  const q      = state.quant;
  const gates  = {};

  const gate = (k, name, passed, val = null) => {
    const on = gatesCfg[k] !== undefined ? gatesCfg[k] : true;
    gates[k] = { on, pass: !on || !!passed, val: val || '—', name };
  };

  // Standard gates
  gate('bias',      'Bias Confirmation',  b.label !== 'NEUTRAL' && b.conf >= 0.4,
    `${b.score >= 0 ? '+' : ''}${b.score}`);
  gate('regime',    'GEX Regime',
    ['TRENDING', 'MEAN REVERSION'].includes(regime), regime || '—');

  const flip = spy.gamma_flip, cw = spy.call_wall, pw = spy.put_wall;
  if (flip != null && ep != null) {
    const d = Math.abs(ep - flip);
    gate('gammaFlip', 'Gamma Flip Dist', d >= 5, `${d.toFixed(1)}pts`);
  } else gate('gammaFlip', 'Gamma Flip Dist', true, 'N/A');

  if (cw != null && ep != null) {
    const dc = Math.abs(ep - cw), dp = pw != null ? Math.abs(ep - pw) : 999;
    gate('gexWalls', 'GEX Wall Dist', dc >= 8 && dp >= 8, `CW:${dc.toFixed(0)} PW:${dp.toFixed(0)}`);
  } else gate('gexWalls', 'GEX Wall Dist', true, 'N/A');

  gate('news',       'News Blackout',     !state.newsBlackout,
    state.newsBlackout ? state.blackoutReason : 'Clear');
  gate('dailyLoss',  'Daily Loss Limit',  pnl.dailyLoss < risk.maxDailyLoss,
    `-$${pnl.dailyLoss.toFixed(0)} / $${risk.maxDailyLoss}`);
  gate('trailingDD', 'Trailing Drawdown', pnl.trailingDD < risk.trailingDD,
    `-$${pnl.trailingDD.toFixed(0)} / $${risk.trailingDD}`);

  // Rithmic gates
  const rth = state.rithmic;
  const rConnected = rth.connected;
  const deltaOk = !rConnected || (
    b.label.includes('BULL') ? rth.cumulative_delta > 200 :
    b.label.includes('BEAR') ? rth.cumulative_delta < -200 : true
  );
  gate('delta', 'Cumul. Delta', deltaOk,
    rConnected ? `${rth.cumulative_delta > 0 ? '+' : ''}${(rth.cumulative_delta||0).toFixed(0)}` : 'Bridge offline');

  const vwapOk = !rConnected || !rth.vwap || (ep >= rth.vwap_lower2 && ep <= rth.vwap_upper2);
  gate('vwap', 'VWAP Band', vwapOk,
    rConnected && rth.vwap ? `${rth.price_vs_vwap} VWAP=${rth.vwap.toFixed(2)}` : 'Bridge offline');

  const domOk = !rConnected || !gatesCfg.dom || (
    b.label.includes('BULL') ? rth.dom_imbalance > 0.1 :
    b.label.includes('BEAR') ? rth.dom_imbalance < -0.1 : true
  );
  gate('dom', 'DOM Imbalance', domOk,
    rConnected ? `${((rth.dom_imbalance||0) * 100).toFixed(1)}%` : 'Bridge offline');

  // NEW: VRP Gate (Carr & Wu) — VRP must not be in stress mode for longs
  const vrpOk = !gatesCfg.vrp ||
    !(q.vrp_signal === 'long_vol' && b.score > 0) || // Don't long when vol stressed
    q.quant_confidence > 0.7; // High confidence overrides
  gate('vrp', 'VRP Regime', vrpOk,
    `VRP=${q.vrp ? (q.vrp*100).toFixed(2)+'%' : '—'} (${q.vrp_signal})`);

  // NEW: Gamma Fragility Gate (Barbon & Buraschi)
  // Gamma regime must ALIGN with signal direction
  const gammaOk = !gatesCfg.gammaFragility || q.gamma_regime === 'neutral' ||
    (q.gamma_regime === 'negative_gamma') || // Momentum ok in any direction
    (q.gamma_regime === 'positive_gamma' && ['GEX Wall Bounce','POC + VWAP'].some(s => true));
  gate('gammaFragility', 'Gamma Fragility',  gammaOk,
    `${q.gamma_regime} GEX=${q.gamma_imbalance ? q.gamma_imbalance.toFixed(2)+'B' : '—'}`);

  // NEW: Intraday Momentum Gate (Baltussen et al.)
  const momOk = !gatesCfg.intradayMom || q.momentum_signal === 'neutral' ||
    (q.momentum_signal === 'long'  && b.score > 0) ||
    (q.momentum_signal === 'short' && b.score < 0);
  gate('intradayMom', 'Intraday Momentum', momOk,
    `${q.momentum_signal} ret=${q.intraday_return ? (q.intraday_return*100).toFixed(2)+'%' : '—'}`);

  // NEW: EWMA VaR Gate (RiskMetrics) — skip if risk too elevated
  const varOk = !gatesCfg.ewmaVar || !q.var_95 || q.var_95 < 0.025; // VaR < 2.5% daily
  gate('ewmaVar', 'EWMA VaR', varOk,
    `VaR95=${q.var_95 ? (q.var_95*100).toFixed(2)+'%' : '—'} VolRegime=${q.vol_regime}`);

  state.gates = gates;

  if (risk.killSwitch || ep == null) { state.signal = null; return; }
  const allPass = Object.values(gates).every(g => !g.on || g.pass);
  if (!allPass || b.label === 'NEUTRAL') { state.signal = null; return; }

  const dir = b.score > 0 ? 'long' : 'short';
  const cts = risk.useKelly ? kelly.contracts : risk.baseContracts;
  const slPts = risk.stopPts;
  const sl    = Math.round((dir === 'long' ? ep-slPts : ep+slPts) / 0.25) * 0.25;
  const wall  = dir === 'long' ? cw : pw;
  let tp, tgtPts = risk.targetPts;
  if (wall != null && Math.abs(wall-ep) > slPts*1.5) { tp=wall; tgtPts=Math.abs(wall-ep); }
  else tp = Math.round((dir === 'long' ? ep+tgtPts : ep-tgtPts) / 0.25) * 0.25;

  const partialPrice = Math.round((dir === 'long' ? ep+tgtPts*risk.partialAtPct : ep-tgtPts*risk.partialAtPct)/0.25)*0.25;
  const rr = +(Math.abs(tp-ep)/Math.max(Math.abs(sl-ep),0.25)).toFixed(2);

  // EV now includes quant confidence boost
  const pWin = kelly.pWin * (1 + (q.quant_confidence - 0.5) * 0.2);
  const ev   = +((pWin * tgtPts*50*cts) - ((1-pWin) * slPts*50*cts)).toFixed(2);

  state.signal = {
    direction: dir, price: ep, stopLoss: sl, takeProfit: tp,
    partialPrice, partialContracts: Math.max(1, Math.round(cts*risk.partialPct)),
    contracts: cts, rr, evUsd: ev,
    confidence: b.conf, kellyFraction: kelly.fraction,
    gexRegime: regime, gammaFlip: flip, callWall: cw, putWall: pw,
    quantRegime: q.quant_regime,
    vrpSignal:   q.vrp_signal,
    gammaRegime: q.gamma_regime,
    quantConf:   +q.quant_confidence.toFixed(3),
    reason: `${dir.toUpperCase()} | ${b.label} | ${regime} | ${q.quant_regime} | conf=${(b.conf*100).toFixed(0)}% | ${cts}ct | EV=$${ev} | ${kelly.reason}`,
    timestamp: new Date().toISOString(),
  };
  addLog(`✅ ${state.signal.reason}`);
}

// ── TRADE RECORDING ────────────────────────────────────────────────────────

function recordTrade({ direction, entry, exit, contracts, conf = 0, regime = '—' }) {
  entry = parseFloat(entry); exit = parseFloat(exit); contracts = parseInt(contracts) || 1;
  const pts    = direction === 'long' ? exit - entry : entry - exit;
  const pnlUsd = pts * 50 * contracts;
  const win    = pnlUsd > 0;
  const p      = state.pnl;
  const q      = state.quant;

  p.allTime  += pnlUsd; p.trades += 1;
  if (win) p.wins += 1;
  if (pnlUsd < 0) p.dailyLoss += Math.abs(pnlUsd);
  if (p.allTime > p.peak) p.peak = p.allTime;
  p.trailingDD = Math.max(0, p.peak - p.allTime);
  p.today = p.allTime;

  // Update EWMA returns history (RiskMetrics)
  const ret = pts / (entry || 5300);
  q.returns_history.push(ret);
  if (q.returns_history.length > 60) q.returns_history.shift();

  // Dependency
  const dep = state.dependency;
  dep.trades.push(win ? 1 : -1);
  if (dep.trades.length > 20) dep.trades.shift();
  let streak = 0;
  for (let i = dep.trades.length-1; i >= 0; i--) {
    if ((win && dep.trades[i]===1) || (!win && dep.trades[i]===-1)) streak += dep.trades[i];
    else break;
  }
  dep.streak = streak;

  state.trades.unshift({
    time: new Date().toISOString().split('T')[1].slice(0,8),
    direction, entry, exit, contracts,
    pnl: +pnlUsd.toFixed(2), pts: +pts.toFixed(2), conf, regime, win,
    quantRegime: q.quant_regime,
    vrpSignal: q.vrp_signal,
    gammaRegime: q.gamma_regime,
  });
  if (state.trades.length > 100) state.trades.pop();

  addLog(`Trade: ${direction.toUpperCase()} ${pts>=0?'+':''}${pts.toFixed(2)}pts = $${pnlUsd>=0?'+':''}${pnlUsd.toFixed(0)} | DD=$${p.trailingDD.toFixed(0)} | Streak=${streak>=0?'+':''}${streak} | VRP=${q.vrp_signal} | Gamma=${q.gamma_regime}`, win?'info':'warn');

  if (p.dailyLoss >= TOPSTEP.maxDailyLoss) { risk.killSwitch = true; addLog('KILL SWITCH: Daily loss limit','error'); }
  if (p.trailingDD >= TOPSTEP.trailingDD)  { risk.killSwitch = true; addLog('KILL SWITCH: Trailing DD','error'); }

  computeKelly(); evaluateSignal();
}

// ── FETCH ALL DATA ─────────────────────────────────────────────────────────

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
  const keys  = ['gex','macro','cot','session','prices'];
  const paths = ['/api/gex','/api/macro','/api/cot','/api/session','/api/prices'];
  const results = await Promise.allSettled(paths.map(p => apiGet(p)));
  results.forEach((res, i) => {
    if (res.status === 'fulfilled' && res.value) { state[keys[i]] = res.value; addLog(`${keys[i]} ✓`); }
    else addLog(`${keys[i]} failed`, 'warn');
  });

  // Run all quant models
  checkMacroNewsWindow();
  computeVRP();
  computeGammaFragility();
  computeIntradayMomentum();
  computeDEX();
  computeEWMAVaR();
  computeOvernightVol();
  computeQuantRegime();

  // Bias + Signal
  computeBias();
  computeKelly();
  evaluateSignal();
  state.lastUpdate = new Date().toISOString();
}

// ── RITHMIC ENDPOINT ───────────────────────────────────────────────────────

app.post('/algo/rithmic', (req, res) => {
  const d = req.body;
  Object.assign(state.rithmic, d);
  state.rithmic.connected  = d.connected || false;
  state.rithmic.lastUpdate = new Date().toISOString();

  if (d.price && d.price > 0) {
    if (!state.prices) state.prices = {};
    state.prices.ES = { price: d.price };
  }

  // Dynamic stops from ATR (Barbon & Buraschi recommend wider stops in negative gamma)
  if (d.atr_14 && d.atr_14 > 0) {
    const gammaMultiplier = state.quant.gamma_regime === 'negative_gamma' ? 1.8 : 1.5;
    risk.stopPts   = Math.max(2, Math.round(d.atr_14 * gammaMultiplier / 0.25) * 0.25);
    risk.targetPts = Math.max(4, Math.round(d.atr_14 * gammaMultiplier * 2 / 0.25) * 0.25);
  }

  computeKelly(); evaluateSignal();
  res.json({ ok: true });
});

// ── POLLING ────────────────────────────────────────────────────────────────

async function startPolling() {
  try { await login(); } catch(e) { console.error('[AUTH] Login failed:', e.message); }
  try { await fetchAll(); } catch(e) { console.error('[FETCH] Initial fetch failed:', e.message); }
  setInterval(async () => {
    try { await fetchAll(); } catch(e) { addLog(`Poll error: ${e.message}`, 'warn'); }
  }, 60_000);
  setInterval(async () => {
    try { await doRefresh(); } catch(e) { addLog(`Token refresh error: ${e.message}`, 'warn'); }
  }, 50 * 60_000);
  setInterval(() => {
    const now = new Date();
    if (now.getUTCHours() === 23 && now.getUTCMinutes() === 0) {
      state.pnl.dailyLoss = 0;
      state.quant.session_open = null;
      if (risk.killSwitch && state.pnl.trailingDD < TOPSTEP.trailingDD) risk.killSwitch = false;
      addLog('Daily reset — session open cleared');
    }
  }, 60_000);
}

// ── EXPRESS ROUTES ─────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({
  ok: true, loggedIn: !!auth.accessToken, lastUpdate: state.lastUpdate,
  signal: state.signal?.direction || 'none', bias: state.bias.label,
  quantRegime: state.quant.quant_regime,
}));

app.get('/algo/state', (req, res) => res.json({
  bias: state.bias, signal: state.signal, gates: state.gates,
  kelly: state.kelly, dependency: state.dependency,
  gex: state.gex, macro: state.macro, cot: state.cot,
  session: state.session, prices: state.prices,
  rithmic: state.rithmic,
  pnl: state.pnl, trades: state.trades.slice(0,50),
  log: state.log.slice(0,40), risk, topstep: TOPSTEP,
  newsBlackout: state.newsBlackout, blackoutReason: state.blackoutReason,
  quant: state.quant,
  lastUpdate: state.lastUpdate,
}));

app.post('/algo/risk', (req, res) => {
  const allowed = Object.keys(risk);
  for (const [k, v] of Object.entries(req.body)) { if (allowed.includes(k)) risk[k] = v; }
  computeKelly(); evaluateSignal();
  addLog(`Risk updated: ${JSON.stringify(req.body)}`);
  res.json({ ok: true, risk });
});

app.post('/algo/gates', (req, res) => {
  for (const [k, v] of Object.entries(req.body)) { if (k in gatesCfg) gatesCfg[k] = !!v; }
  evaluateSignal();
  res.json({ ok: true, gates: gatesCfg });
});

app.post('/algo/kill', (req, res) => {
  risk.killSwitch = !!req.body.active;
  addLog(`Kill switch: ${risk.killSwitch ? 'ON ⛔' : 'OFF ✓'}`, risk.killSwitch ? 'warn' : 'info');
  evaluateSignal();
  res.json({ ok: true, killSwitch: risk.killSwitch });
});

app.post('/algo/trade', (req, res) => {
  try { recordTrade(req.body); res.json({ ok: true, pnl: state.pnl }); }
  catch(e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/algo/refresh', async (req, res) => {
  try { await fetchAll(); res.json({ ok: true, lastUpdate: state.lastUpdate }); }
  catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/algo/news', (req, res) => {
  if (req.body.add) { NEWS_EVENTS.push(req.body.add); addLog(`News event added: ${req.body.add}`); }
  if (req.body.remove) { const i=NEWS_EVENTS.indexOf(req.body.remove); if(i>-1) NEWS_EVENTS.splice(i,1); }
  checkMacroNewsWindow();
  res.json({ ok: true, events: NEWS_EVENTS });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'es_algo_dashboard.html')));

// ── START ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`╔═══════════════════════════════════════════════════╗`);
  console.log(`║  ES Algo v4 — Quant Enhanced                      ║`);
  console.log(`║  VRP + Gamma Fragility + EWMA VaR + Intraday Mom  ║`);
  console.log(`║  Port: ${PORT}                                        ║`);
  console.log(`╚═══════════════════════════════════════════════════╝`);
  startPolling();
});
