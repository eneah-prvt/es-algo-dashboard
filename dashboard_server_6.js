/**
 * ES Algo — Dashboard Server v5 (Tradovate Edition)
 * Verifiziert gegen offizielle Tradovate OpenAPI Spec v1.0.0
 *
 * Korrekte Endpoints aus openapi.json:
 *   POST /auth/accesstokenrequest  — Login
 *   GET  /auth/renewaccesstoken    — Token erneuern
 *   GET  /account/list             — Accounts
 *   GET  /contract/find?name=ESZ6  — Contract by name
 *   GET  /contract/suggest?t=ES&l=5 — Contract suchen
 *   POST /order/placeoso           — Bracket Order (Entry + Stop + Target)
 *   POST /order/cancelorder        — Order stornieren
 *   POST /order/liquidateposition  — Position schliessen
 *   GET  /position/list            — Offene Positionen
 *   POST /cashBalance/getcashbalancesnapshot — Live PnL/Balance
 */

const express   = require('express');
const fetch     = require('node-fetch');
const WebSocket = require('ws');
const path      = require('path');
const app       = express();
app.use(express.json());
app.use(express.static(__dirname));

// ══════════════════════════════════════════════════════════════════════════
//  ENVIRONMENT
// ══════════════════════════════════════════════════════════════════════════

const PORT           = parseInt(process.env.PORT)            || 8080;
const TV_NAME        = process.env.TRADOVATE_NAME            || '';
const TV_PASS        = process.env.TRADOVATE_PASS            || '';
const TV_APP_ID      = process.env.TRADOVATE_APP_ID          || 'ESAlgo';
const TV_APP_VERSION = process.env.TRADOVATE_APP_VERSION     || '1.0';
const TV_CID         = process.env.TRADOVATE_CID             || '';  // string per spec
const TV_SEC         = process.env.TRADOVATE_SEC             || '';
const TV_DEMO        = process.env.TRADOVATE_DEMO !== 'false'; // default: demo

// Verified API URLs
const TV_REST = TV_DEMO
  ? 'https://demo.tradovateapi.com/v1'
  : 'https://live.tradovateapi.com/v1';
const TV_WS = TV_DEMO
  ? 'wss://demo.tradovateapi.com/v1/websocket'
  : 'wss://live.tradovateapi.com/v1/websocket';
const TV_MD_WS = TV_DEMO
  ? 'wss://md-demo.tradovateapi.com/v1/websocket'
  : 'wss://md.tradovateapi.com/v1/websocket';

// Alpha-Bias
const ALPHA_BIAS_URL    = process.env.ALPHA_BIAS_URL        || 'https://alpha-bias.com';
const AB_EMAIL          = process.env.ALPHA_BIAS_EMAIL      || '';
const AB_PASSWORD       = process.env.ALPHA_BIAS_PASSWORD   || '';
const SUPABASE_URL      = 'https://svnmcthtxppbahwimzjx.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY     || '';

const TOPSTEP = { maxDailyLoss: 1000, trailingDD: 2000 };

// ══════════════════════════════════════════════════════════════════════════
//  TRADOVATE AUTH
//  POST /auth/accesstokenrequest
//  GET  /auth/renewaccesstoken
// ══════════════════════════════════════════════════════════════════════════

const tvAuth = {
  accessToken:   '',
  mdAccessToken: '',
  expiresAt:     0,   // epoch ms
  userId:        0,
  accountId:     0,
  accountName:   '',
  contractId:    0,
  contractName:  '',
};

async function tvLogin() {
  console.log(`[TV] Logging in as "${TV_NAME}" (${TV_DEMO ? 'DEMO' : 'LIVE'})...`);
  const r = await fetch(`${TV_REST}/auth/accesstokenrequest`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name:       TV_NAME,
      password:   TV_PASS,
      appId:      TV_APP_ID,
      appVersion: TV_APP_VERSION,
      cid:        TV_CID,    // string per spec
      sec:        TV_SEC,
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Login HTTP ${r.status}: ${text}`);
  const d = JSON.parse(text);
  if (d.errorText) throw new Error(`Login error: ${d.errorText}`);
  if (d.p_ticket)  throw new Error('2FA required — disable 2FA on Tradovate account');
  tvAuth.accessToken   = d.accessToken;
  tvAuth.mdAccessToken = d.mdAccessToken || d.accessToken;
  tvAuth.userId        = d.userId;
  // Token expires at expirationTime (ISO string)
  tvAuth.expiresAt     = d.expirationTime ? new Date(d.expirationTime).getTime() : Date.now() + 80*60*1000;
  console.log(`[TV] Login ✓  userId=${d.userId}  name=${d.name}  hasLive=${d.hasLive}`);
  await tvFetchAccount();
}

async function tvRenew() {
  // GET /auth/renewaccesstoken — no body, uses existing Bearer token
  const r = await fetch(`${TV_REST}/auth/renewaccesstoken`, {
    headers: { Authorization: `Bearer ${tvAuth.accessToken}` },
  });
  if (!r.ok) { await tvLogin(); return; }
  const d = await r.json();
  if (d.errorText) { await tvLogin(); return; }
  tvAuth.accessToken = d.accessToken;
  tvAuth.mdAccessToken = d.mdAccessToken || d.accessToken;
  tvAuth.expiresAt = d.expirationTime ? new Date(d.expirationTime).getTime() : Date.now() + 80*60*1000;
  console.log('[TV] Token renewed ✓');
}

async function tvEnsureAuth() {
  if (!tvAuth.accessToken) { await tvLogin(); return; }
  // Renew 5 min before expiry
  if (Date.now() > tvAuth.expiresAt - 5*60*1000) {
    try { await tvRenew(); } catch { await tvLogin(); }
  }
}

// Generic REST helper
async function tvRest(endpoint, method = 'GET', body = null) {
  await tvEnsureAuth();
  const opts = {
    method,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${tvAuth.accessToken}`,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${TV_REST}${endpoint}`, opts);
  const text = await r.text();
  if (!r.ok) throw new Error(`${endpoint} HTTP ${r.status}: ${text}`);
  return JSON.parse(text);
}

// GET /account/list → pick first account
async function tvFetchAccount() {
  const accounts = await tvRest('/account/list');
  if (!accounts || !accounts.length) throw new Error('No accounts found');
  const acc = accounts[0];
  tvAuth.accountId   = acc.id;
  tvAuth.accountName = acc.name;
  console.log(`[TV] Account: ${acc.name} (id=${acc.id} type=${acc.accountType})`);
  // Fetch ES contract right away
  await tvFetchESContract();
}

// GET /contract/suggest?t=ES&l=3 → find current ES front-month
async function tvFetchESContract() {
  try {
    const results = await tvRest('/contract/suggest?t=ES&l=10');
    if (!results || !results.length) {
      console.warn('[TV] No ES contracts from suggest — will retry on order');
      return;
    }
    // Find first ES (not MES, not spread) that is active
    const es = results.find(c =>
      c.name && /^ES[A-Z]\d/.test(c.name) && !c.name.includes('/')
    );
    if (es) {
      tvAuth.contractId   = es.id;
      tvAuth.contractName = es.name;
      console.log(`[TV] ES contract: ${es.name} (id=${es.id})`);
    } else {
      console.warn('[TV] ES not found in suggest results:', results.map(c => c.name));
    }
  } catch(e) {
    console.warn('[TV] tvFetchESContract error:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  TRADOVATE TRADING WEBSOCKET
//  Auth: authorize\n0\n\n{token}
//  Heartbeat: [] every 2.5s
// ══════════════════════════════════════════════════════════════════════════

let tvWs      = null;
let tvWsReady = false;
let tvReqId   = 2;    // 0=auth, 1=syncrequest, 2+ = user requests
let tvPending = {};   // reqId → {resolve, reject}
let tvHbTimer = null;

function tvWsSend(endpoint, body) {
  return new Promise((resolve, reject) => {
    if (!tvWs || !tvWsReady) return reject(new Error('TV WS not ready'));
    const id  = tvReqId++;
    const msg = `${endpoint}\n${id}\n\n${body ? JSON.stringify(body) : ''}`;
    tvPending[id] = { resolve, reject };
    tvWs.send(msg);
    setTimeout(() => {
      if (tvPending[id]) {
        delete tvPending[id];
        reject(new Error(`WS timeout: ${endpoint}`));
      }
    }, 10_000);
  });
}

function tvWsConnect() {
  if (tvWs) { try { tvWs.terminate(); } catch(_) {} }
  tvWsReady = false;
  console.log(`[TV-WS] Connecting ${TV_WS}...`);
  tvWs = new WebSocket(TV_WS);

  tvWs.on('open', () => console.log('[TV-WS] Socket open'));

  tvWs.on('message', raw => {
    const s = raw.toString();
    if (s === 'o') {
      // Server open frame → send auth immediately
      tvWs.send(`authorize\n0\n\n${tvAuth.accessToken}`);
      return;
    }
    if (s === 'h' || s === '[]') return; // heartbeat
    if (!s.startsWith('a[')) return;
    let msgs;
    try { msgs = JSON.parse(s.slice(1)); } catch { return; }

    for (const msg of msgs) {
      // Auth response (i=0)
      if (msg.i === 0) {
        if (msg.s === 200) {
          console.log('[TV-WS] Auth ✓');
          tvWsReady = true;
          // Start heartbeat every 2.5s
          if (tvHbTimer) clearInterval(tvHbTimer);
          tvHbTimer = setInterval(() => {
            if (tvWs && tvWs.readyState === 1) tvWs.send('[]');
          }, 2500);
          // Subscribe to user account events
          tvWs.send(`user/syncrequest\n1\n\n${JSON.stringify({ accounts: [tvAuth.accountId] })}`);
        } else {
          console.error('[TV-WS] Auth failed:', msg);
        }
        continue;
      }
      // Resolve pending request
      if (msg.i && tvPending[msg.i]) {
        const { resolve, reject } = tvPending[msg.i];
        delete tvPending[msg.i];
        if (msg.s === 200 || msg.s === 201) resolve(msg.d);
        else reject(new Error(`WS error ${msg.s}: ${JSON.stringify(msg.d)}`));
        continue;
      }
      // Real-time push events
      if (msg.e === 'props' && msg.d) handleTvProps(msg.d);
    }
  });

  tvWs.on('close', code => {
    console.log(`[TV-WS] Closed (${code}), reconnecting in 5s`);
    tvWsReady = false;
    if (tvHbTimer) { clearInterval(tvHbTimer); tvHbTimer = null; }
    setTimeout(async () => {
      try { await tvEnsureAuth(); tvWsConnect(); }
      catch(e) { console.error('[TV-WS] Reconnect err:', e.message); }
    }, 5000);
  });

  tvWs.on('error', e => console.error('[TV-WS]', e.message));
}

function handleTvProps(props) {
  // Position update
  if (props.position) {
    const positions = Array.isArray(props.position) ? props.position : [props.position];
    for (const pos of positions) {
      if (pos.accountId === tvAuth.accountId) {
        state.tvPosition = pos;
        addLog(`Position: netPos=${pos.netPos} netPrice=${pos.netPrice}`, 'info');
        // Auto-record trade if position closed
        if (pos.netPos === 0 && autoTrade && activePosition) {
          const exitPrice = pos.netPrice || tickState.lastPrice;
          if (exitPrice && activePosition.entry) {
            recordTrade({
              direction: activePosition.direction,
              entry:     activePosition.entry,
              exit:      exitPrice,
              contracts: activePosition.contracts,
              conf:      state.bias.conf,
              regime:    state.gex?.sessionRegime || '—',
            });
          }
          activePosition = null;
          pendingOrderId = null;
        }
      }
    }
  }
  // Balance update
  if (props.cashBalance) {
    const balances = Array.isArray(props.cashBalance) ? props.cashBalance : [props.cashBalance];
    for (const cb of balances) {
      if (cb.accountId === tvAuth.accountId) state.tvBalance = cb;
    }
  }
  // Fill confirmation
  if (props.fill) {
    const fills = Array.isArray(props.fill) ? props.fill : [props.fill];
    for (const fill of fills) {
      addLog(`Fill: ${fill.action} ${fill.qty}@${fill.price} orderId=${fill.orderId}`, 'info');
      state.tvLastFill = fill;
      if (fill.orderId === pendingOrderId) {
        addLog(`Entry fill confirmed @${fill.price}`, 'info');
        if (activePosition) activePosition.entry = fill.price;
      }
    }
  }
  // Order update
  if (props.order) {
    const orders = Array.isArray(props.order) ? props.order : [props.order];
    for (const o of orders) {
      if (o.ordStatus === 'Cancelled' || o.ordStatus === 'Rejected') {
        if (o.id === pendingOrderId) {
          addLog(`Order ${o.id} ${o.ordStatus}: ${o.text || ''}`, 'warn');
          pendingOrderId = null; activePosition = null;
        }
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  TRADOVATE MARKET DATA WEBSOCKET
//  Tick Chart + Quote + DOM
// ══════════════════════════════════════════════════════════════════════════

let mdWs       = null;
let mdWsReady  = false;
let mdReqId    = 2;
let mdHbTimer  = null;

const tickState = {
  lastPrice: null, lastBid: null, lastAsk: null, lastSize: 0, lastUpdate: null,
  sessionBuyVol: 0, sessionSellVol: 0, cumDelta: 0,
  vwapNum: 0, vwapDen: 0, vwap: null,
  barStart: null, barOpen: null, barHigh: null, barLow: null,
  barClose: null, barVolume: 0, barBuyVol: 0, barSellVol: 0, barDelta: 0,
  atr: 4.0, atrHistory: [], ema9: null, ema21: null, prices: [],
  chartSubId: null, quoteSubId: null, domSubId: null,
  dom: { bids: [], asks: [] },
  domImbalance: 0,
};

function mdSend(endpoint, body) {
  if (!mdWs || !mdWsReady) return null;
  const id  = mdReqId++;
  mdWs.send(`${endpoint}\n${id}\n\n${body ? JSON.stringify(body) : ''}`);
  return id;
}

function mdWsConnect() {
  if (mdWs) { try { mdWs.terminate(); } catch(_) {} }
  mdWsReady = false;
  console.log(`[MD-WS] Connecting ${TV_MD_WS}...`);
  mdWs = new WebSocket(TV_MD_WS);

  mdWs.on('open', () => console.log('[MD-WS] Socket open'));

  mdWs.on('message', raw => {
    const s = raw.toString();
    if (s === 'o') {
      mdWs.send(`authorize\n0\n\n${tvAuth.mdAccessToken}`);
      return;
    }
    if (s === 'h' || s === '[]') return;
    if (!s.startsWith('a[')) return;
    let msgs;
    try { msgs = JSON.parse(s.slice(1)); } catch { return; }

    for (const msg of msgs) {
      if (msg.i === 0) {
        if (msg.s === 200) {
          console.log('[MD-WS] Auth ✓');
          mdWsReady = true;
          if (mdHbTimer) clearInterval(mdHbTimer);
          mdHbTimer = setInterval(() => {
            if (mdWs && mdWs.readyState === 1) mdWs.send('[]');
          }, 2500);
          subscribeMarketData();
        }
        continue;
      }
      if (msg.e === 'md'    && msg.d) handleMdEvent(msg.d);
      if (msg.e === 'chart' && msg.d) handleChartEvent(msg.d);
    }
  });

  mdWs.on('close', code => {
    console.log(`[MD-WS] Closed (${code}), reconnecting in 5s`);
    mdWsReady = false;
    if (mdHbTimer) { clearInterval(mdHbTimer); mdHbTimer = null; }
    setTimeout(async () => {
      try { await tvEnsureAuth(); mdWsConnect(); }
      catch(e) { console.error('[MD-WS] Reconnect err:', e.message); }
    }, 5000);
  });

  mdWs.on('error', e => console.error('[MD-WS]', e.message));
}

async function subscribeMarketData() {
  const name = tvAuth.contractName;
  if (!name) {
    await tvFetchESContract();
    if (!tvAuth.contractName) {
      console.warn('[MD] No ES contract yet, retrying in 30s');
      setTimeout(subscribeMarketData, 30_000);
      return;
    }
  }
  const sym = tvAuth.contractName;
  console.log(`[MD] Subscribing to ${sym}...`);

  // Tick chart
  tickState.chartSubId = mdSend('md/getChart', {
    symbol: sym,
    chartDescription: { underlyingType: 'Tick', elementSize: 1, elementSizeUnit: 'UnderlyingUnits' },
    timeRange: { asMuchAsElements: 500 },
  });

  // Quote (bid/ask/last)
  tickState.quoteSubId = mdSend('md/subscribeQuote', { symbol: sym });

  // DOM Level-2
  tickState.domSubId = mdSend('md/subscribeDOM', { symbol: sym });

  console.log(`[MD] Subscribed: chart=${tickState.chartSubId} quote=${tickState.quoteSubId} dom=${tickState.domSubId}`);
}

// ── Market Data event handlers ─────────────────────────────────────────

function handleMdEvent(d) {
  if (d.quotes) {
    for (const q of d.quotes) {
      if (!q.entries) continue;
      const bid   = q.entries.Bid?.price;
      const ask   = q.entries.Offer?.price;
      const trade = q.entries.Trade;
      if (bid !== undefined) tickState.lastBid = bid;
      if (ask !== undefined) tickState.lastAsk = ask;
      if (trade?.price) {
        processTick(trade.price, trade.size || 1, tickState.lastBid, tickState.lastAsk);
      }
    }
  }
  if (d.dom) {
    for (const dom of d.dom) {
      if (dom.bids) tickState.dom.bids = dom.bids.slice(0, 10);
      if (dom.asks) tickState.dom.asks = dom.asks.slice(0, 10);
    }
    const bv = tickState.dom.bids.slice(0,5).reduce((a,b)=>a+(b.size||0),0);
    const av = tickState.dom.asks.slice(0,5).reduce((a,b)=>a+(b.size||0),0);
    tickState.domImbalance = (bv+av)>0 ? (bv-av)/(bv+av) : 0;
  }
}

function handleChartEvent(d) {
  if (!d.charts) return;
  for (const pkt of d.charts) {
    if (pkt.eoh) { console.log('[MD] Tick history loaded ✓'); continue; }
    if (!pkt.tks || !pkt.bp || !pkt.ts) continue;
    const bp = pkt.bp, ts = pkt.ts;
    for (const tk of pkt.tks) {
      const price = (bp + tk.p) * ts;
      const size  = tk.s || 1;
      const bid   = tk.b !== undefined ? (bp + tk.b) * ts : tickState.lastBid;
      const ask   = tk.a !== undefined ? (bp + tk.a) * ts : tickState.lastAsk;
      processTick(price, size, bid, ask);
    }
  }
}

function processTick(price, size, bid, ask) {
  if (!price || price <= 0) return;

  // Aggressor side classification
  let side = 0;
  if (ask && price >= ask)    side = 1;   // Hit ask = buy
  else if (bid && price <= bid) side = -1; // Hit bid = sell
  else if (tickState.lastPrice) side = price > tickState.lastPrice ? 1 : price < tickState.lastPrice ? -1 : 0;

  tickState.sessionBuyVol  += side === 1  ? size : 0;
  tickState.sessionSellVol += side === -1 ? size : 0;
  tickState.cumDelta = tickState.sessionBuyVol - tickState.sessionSellVol;

  // VWAP (session reset on daily reset)
  tickState.vwapNum += price * size;
  tickState.vwapDen += size;
  tickState.vwap = tickState.vwapDen > 0 ? tickState.vwapNum / tickState.vwapDen : price;

  // 1-min bar
  const minT = Math.floor(Date.now() / 60_000) * 60_000;
  if (!tickState.barStart || minT > tickState.barStart) {
    if (tickState.barStart) closeBar();
    tickState.barStart = minT;
    tickState.barOpen = tickState.barHigh = tickState.barLow = tickState.barClose = price;
    tickState.barVolume = size;
    tickState.barBuyVol  = side === 1  ? size : 0;
    tickState.barSellVol = side === -1 ? size : 0;
  } else {
    if (price > tickState.barHigh) tickState.barHigh = price;
    if (price < tickState.barLow)  tickState.barLow  = price;
    tickState.barClose   = price;
    tickState.barVolume += size;
    tickState.barBuyVol  += side === 1  ? size : 0;
    tickState.barSellVol += side === -1 ? size : 0;
  }
  tickState.barDelta = tickState.barBuyVol - tickState.barSellVol;

  // EMA9 / EMA21
  if (!tickState.ema9) { tickState.ema9 = price; tickState.ema21 = price; }
  tickState.ema9  = price * (2/10)  + tickState.ema9  * (1 - 2/10);
  tickState.ema21 = price * (2/22)  + tickState.ema21 * (1 - 2/22);

  tickState.prices.push(price);
  if (tickState.prices.length > 50) tickState.prices.shift();
  tickState.lastPrice  = price;
  tickState.lastBid    = bid;
  tickState.lastAsk    = ask;
  tickState.lastSize   = size;
  tickState.lastUpdate = new Date().toISOString();

  updateAlgoFromTick();
}

function closeBar() {
  const prev = tickState.prices[tickState.prices.length - 2] || tickState.barClose;
  const tr   = Math.max(
    tickState.barHigh - tickState.barLow,
    Math.abs(tickState.barHigh - prev),
    Math.abs(tickState.barLow  - prev)
  );
  tickState.atrHistory.push(tr);
  if (tickState.atrHistory.length > 14) tickState.atrHistory.shift();
  tickState.atr = tickState.atrHistory.reduce((a,b)=>a+b,0) / tickState.atrHistory.length;
}

function updateAlgoFromTick() {
  const ts = tickState;
  if (!ts.lastPrice) return;

  state.rithmic = {
    connected:         true,
    price:             ts.lastPrice,
    bid:               ts.lastBid,
    ask:               ts.lastAsk,
    cumulative_delta:  ts.cumDelta,
    bar_delta:         ts.barDelta,
    vwap:              ts.vwap,
    vwap_upper1:       ts.vwap ? ts.vwap + ts.atr     : null,
    vwap_lower1:       ts.vwap ? ts.vwap - ts.atr     : null,
    vwap_upper2:       ts.vwap ? ts.vwap + ts.atr * 2 : null,
    vwap_lower2:       ts.vwap ? ts.vwap - ts.atr * 2 : null,
    price_vs_vwap:     ts.vwap ? (ts.lastPrice >= ts.vwap ? 'above' : 'below') : 'unknown',
    atr_14:            ts.atr,
    ema_9:             ts.ema9,
    ema_21:            ts.ema21,
    ema_trend:         ts.ema9 && ts.ema21 ? (ts.ema9 > ts.ema21 ? 'bullish' : 'bearish') : 'unknown',
    session_buy_vol:   ts.sessionBuyVol,
    session_sell_vol:  ts.sessionSellVol,
    session_volume:    ts.sessionBuyVol + ts.sessionSellVol,
    buy_pct:           (ts.sessionBuyVol + ts.sessionSellVol) > 0
                         ? ts.sessionBuyVol / (ts.sessionBuyVol + ts.sessionSellVol) * 100 : 50,
    large_print_bias:  ts.cumDelta > 200 ? 'bullish' : ts.cumDelta < -200 ? 'bearish' : 'neutral',
    delta_divergence:  ts.cumDelta > 0 && ts.lastPrice < (ts.vwap || ts.lastPrice) ? 'bullish'
                     : ts.cumDelta < 0 && ts.lastPrice > (ts.vwap || ts.lastPrice) ? 'bearish' : 'neutral',
    absorption_signal: 'none',
    market_structure:  ts.ema9 && ts.ema21 ? (ts.ema9 > ts.ema21 ? 'bullish' : 'bearish') : 'unknown',
    dom_imbalance:     ts.domImbalance,
    stacked_bids:      ts.dom.bids.slice(0,3).every(b => (b.size||0) > 50),
    stacked_asks:      ts.dom.asks.slice(0,3).every(a => (a.size||0) > 50),
    poc:               ts.vwap,  // VWAP as POC proxy
    lastUpdate:        ts.lastUpdate,
  };

  if (!state.prices) state.prices = {};
  state.prices.ES = { price: ts.lastPrice };

  // Dynamic stops from ATR (Gamma Fragility: wider stops in negative gamma)
  if (ts.atr > 0) {
    const gm = state.quant?.gamma_regime === 'negative_gamma' ? 1.8 : 1.5;
    risk.stopPts   = Math.max(2, Math.round(ts.atr * gm       / 0.25) * 0.25);
    risk.targetPts = Math.max(4, Math.round(ts.atr * gm * 2   / 0.25) * 0.25);
  }

  computeKelly();
  evaluateSignal();
  checkAutoTrade();
}

// ══════════════════════════════════════════════════════════════════════════
//  AUTO-TRADING ENGINE
//  Uses /order/placeoso (bracket: entry + stop + target)
// ══════════════════════════════════════════════════════════════════════════

let autoTrade      = false;
let pendingOrderId = null;
let activePosition = null;

async function checkAutoTrade() {
  if (!autoTrade || risk.killSwitch) return;
  if (!tvWsReady || !tvAuth.accountId) return;
  if (activePosition || pendingOrderId) return;

  const sig = state.signal;
  if (!sig) return;

  const allPass = Object.values(state.gates).every(g => !g.on || g.pass);
  if (!allPass) return;

  try { await placeOrder(sig); }
  catch(e) { addLog(`AutoTrade failed: ${e.message}`, 'error'); }
}

async function placeOrder(sig) {
  await tvEnsureAuth();

  // Ensure we have contract
  if (!tvAuth.contractName) await tvFetchESContract();
  if (!tvAuth.contractName) throw new Error('ES contract not found — check market data subscription');

  const direction = sig.direction;
  const action    = direction === 'long' ? 'Buy' : 'Sell';
  const cts       = sig.contracts || risk.baseContracts || 1;
  const price     = sig.price || tickState.lastPrice;
  const stopPts   = sig.stopPts_actual   || risk.stopPts;
  const targetPts = sig.targetPts_actual || risk.targetPts;

  const stopPrice = direction === 'long'
    ? Math.round((price - stopPts)   / 0.25) * 0.25
    : Math.round((price + stopPts)   / 0.25) * 0.25;
  const tgtPrice  = direction === 'long'
    ? Math.round((price + targetPts) / 0.25) * 0.25
    : Math.round((price - targetPts) / 0.25) * 0.25;

  // POST /order/placeoso — bracket order (verified from openapi.json)
  // bracket1 = stop-loss, bracket2 = take-profit
  const body = {
    accountSpec:  tvAuth.accountName,
    accountId:    tvAuth.accountId,
    action:       action,
    symbol:       tvAuth.contractName,
    orderQty:     cts,
    orderType:    'Market',
    isAutomated:  true,   // REQUIRED by CME Group regulations
    bracket1: {
      action:    action === 'Buy' ? 'Sell' : 'Buy',
      orderType: 'StopMarket',
      stopPrice: stopPrice,
    },
    bracket2: {
      action:    action === 'Buy' ? 'Sell' : 'Buy',
      orderType: 'Limit',
      price:     tgtPrice,
    },
  };

  addLog(`Placing OSO: ${action} ${cts}x ${tvAuth.contractName} | SL=${stopPrice} TP=${tgtPrice}`, 'info');

  const result = await tvRest('/order/placeoso', 'POST', body);

  if (result.failureReason) {
    throw new Error(`Order rejected: ${result.failureReason} — ${result.failureText || ''}`);
  }

  pendingOrderId = result.orderId;
  activePosition = {
    direction, entry: price, stop: stopPrice, target: tgtPrice,
    contracts: cts, orderId: pendingOrderId,
    time: new Date().toISOString(),
  };
  addLog(`Order placed ✓ orderId=${pendingOrderId} ${action} ${cts}x @market → SL=${stopPrice} TP=${tgtPrice}`, 'info');
  return result;
}

// POST /order/cancelorder
async function cancelOrder(orderId) {
  const id = orderId || pendingOrderId;
  if (!id) return;
  await tvEnsureAuth();
  const result = await tvRest('/order/cancelorder', 'POST', {
    orderId:     id,
    isAutomated: true,
  });
  addLog(`Order ${id} cancelled`, 'warn');
  pendingOrderId = null;
  return result;
}

// POST /order/liquidateposition  (contractId + accountId required per spec)
async function liquidatePosition() {
  if (!activePosition && !state.tvPosition?.netPos) return;
  await tvEnsureAuth();
  if (!tvAuth.contractId) await tvFetchESContract();
  const result = await tvRest('/order/liquidateposition', 'POST', {
    accountId:   tvAuth.accountId,
    contractId:  tvAuth.contractId,
    admin:       false,
    isAutomated: true,
  });
  addLog(`Position liquidated`, 'warn');
  activePosition = null; pendingOrderId = null;
  return result;
}

// POST /cashBalance/getcashbalancesnapshot
async function fetchCashBalance() {
  try {
    const snap = await tvRest('/cashBalance/getcashbalancesnapshot', 'POST', {
      accountId: tvAuth.accountId,
    });
    if (!snap.errorText) {
      state.tvBalance = snap;
      // Update PnL from live balance
      if (snap.realizedPnL !== undefined) state.pnl.allTime = snap.realizedPnL;
      if (snap.totalPnL    !== undefined) state.pnl.today   = snap.totalPnL;
    }
  } catch(e) {
    // Non-critical — don't log spam
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  ALPHA-BIAS AUTH (GEX / Macro / COT — unchanged)
// ══════════════════════════════════════════════════════════════════════════

const abAuth = { accessToken: '', refreshToken: '', expiresAt: 0 };

function decodeExp(tok) {
  try { return JSON.parse(Buffer.from(tok.split('.')[1],'base64').toString()).exp || 0; }
  catch { return 0; }
}
async function abLogin() {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method:'POST', headers:{ apikey: SUPABASE_ANON_KEY, 'Content-Type':'application/json' },
    body: JSON.stringify({ email: AB_EMAIL, password: AB_PASSWORD }),
  });
  if (!r.ok) throw new Error(`AB login ${r.status}`);
  const d = await r.json();
  abAuth.accessToken  = d.access_token;
  abAuth.refreshToken = d.refresh_token;
  abAuth.expiresAt    = decodeExp(d.access_token);
  console.log('[AB] Login ✓');
}
async function abRefresh() {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method:'POST', headers:{ apikey: SUPABASE_ANON_KEY, 'Content-Type':'application/json' },
    body: JSON.stringify({ refresh_token: abAuth.refreshToken }),
  });
  if (!r.ok) { await abLogin(); return; }
  const d = await r.json();
  abAuth.accessToken  = d.access_token;
  abAuth.refreshToken = d.refresh_token || abAuth.refreshToken;
  abAuth.expiresAt    = decodeExp(d.access_token);
}
async function abEnsureAuth() {
  if (!abAuth.accessToken)                         { await abLogin();   return; }
  if (Date.now()/1000 >= abAuth.expiresAt - 300)  { try { await abRefresh(); } catch { await abLogin(); } }
}
async function abGet(endpoint) {
  await abEnsureAuth();
  const r = await fetch(ALPHA_BIAS_URL + endpoint, {
    headers: { Authorization: `Bearer ${abAuth.accessToken}` },
  });
  if (r.status === 401) { await abLogin(); return null; }
  if (!r.ok) return null;
  return r.json();
}

// ══════════════════════════════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════════════════════════════

const state = {
  macro:null, gex:null, cot:null, session:null, prices:null,
  bias:       { score:0, conf:0, label:'NEUTRAL' },
  gates:      {},
  signal:     null,
  kelly:      { fraction:0.5, contracts:1, reason:'—' },
  dependency: { streak:0, multiplier:1.0, trades:[] },
  pnl:        { today:0, allTime:0, trades:0, wins:0, peak:0, trailingDD:0, dailyLoss:0 },
  trades: [], log: [], lastUpdate: null,
  newsBlackout: false, blackoutReason: '',
  rithmic:    { connected: false },
  tvPosition: null, tvBalance: null, tvLastFill: null,
  quant: {
    vrp:null, vrp_signal:'neutral', iv_30d:null, rv_10d:null, vrp_zscore:null,
    gamma_imbalance:null, gamma_regime:'neutral', gamma_theta_be:null, inelastic_demand:false,
    intraday_return:null, momentum_signal:'neutral', session_open:null,
    dex_net:null, dex_signal:'neutral',
    ewma_variance:null, ewma_lambda:0.94, var_95:null, var_99:null, returns_history:[],
    overnight_vol:null, intraday_vol:null, vol_regime:'normal',
    macro_news_window:false, quant_kelly:null, quant_confidence:0, quant_regime:'unknown',
  },
};

const risk = {
  baseContracts:1, maxContracts:3,
  stopPts:4.0, targetPts:8.0,
  partialPct:0.25, partialAtPct:0.50,
  useKelly:true, useDependency:true, killSwitch:false,
  maxDailyLoss: TOPSTEP.maxDailyLoss, trailingDD: TOPSTEP.trailingDD,
  useVRP:true, useGammaFragility:true, useIntradayMom:true, useEWMAVaR:true,
  vrpThreshold:0.02, gammaThreshold:0.5,
};

const gatesCfg = {
  bias:true, regime:true, gammaFlip:true, gexWalls:true,
  news:true, dailyLoss:true, trailingDD:true, delta:true, vwap:true, dom:false,
  vrp:true, gammaFragility:true, intradayMom:false, ewmaVar:true,
};

const NEWS_EVENTS = [];

function addLog(msg, level='info') {
  const ts = new Date().toISOString().split('T')[1].slice(0,8);
  state.log.unshift({ ts, msg, level });
  if (state.log.length > 150) state.log.pop();
  level==='error' ? console.error(`[ALGO] ${msg}`) : level==='warn' ? console.warn(`[ALGO] ${msg}`) : console.log(`[ALGO] ${msg}`);
}

// ══════════════════════════════════════════════════════════════════════════
//  QUANT MODELS
// ══════════════════════════════════════════════════════════════════════════

function computeVRP() {
  const q=state.quant; const vix=state.macro?.vix||18;
  const iv=vix/100; q.iv_30d=iv;
  let rv=iv*0.85;
  if (q.returns_history.length>=10) {
    const rets=q.returns_history.slice(-10); const mean=rets.reduce((a,b)=>a+b,0)/rets.length;
    rv=Math.sqrt(rets.reduce((a,r)=>a+(r-mean)**2,0)/rets.length*252);
  }
  q.rv_10d=rv; q.vrp=iv**2-rv**2;
  q.vrp_zscore=(q.vrp-0.0015)/0.002;
  q.vrp_signal=q.vrp>risk.vrpThreshold&&q.vrp_zscore>-1?'short_vol':q.vrp<0||q.vrp_zscore<-2?'long_vol':'neutral';
}
function computeGammaFragility() {
  const q=state.quant; const spy=state.gex?.SPY||{}; const netGex=spy.net_gex||0;
  q.gamma_imbalance=netGex;
  const ep=state.prices?.ES?.price;
  q.gamma_theta_be=ep?ep*0.005:26;
  const flipDist=spy.gamma_flip&&ep?Math.abs(ep-spy.gamma_flip):10;
  q.inelastic_demand=flipDist<q.gamma_theta_be;
  q.gamma_regime=netGex<-risk.gammaThreshold?'negative_gamma':netGex>risk.gammaThreshold?'positive_gamma':'neutral';
}
function computeIntradayMomentum() {
  const q=state.quant; const now=new Date();
  const etH=(now.getUTCHours()-4+24)%24; const etM=now.getUTCMinutes();
  const ep=state.prices?.ES?.price;
  if (!ep) { q.momentum_signal='neutral'; return; }
  if (etH===9&&etM===30) q.session_open=ep;
  if (!q.session_open) q.session_open=ep;
  q.intraday_return=(ep-q.session_open)/q.session_open;
  const inLast30=etH===15&&etM>=30;
  if (inLast30&&Math.abs(q.intraday_return)>0.002) q.momentum_signal=q.intraday_return>0?'long':'short';
  else if (q.intraday_return>0.005) q.momentum_signal='long';
  else if (q.intraday_return<-0.005) q.momentum_signal='short';
  else q.momentum_signal='neutral';
}
function computeDEX() {
  const q=state.quant; const spy=state.gex?.SPY||{}; const netDex=spy.net_dex||0;
  q.dex_net=netDex; q.dex_signal=netDex>0?'bearish_pressure':netDex<0?'bullish_pressure':'neutral';
}
function computeEWMAVaR() {
  const q=state.quant; const λ=q.ewma_lambda;
  if (q.returns_history.length>0) {
    const lr=q.returns_history[q.returns_history.length-1];
    q.ewma_variance=q.ewma_variance===null?lr**2:λ*q.ewma_variance+(1-λ)*lr**2;
    const vol=Math.sqrt(q.ewma_variance); q.var_95=1.645*vol; q.var_99=2.326*vol;
  } else {
    const dv=(state.macro?.vix||18)/100/Math.sqrt(252);
    q.ewma_variance=dv**2; q.var_95=1.645*dv; q.var_99=2.326*dv;
  }
}
function computeOvernightVol() {
  const q=state.quant; const sess=state.session||{};
  q.overnight_vol=Math.abs((sess.asia?.nikkeiChg||0)/100);
  q.intraday_vol=state.rithmic?.atr_14>0?state.rithmic.atr_14/(state.prices?.ES?.price||5300):(state.macro?.vix||18)/100/Math.sqrt(252)*2;
  q.vol_regime=q.overnight_vol>0.008?'overnight_stressed':q.intraday_vol>0.006?'intraday_stressed':'normal';
}
function checkMacroNewsWindow() {
  const q=state.quant; const now=Date.now(); const b4=30*60*1000; const after=60*60*1000;
  q.macro_news_window=false;
  for (const ev of NEWS_EVENTS) {
    const et=new Date(ev).getTime();
    if (now>=et-b4&&now<=et+after) { q.macro_news_window=true; state.newsBlackout=true; state.blackoutReason=`Macro news: ${ev}`; return; }
  }
  const vix=state.macro?.vix||18;
  if (vix>30) { q.macro_news_window=true; state.newsBlackout=true; state.blackoutReason=`VIX=${vix.toFixed(1)}>30`; }
  else { state.newsBlackout=false; state.blackoutReason=''; }
}
function computeQuantRegime() {
  const q=state.quant; const b=state.bias; let conf=0,factors=0;
  if (q.vrp!==null) { conf+=((q.vrp_signal==='short_vol'&&b.score>0)||(q.vrp_signal==='long_vol'&&b.score<0))?0.8:q.vrp_signal==='neutral'?0.5:0.2; factors++; }
  if (q.gamma_regime!=='neutral') { conf+=0.7; factors++; }
  if (q.dex_signal!=='neutral') { conf+=((q.dex_signal==='bullish_pressure'&&b.score>0)||(q.dex_signal==='bearish_pressure'&&b.score<0))?0.7:0.3; factors++; }
  if (q.momentum_signal!=='neutral') { conf+=((q.momentum_signal==='long'&&b.score>0)||(q.momentum_signal==='short'&&b.score<0))?0.65:0.35; factors++; }
  q.quant_confidence=factors>0?conf/factors:0.5;
  const varAdj=q.var_95?Math.min(1,0.013/Math.max(q.var_95,0.013)):1;
  const vrpK=q.vrp_signal==='short_vol'?1.0:q.vrp_signal==='neutral'?0.8:0.5;
  q.quant_kelly=varAdj*vrpK*q.quant_confidence;
  if (q.vol_regime==='overnight_stressed') q.quant_regime='OVERNIGHT_STRESS';
  else if (q.gamma_regime==='negative_gamma') q.quant_regime='GAMMA_MOMENTUM';
  else if (q.gamma_regime==='positive_gamma') q.quant_regime='GAMMA_REVERSAL';
  else if (q.vrp_signal==='long_vol') q.quant_regime='VOL_STRESS';
  else if (q.quant_confidence>0.7) q.quant_regime='HIGH_CONFIDENCE';
  else if (q.quant_confidence<0.4) q.quant_regime='LOW_CONFIDENCE';
  else q.quant_regime='NORMAL';
}

// ══════════════════════════════════════════════════════════════════════════
//  BIAS + KELLY + GATES + SIGNAL
// ══════════════════════════════════════════════════════════════════════════

function computeBias() {
  let score=0; const conf=[];
  const spy=state.gex?.SPY||{}; const macro=state.macro||{};
  const cot=state.cot||{}; const sess=state.session||{};
  const ep=state.prices?.ES?.price; const regime=state.gex?.sessionRegime||'MIXED'; const q=state.quant;
  if (Object.keys(spy).length) {
    const above=ep!=null&&spy.gamma_flip!=null?ep>spy.gamma_flip:null;
    const rs={'MEAN REVERSION':spy.net_gex_label==='positive'?0.1:-0.1,'TRENDING':above===true?0.6:above===false?-0.6:0,'HIGH VOL':-0.3,'CAUTION':-0.4,'MIXED':0};
    score+=(rs[regime]??0)*0.35; conf.push(regime!=='MIXED'?0.85:0.4);
  }
  if (cot.ES) {
    const lf=cot.ES.leveragedFunds||{},ss=cot.ES.smallSpec||{};
    score+=((lf.index||50)-50)/50*0.25;
    if ((ss.index||50)>80) score-=0.08;
    if ((ss.index||50)<20) score+=0.08;
    conf.push(0.7);
  }
  if (macro.macroRegime4) {
    const ms={GOLDILOCKS:0.7,REFLATION:0.3,DEFLATION:-0.3,STAGFLATION:-0.8}[macro.macroRegime4]||0;
    const vix=macro.vix||15;
    score+=ms*(vix>30?0.3:vix>25?0.5:vix>20?0.75:1.0)*0.18; conf.push(0.7);
  }
  const a=sess.asia?.bias,l=sess.london?.bias;
  if (a||l) { score+=(a==='bullish'&&l==='bullish'?0.5:a==='bearish'&&l==='bearish'?-0.5:(a==='bullish'||l==='bullish')?0.2:0)*0.10; conf.push(0.5); }
  if (q.vrp!==null) { score+=(q.vrp_signal==='short_vol'?0.15:q.vrp_signal==='long_vol'?-0.30:0)*0.07; conf.push(0.6); }
  if (q.gamma_regime!=='neutral') { if (q.inelastic_demand) score*=1.1; conf.push(0.55); }
  score=Math.max(-1,Math.min(1,score));
  const c=conf.length?conf.reduce((a,b)=>a+b,0)/conf.length:0;
  state.bias={ score:+score.toFixed(3), conf:+c.toFixed(3), label:score>0.5?'STRONG BULL':score>0.15?'BULL':score<-0.5?'STRONG BEAR':score<-0.15?'BEAR':'NEUTRAL' };
}

function computeKelly() {
  const b=state.bias,pnl=state.pnl,dep=state.dependency,q=state.quant;
  const vix=state.macro?.vix||15;
  const pWin=Math.min(0.7,Math.max(0.3,0.5+b.conf*0.2));
  const rr=risk.targetPts/risk.stopPts;
  const kelly=Math.max(0,Math.min(1,(pWin*rr-(1-pWin))/rr));
  const halfK=kelly*0.5;
  const vixAdj=vix>30?0.3:vix>25?0.5:vix>20?0.75:1.0;
  const ddPct=risk.trailingDD>0?pnl.trailingDD/risk.trailingDD:0;
  const ddAdj=ddPct>0.75?0.25:ddPct>0.5?0.5:ddPct>0.25?0.75:1.0;
  const streak=dep.streak;
  const strMult=streak>=3?1.5:streak>=2?1.25:streak<=-3?0.25:streak<=-2?0.5:1.0;
  const varAdj=q.quant_kelly!==null?Math.max(0.3,Math.min(1.2,q.quant_kelly)):1.0;
  const gammaAdj=q.gamma_regime==='negative_gamma'&&q.inelastic_demand?1.15:1.0;
  const volAdj=q.vol_regime==='overnight_stressed'?0.6:q.vol_regime==='intraday_stressed'?0.8:1.0;
  const final=Math.max(0.1,Math.min(1,halfK*vixAdj*ddAdj*strMult*varAdj*gammaAdj*volAdj));
  const cts=Math.max(1,Math.min(risk.maxContracts,Math.round(risk.baseContracts*final/0.5)));
  state.kelly={ fraction:+final.toFixed(3), contracts:cts, kellyFull:+kelly.toFixed(3), pWin:+pWin.toFixed(3), vixAdj, ddAdj, streakMult:strMult, varAdj:+varAdj.toFixed(3), gammaAdj:+gammaAdj.toFixed(3), volAdj:+volAdj.toFixed(3), reason:`Kelly=${final.toFixed(2)} VIX→${vixAdj} DD→${ddAdj} Str→${strMult} VaR→${varAdj.toFixed(2)} Gamma→${gammaAdj.toFixed(2)}` };
}

function evaluateSignal() {
  const b=state.bias,spy=state.gex?.SPY||{},ep=state.prices?.ES?.price;
  const regime=state.gex?.sessionRegime||'',pnl=state.pnl,kelly=state.kelly,q=state.quant;
  const gates={};
  const gate=(k,name,passed,val=null)=>{ const on=gatesCfg[k]!==undefined?gatesCfg[k]:true; gates[k]={on,pass:!on||!!passed,val:val||'—',name}; };
  gate('bias','Bias Confirmation',b.label!=='NEUTRAL'&&b.conf>=0.4,`${b.score>=0?'+':''}${b.score}`);
  gate('regime','GEX Regime',['TRENDING','MEAN REVERSION'].includes(regime),regime||'—');
  const flip=spy.gamma_flip,cw=spy.call_wall,pw=spy.put_wall;
  if (flip!=null&&ep!=null){const d=Math.abs(ep-flip);gate('gammaFlip','Gamma Flip Dist',d>=5,`${d.toFixed(1)}pts`);}else gate('gammaFlip','Gamma Flip Dist',true,'N/A');
  if (cw!=null&&ep!=null){const dc=Math.abs(ep-cw),dp=pw!=null?Math.abs(ep-pw):999;gate('gexWalls','GEX Wall Dist',dc>=8&&dp>=8,`CW:${dc.toFixed(0)} PW:${dp.toFixed(0)}`);}else gate('gexWalls','GEX Wall Dist',true,'N/A');
  gate('news','News Blackout',!state.newsBlackout,state.newsBlackout?state.blackoutReason:'Clear');
  gate('dailyLoss','Daily Loss Limit',pnl.dailyLoss<risk.maxDailyLoss,`-$${pnl.dailyLoss.toFixed(0)} / $${risk.maxDailyLoss}`);
  gate('trailingDD','Trailing Drawdown',pnl.trailingDD<risk.trailingDD,`-$${pnl.trailingDD.toFixed(0)} / $${risk.trailingDD}`);
  const rth=state.rithmic,rConn=rth.connected;
  gate('delta','Cumul. Delta',!rConn||(b.label.includes('BULL')?rth.cumulative_delta>200:b.label.includes('BEAR')?rth.cumulative_delta<-200:true),rConn?`${rth.cumulative_delta>0?'+':''}${(rth.cumulative_delta||0).toFixed(0)}`:'TV offline');
  const vwapOk=!rConn||!rth.vwap||(ep>=rth.vwap_lower2&&ep<=rth.vwap_upper2);
  gate('vwap','VWAP Band',vwapOk,rConn&&rth.vwap?`${rth.price_vs_vwap} VWAP=${rth.vwap.toFixed(2)}`:'TV offline');
  const domOk=!rConn||!gatesCfg.dom||(b.label.includes('BULL')?rth.dom_imbalance>0.1:b.label.includes('BEAR')?rth.dom_imbalance<-0.1:true);
  gate('dom','DOM Imbalance',domOk,rConn?`${((rth.dom_imbalance||0)*100).toFixed(1)}%`:'TV offline');
  gate('vrp','VRP Regime',!gatesCfg.vrp||!(q.vrp_signal==='long_vol'&&b.score>0)||q.quant_confidence>0.7,`VRP=${q.vrp?(q.vrp*100).toFixed(2)+'%':'—'} (${q.vrp_signal})`);
  gate('gammaFragility','Gamma Fragility',!gatesCfg.gammaFragility||q.gamma_regime==='neutral'||true,`${q.gamma_regime}`);
  gate('intradayMom','Intraday Momentum',!gatesCfg.intradayMom||q.momentum_signal==='neutral'||(q.momentum_signal==='long'&&b.score>0)||(q.momentum_signal==='short'&&b.score<0),`${q.momentum_signal}`);
  gate('ewmaVar','EWMA VaR',!gatesCfg.ewmaVar||!q.var_95||q.var_95<0.025,`VaR95=${q.var_95?(q.var_95*100).toFixed(2)+'%':'—'}`);
  state.gates=gates;
  if (risk.killSwitch||ep==null) { state.signal=null; return; }
  const allPass=Object.values(gates).every(g=>!g.on||g.pass);
  if (!allPass||b.label==='NEUTRAL') { state.signal=null; return; }
  const dir=b.score>0?'long':'short';
  const cts=risk.useKelly?kelly.contracts:risk.baseContracts;
  const slPts=risk.stopPts,tgtPts=risk.targetPts;
  const sl=Math.round((dir==='long'?ep-slPts:ep+slPts)/0.25)*0.25;
  const wall=dir==='long'?cw:pw;
  let tp=Math.round((dir==='long'?ep+tgtPts:ep-tgtPts)/0.25)*0.25,finalTgt=tgtPts;
  if (wall!=null&&Math.abs(wall-ep)>slPts*1.5) { tp=wall; finalTgt=Math.abs(wall-ep); }
  const pWin=kelly.pWin*(1+(q.quant_confidence-0.5)*0.2);
  const ev=+((pWin*finalTgt*50*cts)-((1-pWin)*slPts*50*cts)).toFixed(2);
  state.signal={ direction:dir, price:ep, stopLoss:sl, takeProfit:tp, contracts:cts, rr:+(finalTgt/slPts).toFixed(2), evUsd:ev, stopPts_actual:slPts, targetPts_actual:finalTgt, confidence:b.conf, kellyFraction:kelly.fraction, gexRegime:regime, gammaFlip:flip, callWall:cw, putWall:pw, quantRegime:q.quant_regime, vrpSignal:q.vrp_signal, gammaRegime:q.gamma_regime, quantConf:+q.quant_confidence.toFixed(3), reason:`${dir.toUpperCase()} | ${b.label} | ${regime} | ${q.quant_regime} | conf=${(b.conf*100).toFixed(0)}% | ${cts}ct | EV=$${ev} | ${kelly.reason}`, timestamp:new Date().toISOString() };
  addLog(`✅ ${state.signal.reason}`);
}

function recordTrade({ direction, entry, exit, contracts, conf=0, regime='—' }) {
  entry=parseFloat(entry); exit=parseFloat(exit); contracts=parseInt(contracts)||1;
  const pts=direction==='long'?exit-entry:entry-exit;
  const pnlUsd=pts*50*contracts; const win=pnlUsd>0;
  const p=state.pnl,q=state.quant;
  p.allTime+=pnlUsd; p.trades+=1; if(win) p.wins+=1;
  if (pnlUsd<0) p.dailyLoss+=Math.abs(pnlUsd);
  if (p.allTime>p.peak) p.peak=p.allTime;
  p.trailingDD=Math.max(0,p.peak-p.allTime); p.today=p.allTime;
  const ret=pts/(entry||5300); q.returns_history.push(ret); if(q.returns_history.length>60) q.returns_history.shift();
  const dep=state.dependency;
  dep.trades.push(win?1:-1); if(dep.trades.length>20) dep.trades.shift();
  let streak=0; for(let i=dep.trades.length-1;i>=0;i--){ if((win&&dep.trades[i]===1)||(!win&&dep.trades[i]===-1))streak+=dep.trades[i];else break; } dep.streak=streak;
  state.trades.unshift({ time:new Date().toISOString().split('T')[1].slice(0,8), direction, entry, exit, contracts, pnl:+pnlUsd.toFixed(2), pts:+pts.toFixed(2), conf, regime, win, quantRegime:q.quant_regime });
  if (state.trades.length>100) state.trades.pop();
  addLog(`Trade: ${direction.toUpperCase()} ${pts>=0?'+':''}${pts.toFixed(2)}pts = $${pnlUsd>=0?'+':''}${pnlUsd.toFixed(0)} | Streak=${streak>=0?'+':''}${streak}`,win?'info':'warn');
  if (p.dailyLoss>=TOPSTEP.maxDailyLoss) { risk.killSwitch=true; addLog('KILL SWITCH: Daily loss limit','error'); }
  if (p.trailingDD>=TOPSTEP.trailingDD)  { risk.killSwitch=true; addLog('KILL SWITCH: Trailing DD','error'); }
  activePosition=null; pendingOrderId=null;
  computeKelly(); evaluateSignal();
}

// ══════════════════════════════════════════════════════════════════════════
//  ALPHA-BIAS POLLING
// ══════════════════════════════════════════════════════════════════════════

async function fetchAlphaBias() {
  addLog('Fetching Alpha-Bias...');
  const keys=['gex','macro','cot','session','prices'];
  const paths=['/api/gex','/api/macro','/api/cot','/api/session','/api/prices'];
  const results=await Promise.allSettled(paths.map(p=>abGet(p)));
  results.forEach((res,i)=>{ if(res.status==='fulfilled'&&res.value){state[keys[i]]=res.value;addLog(`${keys[i]} ✓`);}else addLog(`${keys[i]} failed`,'warn'); });
  checkMacroNewsWindow(); computeVRP(); computeGammaFragility(); computeIntradayMomentum();
  computeDEX(); computeEWMAVaR(); computeOvernightVol(); computeQuantRegime();
  computeBias(); computeKelly(); evaluateSignal();
  state.lastUpdate=new Date().toISOString();
}

// ══════════════════════════════════════════════════════════════════════════
//  EXPRESS ROUTES
// ══════════════════════════════════════════════════════════════════════════

app.get('/health', (req,res) => res.json({
  ok:true, tvConnected:tvWsReady, mdConnected:mdWsReady,
  loggedIn:!!tvAuth.accessToken, demo:TV_DEMO,
  account:tvAuth.accountName, contract:tvAuth.contractName,
  signal:state.signal?.direction||'none', bias:state.bias.label,
  quantRegime:state.quant.quant_regime, autoTrade, lastUpdate:state.lastUpdate,
}));

app.get('/algo/state', (req,res) => res.json({
  bias:state.bias, signal:state.signal, gates:state.gates,
  kelly:state.kelly, dependency:state.dependency,
  gex:state.gex, macro:state.macro, cot:state.cot,
  session:state.session, prices:state.prices, rithmic:state.rithmic,
  pnl:state.pnl, trades:state.trades.slice(0,50),
  log:state.log.slice(0,40), risk, topstep:TOPSTEP,
  newsBlackout:state.newsBlackout, blackoutReason:state.blackoutReason,
  quant:state.quant, lastUpdate:state.lastUpdate,
  tvConnected:tvWsReady, mdConnected:mdWsReady, autoTrade,
  tvPosition:state.tvPosition, tvBalance:state.tvBalance,
}));

app.post('/algo/risk',  (req,res) => { Object.entries(req.body).forEach(([k,v])=>{ if(k in risk) risk[k]=v; }); computeKelly(); evaluateSignal(); res.json({ok:true,risk}); });
app.post('/algo/gates', (req,res) => { Object.entries(req.body).forEach(([k,v])=>{ if(k in gatesCfg) gatesCfg[k]=!!v; }); evaluateSignal(); res.json({ok:true,gates:gatesCfg}); });

app.post('/algo/kill', (req,res) => {
  risk.killSwitch=!!req.body.active;
  if (risk.killSwitch&&activePosition) liquidatePosition().catch(e=>addLog(`Kill switch liquidate error: ${e.message}`,'error'));
  addLog(`Kill switch: ${risk.killSwitch?'ON ⛔':'OFF ✓'}`,risk.killSwitch?'warn':'info');
  evaluateSignal(); res.json({ok:true,killSwitch:risk.killSwitch});
});

app.post('/algo/trade', (req,res) => {
  try { recordTrade(req.body); res.json({ok:true,pnl:state.pnl}); }
  catch(e) { res.status(400).json({ok:false,error:e.message}); }
});

app.post('/algo/refresh', async(req,res) => {
  try { await fetchAlphaBias(); res.json({ok:true,lastUpdate:state.lastUpdate}); }
  catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.post('/algo/news', (req,res) => {
  if (req.body.add)    { NEWS_EVENTS.push(req.body.add); }
  if (req.body.remove) { const i=NEWS_EVENTS.indexOf(req.body.remove); if(i>-1) NEWS_EVENTS.splice(i,1); }
  checkMacroNewsWindow(); res.json({ok:true,events:NEWS_EVENTS});
});

// Tradovate endpoints
app.post('/algo/autotrade', (req,res) => {
  autoTrade=!!req.body.active;
  addLog(`AutoTrade: ${autoTrade?'ENABLED ✅':'DISABLED ⛔'}`,autoTrade?'info':'warn');
  res.json({ok:true,autoTrade});
});

app.post('/algo/order', async(req,res) => {
  try {
    const sig=req.body.signal||state.signal;
    if (!sig) return res.status(400).json({ok:false,error:'No signal'});
    const result=await placeOrder(sig);
    res.json({ok:true,result,orderId:pendingOrderId});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.post('/algo/cancel', async(req,res) => {
  try { await cancelOrder(req.body.orderId); res.json({ok:true}); }
  catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.post('/algo/close', async(req,res) => {
  try { await liquidatePosition(); res.json({ok:true}); }
  catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.get('/algo/account', async(req,res) => {
  try {
    const [accounts, positions, snap] = await Promise.all([
      tvRest('/account/list'),
      tvRest('/position/list'),
      tvRest('/cashBalance/getcashbalancesnapshot','POST',{accountId:tvAuth.accountId}),
    ]);
    res.json({ok:true,accounts,positions,balance:snap});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// Legacy Rithmic bridge (fallback if Tradovate WS not yet connected)
app.post('/algo/rithmic', (req,res) => {
  if (!tickState.lastPrice) {
    Object.assign(state.rithmic, req.body);
    if (req.body.price&&!state.prices) state.prices={ES:{price:req.body.price}};
    computeKelly(); evaluateSignal();
  }
  res.json({ok:true});
});

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'es_algo_dashboard.html')));

// ══════════════════════════════════════════════════════════════════════════
//  STARTUP
// ══════════════════════════════════════════════════════════════════════════

async function start() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  ES Algo v5 — Tradovate Edition (OpenAPI Verified)   ║');
  console.log(`║  Mode: ${TV_DEMO?'DEMO':'LIVE'} | Port: ${PORT}                              ║`);
  console.log('╚══════════════════════════════════════════════════════╝');

  // Tradovate login + WebSocket
  try {
    await tvLogin();
    tvWsConnect();
    setTimeout(() => { if (tvAuth.mdAccessToken) mdWsConnect(); }, 3000);
  } catch(e) {
    console.error('[TV] Startup error:', e.message);
    console.error('[TV] Check TRADOVATE_NAME / TRADOVATE_PASS / TRADOVATE_CID / TRADOVATE_SEC');
  }

  // Alpha-Bias
  try { await abLogin(); await fetchAlphaBias(); }
  catch(e) { console.error('[AB] Error:', e.message); }

  // Alpha-Bias polling every 60s
  setInterval(async()=>{ try{await fetchAlphaBias();}catch(e){addLog(`AB poll: ${e.message}`,'warn');} },60_000);

  // Balance snapshot every 30s
  setInterval(async()=>{ if(tvAuth.accountId) await fetchCashBalance(); },30_000);

  // Token renew every 80 min
  setInterval(async()=>{ try{await tvRenew();}catch{try{await tvLogin();}catch(e){addLog(`Token renew: ${e.message}`,'warn');}} },80*60_000);

  // Daily reset at midnight UTC
  setInterval(()=>{
    const now=new Date();
    if(now.getUTCHours()===0&&now.getUTCMinutes()===0) {
      state.pnl.dailyLoss=0;
      state.quant.session_open=null;
      tickState.sessionBuyVol=tickState.sessionSellVol=tickState.cumDelta=0;
      tickState.vwapNum=tickState.vwapDen=0; tickState.vwap=null;
      if(risk.killSwitch&&state.pnl.trailingDD<TOPSTEP.trailingDD) risk.killSwitch=false;
      addLog('Daily reset');
    }
  },60_000);
}

app.listen(PORT,()=>{ console.log(`Listening on port ${PORT}`); start().catch(e=>console.error('Fatal:',e.message)); });
