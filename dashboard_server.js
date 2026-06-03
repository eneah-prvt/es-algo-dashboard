/**
 * ES Algo — Dashboard Server v5 (Tradovate Edition)
 *
 * Ersetzt die alte Rithmic Bridge komplett.
 * Tradovate liefert:
 *   - Echtzeit Tick-Daten (Bid/Ask/Trade) via WebSocket
 *   - Automatische Order-Ausführung (Bracket Orders)
 *   - Live Positions, PnL, Account State
 *   - DOM Level-2 Daten
 *
 * Alpha-Bias bleibt für GEX/Macro/COT/Session Daten.
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

const PORT              = parseInt(process.env.PORT)            || 8080;

// Tradovate credentials (set in Railway environment variables)
const TV_NAME           = process.env.TRADOVATE_NAME            || '';
const TV_PASS           = process.env.TRADOVATE_PASS            || '';
const TV_APP_ID         = process.env.TRADOVATE_APP_ID          || 'ESAlgo';
const TV_APP_VERSION    = process.env.TRADOVATE_APP_VERSION     || '1.0';
const TV_CID            = parseInt(process.env.TRADOVATE_CID)   || 0;
const TV_SEC            = process.env.TRADOVATE_SEC             || '';
const TV_DEMO           = process.env.TRADOVATE_DEMO === 'true'; // true = demo, false = live

// Tradovate API endpoints
const TV_AUTH_URL  = TV_DEMO
  ? 'https://demo-api.tradovate.com/v1/auth/accesstokenrequest'
  : 'https://live-api.tradovate.com/v1/auth/accesstokenrequest';
const TV_REST_URL  = TV_DEMO
  ? 'https://demo-api.tradovate.com/v1'
  : 'https://live-api.tradovate.com/v1';
const TV_WS_URL    = TV_DEMO
  ? 'wss://demo-api.tradovate.com/v1/websocket'
  : 'wss://live-api.tradovate.com/v1/websocket';
const TV_MD_WS_URL = TV_DEMO
  ? 'wss://demo-md.tradovate.com/v1/websocket'
  : 'wss://md.tradovate.com/v1/websocket';

// Alpha-Bias (GEX/Macro/COT - unchanged)
const ALPHA_BIAS_URL    = process.env.ALPHA_BIAS_URL            || 'https://alpha-bias.com';
const AB_EMAIL          = process.env.ALPHA_BIAS_EMAIL          || '';
const AB_PASSWORD       = process.env.ALPHA_BIAS_PASSWORD       || '';
const SUPABASE_URL      = 'https://svnmcthtxppbahwimzjx.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY         || '';

// Risk (Topstep-compatible limits, adjustable via API)
const TOPSTEP = { maxDailyLoss: 1000, trailingDD: 2000 };

// ══════════════════════════════════════════════════════════════════════════
//  TRADOVATE AUTH
// ══════════════════════════════════════════════════════════════════════════

const tvAuth = {
  accessToken:   '',
  mdAccessToken: '',
  expiresAt:     0,
  userId:        0,
  accountId:     0,
  accountName:   '',
};

async function tvLogin() {
  console.log(`[TV] Logging in as ${TV_NAME} (${TV_DEMO ? 'DEMO' : 'LIVE'})...`);
  const r = await fetch(TV_AUTH_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name:       TV_NAME,
      password:   TV_PASS,
      appId:      TV_APP_ID,
      appVersion: TV_APP_VERSION,
      cid:        TV_CID,
      sec:        TV_SEC,
    }),
  });
  if (!r.ok) throw new Error(`TV login failed: ${r.status} ${await r.text()}`);
  const d = await r.json();
  if (d.p_ticket) throw new Error(`TV login requires 2FA — disable 2FA on account`);
  tvAuth.accessToken   = d.accessToken;
  tvAuth.mdAccessToken = d.mdAccessToken || d.accessToken;
  tvAuth.userId        = d.userId;
  tvAuth.expiresAt     = Date.now() + 80 * 60 * 1000; // 80 min (tokens expire in 90)
  console.log(`[TV] Login ✓ userId=${d.userId} name=${d.name}`);
  await tvFetchAccount();
}

async function tvEnsureAuth() {
  if (!tvAuth.accessToken || Date.now() > tvAuth.expiresAt - 60_000) {
    await tvLogin();
  }
}

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
  const r = await fetch(`${TV_REST_URL}${endpoint}`, opts);
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`TV REST ${endpoint} failed: ${r.status} ${txt}`);
  }
  return r.json();
}

async function tvFetchAccount() {
  const accounts = await tvRest('/account/list');
  if (!accounts || !accounts.length) throw new Error('No Tradovate accounts found');
  const acc = accounts[0];
  tvAuth.accountId   = acc.id;
  tvAuth.accountName = acc.name;
  console.log(`[TV] Account: ${acc.name} (id=${acc.id})`);
}

// ══════════════════════════════════════════════════════════════════════════
//  TRADOVATE WEBSOCKET — TRADING (orders, positions, fills)
// ══════════════════════════════════════════════════════════════════════════

let tvWs         = null;
let tvWsReady    = false;
let tvReqId      = 2;
let tvPendingOrders = {};   // reqId → {resolve, reject}
let tvHeartbeat  = null;

function tvWsSend(endpoint, body) {
  return new Promise((resolve, reject) => {
    if (!tvWs || !tvWsReady) return reject(new Error('TV WS not connected'));
    const id  = tvReqId++;
    const msg = body
      ? `${endpoint}\n${id}\n\n${JSON.stringify(body)}`
      : `${endpoint}\n${id}\n\n`;
    tvPendingOrders[id] = { resolve, reject };
    tvWs.send(msg);
    // Timeout after 10s
    setTimeout(() => {
      if (tvPendingOrders[id]) {
        delete tvPendingOrders[id];
        reject(new Error(`TV WS timeout for ${endpoint}`));
      }
    }, 10_000);
  });
}

function tvWsConnect() {
  if (tvWs) { try { tvWs.terminate(); } catch(e) {} }
  tvWsReady = false;

  console.log(`[TV-WS] Connecting to ${TV_WS_URL}...`);
  tvWs = new WebSocket(TV_WS_URL);

  tvWs.on('open', () => {
    console.log('[TV-WS] Connected');
  });

  tvWs.on('message', (data) => {
    const raw = data.toString();
    if (raw === 'o') {
      // Server-sent open frame — authenticate immediately
      const authMsg = `authorize\n0\n\n${tvAuth.accessToken}`;
      tvWs.send(authMsg);
      return;
    }
    if (raw === 'h') return; // heartbeat frame
    if (!raw.startsWith('a[')) return;

    let messages;
    try { messages = JSON.parse(raw.slice(1)); }
    catch(e) { return; }

    for (const msg of messages) {
      // Auth response
      if (msg.i === 0) {
        if (msg.s === 200) {
          console.log('[TV-WS] Authenticated ✓');
          tvWsReady = true;
          // Start heartbeat
          tvHeartbeat = setInterval(() => {
            if (tvWs && tvWs.readyState === WebSocket.OPEN) tvWs.send('[]');
          }, 2500);
          // Subscribe to user data
          tvWs.send(`user/syncrequest\n1\n\n${JSON.stringify({ accounts: [tvAuth.accountId] })}`);
        } else {
          console.error('[TV-WS] Auth failed:', msg);
        }
        continue;
      }

      // Resolve pending requests
      if (msg.i && tvPendingOrders[msg.i]) {
        const { resolve, reject } = tvPendingOrders[msg.i];
        delete tvPendingOrders[msg.i];
        if (msg.s === 200 || msg.s === 201) resolve(msg.d);
        else reject(new Error(`TV error ${msg.s}: ${JSON.stringify(msg.d)}`));
        continue;
      }

      // Real-time events
      if (msg.e === 'props' && msg.d) {
        handleTvProps(msg.d);
      }
    }
  });

  tvWs.on('close', (code) => {
    console.log(`[TV-WS] Closed (${code}) — reconnecting in 5s`);
    tvWsReady = false;
    if (tvHeartbeat) { clearInterval(tvHeartbeat); tvHeartbeat = null; }
    setTimeout(async () => {
      try { await tvEnsureAuth(); tvWsConnect(); }
      catch(e) { console.error('[TV-WS] Reconnect error:', e.message); }
    }, 5000);
  });

  tvWs.on('error', (e) => console.error('[TV-WS] Error:', e.message));
}

function handleTvProps(props) {
  // Live position updates
  if (props.position) {
    for (const pos of (Array.isArray(props.position) ? props.position : [props.position])) {
      if (pos.accountId === tvAuth.accountId) {
        state.tvPosition = pos;
        addLog(`Position update: ${pos.netPos} @ ${pos.prevPrice}`, 'info');
      }
    }
  }
  // Live cash balance / PnL
  if (props.cashBalance) {
    for (const cb of (Array.isArray(props.cashBalance) ? props.cashBalance : [props.cashBalance])) {
      if (cb.accountId === tvAuth.accountId) {
        state.tvBalance = cb;
      }
    }
  }
  // Fill confirmation
  if (props.fill) {
    for (const fill of (Array.isArray(props.fill) ? props.fill : [props.fill])) {
      addLog(`Fill: ${fill.action} ${fill.qty}@${fill.price} orderId=${fill.orderId}`, 'info');
      state.tvLastFill = fill;
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  TRADOVATE MARKET DATA WEBSOCKET — Tick data, DOM, Quotes
// ══════════════════════════════════════════════════════════════════════════

let mdWs      = null;
let mdWsReady = false;
let mdReqId   = 2;
let mdSubs    = {};   // subscriptionId → handler
let mdHeartbeat = null;

// Live tick accumulator (builds 1-min bars + delta)
const tickState = {
  barOpen:      null,
  barHigh:      null,
  barLow:       null,
  barClose:     null,
  barVolume:    0,
  barBuyVol:    0,
  barSellVol:   0,
  barDelta:     0,
  barStart:     null,
  sessionBuyVol:  0,
  sessionSellVol: 0,
  cumDelta:     0,
  vwapNum:      0,   // sum(tp * vol)
  vwapDen:      0,   // sum(vol)
  vwap:         null,
  atr:          4.0,
  ema9:         null,
  ema21:        null,
  prices:       [],  // last 50 closes for calculations
  atrHistory:   [],
  lastPrice:    null,
  lastBid:      null,
  lastAsk:      null,
  lastSize:     0,
  lastUpdate:   null,
  contractId:   null,
  chartSubId:   null,
  quoteSubId:   null,
  domSubId:     null,
  dom:          { bids: [], asks: [] },
};

function mdWsSend(endpoint, body) {
  if (!mdWs || !mdWsReady) return;
  const id  = mdReqId++;
  const msg = body
    ? `${endpoint}\n${id}\n\n${JSON.stringify(body)}`
    : `${endpoint}\n${id}\n\n`;
  mdWs.send(msg);
  return id;
}

function mdWsConnect() {
  if (mdWs) { try { mdWs.terminate(); } catch(e) {} }
  mdWsReady = false;

  console.log(`[MD-WS] Connecting to ${TV_MD_WS_URL}...`);
  mdWs = new WebSocket(TV_MD_WS_URL);

  mdWs.on('open', () => {
    console.log('[MD-WS] Connected');
  });

  mdWs.on('message', (data) => {
    const raw = data.toString();
    if (raw === 'o') {
      // Authenticate with mdAccessToken
      mdWs.send(`authorize\n0\n\n${tvAuth.mdAccessToken}`);
      return;
    }
    if (raw === 'h') return;
    if (!raw.startsWith('a[')) return;

    let messages;
    try { messages = JSON.parse(raw.slice(1)); }
    catch(e) { return; }

    for (const msg of messages) {
      if (msg.i === 0) {
        if (msg.s === 200) {
          console.log('[MD-WS] Authenticated ✓');
          mdWsReady = true;
          mdHeartbeat = setInterval(() => {
            if (mdWs && mdWs.readyState === WebSocket.OPEN) mdWs.send('[]');
          }, 2500);
          subscribeMarketData();
        }
        continue;
      }

      // Market data events
      if (msg.e === 'md' && msg.d) {
        handleMdEvent(msg.d);
      }
      if (msg.e === 'chart' && msg.d) {
        handleChartEvent(msg.d);
      }
    }
  });

  mdWs.on('close', (code) => {
    console.log(`[MD-WS] Closed (${code}) — reconnecting in 5s`);
    mdWsReady = false;
    if (mdHeartbeat) { clearInterval(mdHeartbeat); mdHeartbeat = null; }
    setTimeout(async () => {
      try { await tvEnsureAuth(); mdWsConnect(); }
      catch(e) { console.error('[MD-WS] Reconnect error:', e.message); }
    }, 5000);
  });

  mdWs.on('error', (e) => console.error('[MD-WS] Error:', e.message));
}

async function subscribeMarketData() {
  // Find ES contract ID
  try {
    const contracts = await tvRest('/contract/search?text=ES&live=true&productType=Future');
    const es = contracts && contracts.find(c => c.name && c.name.startsWith('ES') && !c.name.includes('MES'));
    if (es) {
      tickState.contractId = es.id;
      console.log(`[MD] ES contract: ${es.name} (id=${es.id})`);

      // Subscribe to real-time tick chart
      const chartBody = {
        symbol:           es.name,
        chartDescription: {
          underlyingType:   'Tick',
          elementSize:      1,
          elementSizeUnit:  'UnderlyingUnits',
        },
        timeRange: {
          asMuchAsElements: 1000,  // last 1000 ticks as history
        },
      };
      tickState.chartSubId = mdWsSend('md/getChart', chartBody);
      console.log(`[MD] Subscribed to tick chart (subId=${tickState.chartSubId})`);

      // Subscribe to quote (bid/ask/last)
      tickState.quoteSubId = mdWsSend('md/subscribeQuote', { symbol: es.name });
      console.log(`[MD] Subscribed to quote`);

      // Subscribe to DOM
      tickState.domSubId = mdWsSend('md/subscribeDOM', { symbol: es.name });
      console.log(`[MD] Subscribed to DOM`);
    } else {
      console.warn('[MD] ES contract not found — retrying in 30s');
      setTimeout(subscribeMarketData, 30_000);
    }
  } catch(e) {
    console.error('[MD] subscribeMarketData error:', e.message);
    setTimeout(subscribeMarketData, 30_000);
  }
}

function handleMdEvent(d) {
  // Quote update (bid/ask/last/size)
  if (d.quotes) {
    for (const q of d.quotes) {
      if (!q.entries) continue;
      const bid   = q.entries.Bid?.price;
      const ask   = q.entries.Offer?.price;
      const trade = q.entries.Trade;
      if (bid   !== undefined) tickState.lastBid   = bid;
      if (ask   !== undefined) tickState.lastAsk   = ask;
      if (trade?.price !== undefined) {
        const price = trade.price;
        const size  = trade.size || 1;
        tickState.lastPrice = price;
        tickState.lastSize  = size;
        tickState.lastUpdate = new Date().toISOString();
        processTick(price, size, bid, ask);
      }
    }
  }
  // DOM update
  if (d.dom) {
    for (const dom of d.dom) {
      if (dom.bids) tickState.dom.bids = dom.bids.slice(0, 10);
      if (dom.asks) tickState.dom.asks = dom.asks.slice(0, 10);
    }
    computeDomImbalance();
  }
}

function handleChartEvent(d) {
  // Tick chart data stream (historical + real-time)
  if (!d.charts) return;
  for (const packet of d.charts) {
    if (packet.eoh) { console.log('[MD] Tick history loaded ✓'); continue; }
    if (!packet.tks || !packet.bp) continue;
    const bp = packet.bp;
    const ts = packet.ts || 0.25;
    const bt = packet.bt;
    for (const tk of packet.tks) {
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

  // Side classification
  let side = 0;
  if (ask !== null && ask !== undefined && price >= ask) side = 1;   // Buy (hit ask)
  else if (bid !== null && bid !== undefined && price <= bid) side = -1; // Sell (hit bid)
  else {
    // Tick rule fallback
    if (tickState.lastPrice !== null) side = price > tickState.lastPrice ? 1 : price < tickState.lastPrice ? -1 : 0;
  }

  // Session delta
  tickState.sessionBuyVol  += side === 1  ? size : 0;
  tickState.sessionSellVol += side === -1 ? size : 0;
  tickState.cumDelta        = tickState.sessionBuyVol - tickState.sessionSellVol;

  // VWAP
  const tp = price; // For ticks, trade price is TP
  tickState.vwapNum += tp * size;
  tickState.vwapDen += size;
  tickState.vwap     = tickState.vwapDen > 0 ? tickState.vwapNum / tickState.vwapDen : price;

  // 1-min bar building
  const now  = Date.now();
  const minT = Math.floor(now / 60_000) * 60_000; // floor to minute
  if (tickState.barStart === null || minT > tickState.barStart) {
    // New bar
    if (tickState.barStart !== null) closeBar();
    tickState.barStart   = minT;
    tickState.barOpen    = price;
    tickState.barHigh    = price;
    tickState.barLow     = price;
    tickState.barClose   = price;
    tickState.barVolume  = size;
    tickState.barBuyVol  = side === 1  ? size : 0;
    tickState.barSellVol = side === -1 ? size : 0;
    tickState.barDelta   = tickState.barBuyVol - tickState.barSellVol;
  } else {
    if (price > tickState.barHigh) tickState.barHigh = price;
    if (price < tickState.barLow)  tickState.barLow  = price;
    tickState.barClose    = price;
    tickState.barVolume  += size;
    tickState.barBuyVol  += side === 1  ? size : 0;
    tickState.barSellVol += side === -1 ? size : 0;
    tickState.barDelta    = tickState.barBuyVol - tickState.barSellVol;
  }

  tickState.lastPrice = price;

  // Update EMA9
  if (tickState.ema9 === null) { tickState.ema9 = price; tickState.ema21 = price; }
  const k9  = 2 / 10;  const k21 = 2 / 22;
  tickState.ema9  = price * k9  + tickState.ema9  * (1 - k9);
  tickState.ema21 = price * k21 + tickState.ema21 * (1 - k21);

  // Update prices array for ATR
  tickState.prices.push(price);
  if (tickState.prices.length > 50) tickState.prices.shift();

  // Push to algo state
  updateAlgoFromTick();
}

function closeBar() {
  if (tickState.barClose === null) return;
  // ATR: TR of closed bar
  const prevClose = tickState.prices[tickState.prices.length - 2] || tickState.barClose;
  const tr = Math.max(
    tickState.barHigh - tickState.barLow,
    Math.abs(tickState.barHigh - prevClose),
    Math.abs(tickState.barLow  - prevClose)
  );
  tickState.atrHistory.push(tr);
  if (tickState.atrHistory.length > 14) tickState.atrHistory.shift();
  tickState.atr = tickState.atrHistory.reduce((a, b) => a + b, 0) / tickState.atrHistory.length;
  addLog(`Bar closed: O=${tickState.barOpen} H=${tickState.barHigh} L=${tickState.barLow} C=${tickState.barClose} Δ=${tickState.barDelta}`, 'info');
}

function computeDomImbalance() {
  const bids = tickState.dom.bids;
  const asks = tickState.dom.asks;
  if (!bids.length || !asks.length) return;
  const bidVol = bids.slice(0, 5).reduce((a, b) => a + (b.size || 0), 0);
  const askVol = asks.slice(0, 5).reduce((a, b) => a + (b.size || 0), 0);
  const total  = bidVol + askVol;
  state.rithmic.dom_imbalance = total > 0 ? (bidVol - askVol) / total : 0;
  state.rithmic.stacked_bids  = bids.slice(0, 3).every(b => (b.size || 0) > bidVol / 5);
  state.rithmic.stacked_asks  = asks.slice(0, 3).every(a => (a.size || 0) > askVol / 5);
}

function updateAlgoFromTick() {
  const ts = tickState;
  if (!ts.lastPrice) return;

  // Map tick data → rithmic-compatible state (keeps existing algo logic working)
  state.rithmic = {
    connected:         true,
    simulated:         false,
    price:             ts.lastPrice,
    bid:               ts.lastBid,
    ask:               ts.lastAsk,
    cumulative_delta:  ts.cumDelta,
    bar_delta:         ts.barDelta,
    vwap:              ts.vwap,
    vwap_upper1:       ts.vwap ? ts.vwap + ts.atr       : null,
    vwap_lower1:       ts.vwap ? ts.vwap - ts.atr       : null,
    vwap_upper2:       ts.vwap ? ts.vwap + ts.atr * 2   : null,
    vwap_lower2:       ts.vwap ? ts.vwap - ts.atr * 2   : null,
    price_vs_vwap:     ts.vwap ? (ts.lastPrice > ts.vwap ? 'above' : 'below') : 'unknown',
    atr_14:            ts.atr,
    ema_9:             ts.ema9,
    ema_21:            ts.ema21,
    ema_trend:         ts.ema9 && ts.ema21 ? (ts.ema9 > ts.ema21 ? 'bullish' : 'bearish') : 'unknown',
    session_buy_vol:   ts.sessionBuyVol,
    session_sell_vol:  ts.sessionSellVol,
    session_volume:    ts.sessionBuyVol + ts.sessionSellVol,
    buy_pct:           ts.sessionBuyVol + ts.sessionSellVol > 0
                         ? ts.sessionBuyVol / (ts.sessionBuyVol + ts.sessionSellVol) * 100 : 50,
    large_print_bias:  ts.cumDelta > 200 ? 'bullish' : ts.cumDelta < -200 ? 'bearish' : 'neutral',
    delta_divergence:  ts.cumDelta > 0 && ts.lastPrice < (ts.vwap || ts.lastPrice) ? 'bullish'
                     : ts.cumDelta < 0 && ts.lastPrice > (ts.vwap || ts.lastPrice) ? 'bearish' : 'neutral',
    absorption_signal: 'none',
    market_structure:  'unknown',
    dom_imbalance:     state.rithmic?.dom_imbalance || 0,
    stacked_bids:      state.rithmic?.stacked_bids  || false,
    stacked_asks:      state.rithmic?.stacked_asks  || false,
    poc:               ts.vwap, // approximate POC with VWAP
    lastUpdate:        ts.lastUpdate,
  };

  // Update price state
  if (!state.prices) state.prices = {};
  state.prices.ES = { price: ts.lastPrice };

  // Dynamic stops from ATR
  if (ts.atr > 0) {
    const gammaMultiplier = state.quant?.gamma_regime === 'negative_gamma' ? 1.8 : 1.5;
    risk.stopPts   = Math.max(2,  Math.round(ts.atr * gammaMultiplier  / 0.25) * 0.25);
    risk.targetPts = Math.max(4,  Math.round(ts.atr * gammaMultiplier * 2 / 0.25) * 0.25);
  }

  computeKelly();
  evaluateSignal();
  checkAutoTrade();
}

// ══════════════════════════════════════════════════════════════════════════
//  AUTO-TRADING ENGINE
// ══════════════════════════════════════════════════════════════════════════

let autoTrade        = false;  // master switch
let pendingOrderId   = null;   // open order waiting for fill
let activePosition   = null;   // currently held position

async function checkAutoTrade() {
  if (!autoTrade || risk.killSwitch) return;
  if (!tvWsReady || !tvAuth.accountId) return;
  if (activePosition) return; // already in trade
  if (pendingOrderId) return; // order pending

  const sig = state.signal;
  if (!sig) return;

  // All gates must pass
  const allPass = Object.values(state.gates).every(g => !g.on || g.pass);
  if (!allPass) return;

  try {
    await placeOrder(sig);
  } catch(e) {
    addLog(`AutoTrade order failed: ${e.message}`, 'error');
  }
}

async function placeOrder(sig) {
  if (!tvAuth.accountId) throw new Error('No account ID');
  await tvEnsureAuth();

  const cts = sig.contracts || risk.baseContracts || 1;

  // Find ES contract
  const contracts = await tvRest('/contract/search?text=ES&live=true&productType=Future');
  const es = contracts && contracts.find(c => c.name && c.name.startsWith('ES') && !c.name.includes('MES'));
  if (!es) throw new Error('ES contract not found');

  const action    = sig.direction === 'long' ? 'Buy' : 'Sell';
  const stopDist  = Math.round(sig.stopPts_actual || risk.stopPts);
  const tgtDist   = Math.round(sig.targetPts_actual || risk.targetPts);
  const stopPrice = sig.direction === 'long'
    ? sig.price - stopDist
    : sig.price + stopDist;
  const tgtPrice  = sig.direction === 'long'
    ? sig.price + tgtDist
    : sig.price - tgtDist;

  // Bracket order: Market + Stop-Loss + Take-Profit
  const orderBody = {
    accountSpec:     tvAuth.accountName,
    accountId:       tvAuth.accountId,
    action:          action,
    symbol:          es.name,
    orderQty:        cts,
    orderType:       'Market',
    isAutomated:     true,   // REQUIRED by CME regulations
    bracket1: {
      action:        action === 'Buy' ? 'Sell' : 'Buy',
      orderType:     'StopMarket',
      stopPrice:     stopPrice,
    },
    bracket2: {
      action:        action === 'Buy' ? 'Sell' : 'Buy',
      orderType:     'Limit',
      price:         tgtPrice,
    },
  };

  addLog(`Placing ${action} ${cts}x ${es.name} | Stop=${stopPrice} Target=${tgtPrice}`, 'info');

  const result = await tvRest('/order/placeOrder', 'POST', orderBody);
  pendingOrderId = result?.orderId;
  activePosition = {
    direction:  sig.direction,
    entry:      sig.price,
    stop:       stopPrice,
    target:     tgtPrice,
    contracts:  cts,
    orderId:    pendingOrderId,
    time:       new Date().toISOString(),
  };
  addLog(`Order placed ✓ orderId=${pendingOrderId} ${action} ${cts}x @market → Stop=${stopPrice} Target=${tgtPrice}`, 'info');
  return result;
}

async function cancelOrder(orderId) {
  if (!orderId) return;
  await tvEnsureAuth();
  await tvRest(`/order/cancelOrder`, 'POST', {
    accountSpec:  tvAuth.accountName,
    accountId:    tvAuth.accountId,
    orderId:      orderId,
    isAutomated:  true,
  });
  addLog(`Order ${orderId} cancelled`, 'warn');
}

async function closePosition() {
  if (!activePosition) return;
  await tvEnsureAuth();
  const contracts = await tvRest('/contract/search?text=ES&live=true&productType=Future');
  const es = contracts && contracts.find(c => c.name && c.name.startsWith('ES') && !c.name.includes('MES'));
  if (!es) return;

  const closeAction = activePosition.direction === 'long' ? 'Sell' : 'Buy';
  await tvRest('/order/placeOrder', 'POST', {
    accountSpec:  tvAuth.accountName,
    accountId:    tvAuth.accountId,
    action:       closeAction,
    symbol:       es.name,
    orderQty:     activePosition.contracts,
    orderType:    'Market',
    isAutomated:  true,
  });
  addLog(`Position closed: ${closeAction} ${activePosition.contracts}x market`, 'warn');
  activePosition   = null;
  pendingOrderId   = null;
}

// ══════════════════════════════════════════════════════════════════════════
//  ALPHA-BIAS AUTH (GEX / Macro / COT — unchanged)
// ══════════════════════════════════════════════════════════════════════════

const abAuth = { accessToken: '', refreshToken: '', expiresAt: 0 };

function decodeExp(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).exp || 0; }
  catch { return 0; }
}

async function abLogin() {
  console.log(`[AB] Logging in as ${AB_EMAIL}...`);
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method:  'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email: AB_EMAIL, password: AB_PASSWORD }),
  });
  if (!r.ok) throw new Error(`AB login failed ${r.status}: ${await r.text()}`);
  const d = await r.json();
  abAuth.accessToken  = d.access_token;
  abAuth.refreshToken = d.refresh_token;
  abAuth.expiresAt    = decodeExp(d.access_token);
  console.log('[AB] Login ✓');
}

async function abRefresh() {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method:  'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ refresh_token: abAuth.refreshToken }),
  });
  if (!r.ok) { await abLogin(); return; }
  const d = await r.json();
  abAuth.accessToken  = d.access_token;
  abAuth.refreshToken = d.refresh_token || abAuth.refreshToken;
  abAuth.expiresAt    = decodeExp(d.access_token);
}

async function abEnsureAuth() {
  if (!abAuth.accessToken)                          { await abLogin();   return; }
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
  macro:    null, gex: null, cot: null, session: null, prices: null,
  bias:     { score: 0, conf: 0, label: 'NEUTRAL' },
  gates:    {},
  signal:   null,
  kelly:    { fraction: 0.5, contracts: 1, reason: '—' },
  dependency: { streak: 0, multiplier: 1.0, trades: [] },
  pnl:      { today: 0, allTime: 0, trades: 0, wins: 0, peak: 0, trailingDD: 0, dailyLoss: 0 },
  trades:   [],
  log:      [],
  lastUpdate: null,
  newsBlackout: false,
  blackoutReason: '',
  rithmic:  { connected: false },  // populated by Tradovate tick data
  tvPosition: null,
  tvBalance:  null,
  tvLastFill: null,
  quant: {
    vrp: null, vrp_signal: 'neutral', iv_30d: null, rv_10d: null, vrp_zscore: null,
    gamma_imbalance: null, gamma_regime: 'neutral', gamma_theta_be: null, inelastic_demand: false,
    intraday_return: null, last30_return: null, momentum_signal: 'neutral', session_open: null,
    dex_net: null, dex_signal: 'neutral',
    ewma_variance: null, ewma_lambda: 0.94, var_95: null, var_99: null, returns_history: [],
    overnight_vol: null, intraday_vol: null, vol_regime: 'normal',
    macro_news_window: false, next_macro_event: null,
    quant_kelly: null, quant_confidence: 0, quant_regime: 'unknown',
  },
};

const risk = {
  baseContracts: 1, maxContracts: 3,
  stopPts: 4.0, targetPts: 8.0,
  partialPct: 0.25, partialAtPct: 0.50,
  useKelly: true, useDependency: true,
  killSwitch: false,
  maxDailyLoss: TOPSTEP.maxDailyLoss,
  trailingDD:   TOPSTEP.trailingDD,
  useVRP: true, useGammaFragility: true, useIntradayMom: true, useEWMAVaR: true,
  vrpThreshold: 0.02, gammaThreshold: 0.5,
};

const gatesCfg = {
  bias: true, regime: true, gammaFlip: true, gexWalls: true,
  news: true, dailyLoss: true, trailingDD: true, delta: true, vwap: true, dom: false,
  vrp: true, gammaFragility: true, intradayMom: false, ewmaVar: true,
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

// ══════════════════════════════════════════════════════════════════════════
//  QUANT MODELS (VRP, Gamma Fragility, EWMA VaR, etc.)
// ══════════════════════════════════════════════════════════════════════════

function computeVRP() {
  const q = state.quant; const vix = state.macro?.vix || 18;
  const iv = vix / 100; q.iv_30d = iv;
  let rv = iv * 0.85;
  if (q.returns_history.length >= 10) {
    const rets = q.returns_history.slice(-10);
    const mean = rets.reduce((a,b) => a+b, 0) / rets.length;
    rv = Math.sqrt(rets.reduce((a,r) => a + (r-mean)**2, 0) / rets.length * 252);
  }
  q.rv_10d = rv; q.vrp = iv**2 - rv**2;
  const vrp_mean = 0.0015, vrp_std = 0.002;
  q.vrp_zscore = (q.vrp - vrp_mean) / vrp_std;
  q.vrp_signal = q.vrp > risk.vrpThreshold && q.vrp_zscore > -1 ? 'short_vol'
               : q.vrp < 0 || q.vrp_zscore < -2 ? 'long_vol' : 'neutral';
}

function computeGammaFragility() {
  const q = state.quant; const spy = state.gex?.SPY || {};
  const netGex = spy.net_gex || 0; q.gamma_imbalance = netGex;
  const ep = state.prices?.ES?.price;
  q.gamma_theta_be = ep ? ep * 0.005 : 26;
  const flipDist = spy.gamma_flip && ep ? Math.abs(ep - spy.gamma_flip) : 10;
  q.inelastic_demand = flipDist < q.gamma_theta_be;
  q.gamma_regime = netGex < -risk.gammaThreshold ? 'negative_gamma'
                 : netGex > risk.gammaThreshold ? 'positive_gamma' : 'neutral';
}

function computeIntradayMomentum() {
  const q = state.quant; const now = new Date();
  const etHour = (now.getUTCHours() - 4 + 24) % 24;
  const etMin  = now.getUTCMinutes();
  const ep = state.prices?.ES?.price;
  if (!ep) { q.momentum_signal = 'neutral'; return; }
  if (etHour === 9 && etMin === 30) q.session_open = ep;
  if (!q.session_open) q.session_open = ep;
  q.intraday_return = (ep - q.session_open) / q.session_open;
  const inLast30 = etHour === 15 && etMin >= 30;
  if (inLast30 && Math.abs(q.intraday_return) > 0.002) {
    q.momentum_signal = q.intraday_return > 0 ? 'long' : 'short';
  } else if (q.intraday_return > 0.005) q.momentum_signal = 'long';
  else if (q.intraday_return < -0.005) q.momentum_signal = 'short';
  else q.momentum_signal = 'neutral';
}

function computeDEX() {
  const q = state.quant; const spy = state.gex?.SPY || {};
  const netDex = spy.net_dex || 0; q.dex_net = netDex;
  q.dex_signal = netDex > 0 ? 'bearish_pressure' : netDex < 0 ? 'bullish_pressure' : 'neutral';
}

function computeEWMAVaR() {
  const q = state.quant; const λ = q.ewma_lambda;
  if (q.returns_history.length > 0) {
    const lr = q.returns_history[q.returns_history.length - 1];
    q.ewma_variance = q.ewma_variance === null ? lr**2 : λ * q.ewma_variance + (1-λ) * lr**2;
    const vol = Math.sqrt(q.ewma_variance);
    q.var_95 = 1.645 * vol; q.var_99 = 2.326 * vol;
  } else {
    const dv = (state.macro?.vix || 18) / 100 / Math.sqrt(252);
    q.ewma_variance = dv**2; q.var_95 = 1.645 * dv; q.var_99 = 2.326 * dv;
  }
}

function computeOvernightVol() {
  const q = state.quant; const sess = state.session || {};
  q.overnight_vol = Math.abs((sess.asia?.nikkeiChg || 0) / 100);
  q.intraday_vol  = state.rithmic?.atr_14 > 0 ? state.rithmic.atr_14 / (state.prices?.ES?.price || 5300) : (state.macro?.vix || 18) / 100 / Math.sqrt(252) * 2;
  q.vol_regime    = q.overnight_vol > 0.008 ? 'overnight_stressed' : q.intraday_vol > 0.006 ? 'intraday_stressed' : 'normal';
}

function checkMacroNewsWindow() {
  const q = state.quant; const now = Date.now();
  const b4 = 30*60*1000, after = 60*60*1000;
  q.macro_news_window = false;
  for (const ev of NEWS_EVENTS) {
    const et = new Date(ev).getTime();
    if (now >= et - b4 && now <= et + after) {
      q.macro_news_window = true; state.newsBlackout = true;
      state.blackoutReason = `Macro news window: ${ev}`; return;
    }
  }
  const vix = state.macro?.vix || 18;
  if (vix > 30) { q.macro_news_window = true; state.newsBlackout = true; state.blackoutReason = `VIX=${vix.toFixed(1)} > 30`; }
  else { state.newsBlackout = false; state.blackoutReason = ''; }
}

function computeQuantRegime() {
  const q = state.quant; const b = state.bias;
  let conf = 0, factors = 0;
  if (q.vrp !== null) { conf += (q.vrp_signal === 'short_vol' && b.score > 0) || (q.vrp_signal === 'long_vol' && b.score < 0) ? 0.8 : q.vrp_signal === 'neutral' ? 0.5 : 0.2; factors++; }
  if (q.gamma_regime !== 'neutral') { conf += 0.7; factors++; }
  if (q.dex_signal !== 'neutral') { conf += ((q.dex_signal === 'bullish_pressure' && b.score > 0) || (q.dex_signal === 'bearish_pressure' && b.score < 0)) ? 0.7 : 0.3; factors++; }
  if (q.momentum_signal !== 'neutral') { conf += ((q.momentum_signal === 'long' && b.score > 0) || (q.momentum_signal === 'short' && b.score < 0)) ? 0.65 : 0.35; factors++; }
  q.quant_confidence = factors > 0 ? conf / factors : 0.5;
  const nv = (state.macro?.vix || 18) / 100;
  const varAdj = q.var_95 ? Math.min(1, 0.013 / Math.max(q.var_95, 0.013)) : 1;
  const vrpK   = q.vrp_signal === 'short_vol' ? 1.0 : q.vrp_signal === 'neutral' ? 0.8 : 0.5;
  q.quant_kelly = varAdj * vrpK * q.quant_confidence;
  if (q.vol_regime === 'overnight_stressed') q.quant_regime = 'OVERNIGHT_STRESS';
  else if (q.gamma_regime === 'negative_gamma') q.quant_regime = 'GAMMA_MOMENTUM';
  else if (q.gamma_regime === 'positive_gamma') q.quant_regime = 'GAMMA_REVERSAL';
  else if (q.vrp_signal === 'long_vol') q.quant_regime = 'VOL_STRESS';
  else if (q.quant_confidence > 0.7) q.quant_regime = 'HIGH_CONFIDENCE';
  else if (q.quant_confidence < 0.4) q.quant_regime = 'LOW_CONFIDENCE';
  else q.quant_regime = 'NORMAL';
}

// ══════════════════════════════════════════════════════════════════════════
//  BIAS + KELLY + GATES + SIGNAL (unchanged logic)
// ══════════════════════════════════════════════════════════════════════════

function computeBias() {
  let score = 0; const conf = [];
  const spy = state.gex?.SPY || {}; const macro = state.macro || {};
  const cot = state.cot || {}; const sess = state.session || {};
  const ep = state.prices?.ES?.price; const regime = state.gex?.sessionRegime || 'MIXED';
  const q = state.quant;
  if (Object.keys(spy).length) {
    const above = ep != null && spy.gamma_flip != null ? ep > spy.gamma_flip : null;
    const rs = { 'MEAN REVERSION': spy.net_gex_label === 'positive' ? 0.1 : -0.1, 'TRENDING': above === true ? 0.6 : above === false ? -0.6 : 0, 'HIGH VOL': -0.3, 'CAUTION': -0.4, 'MIXED': 0 };
    score += (rs[regime] ?? 0) * 0.35; conf.push(regime !== 'MIXED' ? 0.85 : 0.4);
  }
  if (cot.ES) {
    const lf = cot.ES.leveragedFunds || {}, ss = cot.ES.smallSpec || {};
    score += ((lf.index || 50) - 50) / 50 * 0.25;
    if ((ss.index || 50) > 80) score -= 0.08;
    if ((ss.index || 50) < 20) score += 0.08;
    conf.push(0.7);
  }
  if (macro.macroRegime4) {
    const ms = { GOLDILOCKS: 0.7, REFLATION: 0.3, DEFLATION: -0.3, STAGFLATION: -0.8 }[macro.macroRegime4] || 0;
    const vix = macro.vix || 15;
    score += ms * (vix > 30 ? 0.3 : vix > 25 ? 0.5 : vix > 20 ? 0.75 : 1.0) * 0.18;
    conf.push(0.7);
  }
  const a = sess.asia?.bias, l = sess.london?.bias;
  if (a || l) {
    score += (a === 'bullish' && l === 'bullish' ? 0.5 : a === 'bearish' && l === 'bearish' ? -0.5 : (a === 'bullish' || l === 'bullish') ? 0.2 : 0) * 0.10;
    conf.push(0.5);
  }
  if (q.vrp !== null) { score += (q.vrp_signal === 'short_vol' ? 0.15 : q.vrp_signal === 'long_vol' ? -0.30 : 0) * 0.07; conf.push(0.6); }
  if (q.gamma_regime !== 'neutral') { if (q.inelastic_demand) score *= 1.1; conf.push(0.55); }
  score = Math.max(-1, Math.min(1, score));
  const c = conf.length ? conf.reduce((a,b) => a+b, 0) / conf.length : 0;
  state.bias = { score: +score.toFixed(3), conf: +c.toFixed(3), label: score > 0.5 ? 'STRONG BULL' : score > 0.15 ? 'BULL' : score < -0.5 ? 'STRONG BEAR' : score < -0.15 ? 'BEAR' : 'NEUTRAL' };
}

function computeKelly() {
  const b = state.bias, pnl = state.pnl, dep = state.dependency, q = state.quant;
  const vix = state.macro?.vix || 15;
  const pWin = Math.min(0.7, Math.max(0.3, 0.5 + b.conf * 0.2));
  const rr = risk.targetPts / risk.stopPts;
  const kelly = Math.max(0, Math.min(1, (pWin * rr - (1-pWin)) / rr));
  const halfK = kelly * 0.5;
  const vixAdj   = vix > 30 ? 0.3 : vix > 25 ? 0.5 : vix > 20 ? 0.75 : 1.0;
  const ddPct    = risk.trailingDD > 0 ? pnl.trailingDD / risk.trailingDD : 0;
  const ddAdj    = ddPct > 0.75 ? 0.25 : ddPct > 0.5 ? 0.5 : ddPct > 0.25 ? 0.75 : 1.0;
  const streak   = dep.streak;
  const strMult  = streak >= 3 ? 1.5 : streak >= 2 ? 1.25 : streak <= -3 ? 0.25 : streak <= -2 ? 0.5 : 1.0;
  const varAdj   = q.quant_kelly !== null ? Math.max(0.3, Math.min(1.2, q.quant_kelly)) : 1.0;
  const gammaAdj = q.gamma_regime === 'negative_gamma' && q.inelastic_demand ? 1.15 : 1.0;
  const volAdj   = q.vol_regime === 'overnight_stressed' ? 0.6 : q.vol_regime === 'intraday_stressed' ? 0.8 : 1.0;
  const final    = Math.max(0.1, Math.min(1, halfK * vixAdj * ddAdj * strMult * varAdj * gammaAdj * volAdj));
  const cts      = Math.max(1, Math.min(risk.maxContracts, Math.round(risk.baseContracts * final / 0.5)));
  state.kelly    = { fraction: +final.toFixed(3), contracts: cts, kellyFull: +kelly.toFixed(3), pWin: +pWin.toFixed(3), vixAdj, ddAdj, streakMult: strMult, varAdj: +varAdj.toFixed(3), gammaAdj: +gammaAdj.toFixed(3), volAdj: +volAdj.toFixed(3), reason: `Kelly=${final.toFixed(2)} VIX→${vixAdj} DD→${ddAdj} Str→${strMult} VaR→${varAdj.toFixed(2)} Gamma→${gammaAdj.toFixed(2)}` };
}

function evaluateSignal() {
  const b = state.bias, spy = state.gex?.SPY || {}, ep = state.prices?.ES?.price;
  const regime = state.gex?.sessionRegime || '', pnl = state.pnl, kelly = state.kelly, q = state.quant;
  const gates = {};
  const gate = (k, name, passed, val = null) => {
    const on = gatesCfg[k] !== undefined ? gatesCfg[k] : true;
    gates[k] = { on, pass: !on || !!passed, val: val || '—', name };
  };
  gate('bias',      'Bias Confirmation',  b.label !== 'NEUTRAL' && b.conf >= 0.4, `${b.score >= 0 ? '+' : ''}${b.score}`);
  gate('regime',    'GEX Regime',         ['TRENDING','MEAN REVERSION'].includes(regime), regime || '—');
  const flip = spy.gamma_flip, cw = spy.call_wall, pw = spy.put_wall;
  if (flip != null && ep != null) { const d = Math.abs(ep-flip); gate('gammaFlip','Gamma Flip Dist', d >= 5, `${d.toFixed(1)}pts`); } else gate('gammaFlip','Gamma Flip Dist',true,'N/A');
  if (cw != null && ep != null) { const dc = Math.abs(ep-cw), dp = pw != null ? Math.abs(ep-pw) : 999; gate('gexWalls','GEX Wall Dist', dc >= 8 && dp >= 8, `CW:${dc.toFixed(0)} PW:${dp.toFixed(0)}`); } else gate('gexWalls','GEX Wall Dist',true,'N/A');
  gate('news',      'News Blackout',      !state.newsBlackout, state.newsBlackout ? state.blackoutReason : 'Clear');
  gate('dailyLoss', 'Daily Loss Limit',   pnl.dailyLoss < risk.maxDailyLoss, `-$${pnl.dailyLoss.toFixed(0)} / $${risk.maxDailyLoss}`);
  gate('trailingDD','Trailing Drawdown',  pnl.trailingDD < risk.trailingDD, `-$${pnl.trailingDD.toFixed(0)} / $${risk.trailingDD}`);
  const rth = state.rithmic, rConn = rth.connected;
  const deltaOk = !rConn || (b.label.includes('BULL') ? rth.cumulative_delta > 200 : b.label.includes('BEAR') ? rth.cumulative_delta < -200 : true);
  gate('delta','Cumul. Delta', deltaOk, rConn ? `${rth.cumulative_delta > 0 ? '+' : ''}${(rth.cumulative_delta||0).toFixed(0)}` : 'TV offline');
  const vwapOk = !rConn || !rth.vwap || (ep >= rth.vwap_lower2 && ep <= rth.vwap_upper2);
  gate('vwap','VWAP Band', vwapOk, rConn && rth.vwap ? `${rth.price_vs_vwap} VWAP=${rth.vwap.toFixed(2)}` : 'TV offline');
  const domOk = !rConn || !gatesCfg.dom || (b.label.includes('BULL') ? rth.dom_imbalance > 0.1 : b.label.includes('BEAR') ? rth.dom_imbalance < -0.1 : true);
  gate('dom','DOM Imbalance', domOk, rConn ? `${((rth.dom_imbalance||0)*100).toFixed(1)}%` : 'TV offline');
  const vrpOk = !gatesCfg.vrp || !(q.vrp_signal === 'long_vol' && b.score > 0) || q.quant_confidence > 0.7;
  gate('vrp','VRP Regime', vrpOk, `VRP=${q.vrp ? (q.vrp*100).toFixed(2)+'%' : '—'} (${q.vrp_signal})`);
  gate('gammaFragility','Gamma Fragility', !gatesCfg.gammaFragility || q.gamma_regime === 'neutral' || true,
    `${q.gamma_regime} GEX=${q.gamma_imbalance ? q.gamma_imbalance.toFixed(2)+'B' : '—'}`);
  const momOk = !gatesCfg.intradayMom || q.momentum_signal === 'neutral' || (q.momentum_signal === 'long' && b.score > 0) || (q.momentum_signal === 'short' && b.score < 0);
  gate('intradayMom','Intraday Momentum', momOk, `${q.momentum_signal}`);
  gate('ewmaVar','EWMA VaR', !gatesCfg.ewmaVar || !q.var_95 || q.var_95 < 0.025, `VaR95=${q.var_95 ? (q.var_95*100).toFixed(2)+'%' : '—'}`);
  state.gates = gates;
  if (risk.killSwitch || ep == null) { state.signal = null; return; }
  const allPass = Object.values(gates).every(g => !g.on || g.pass);
  if (!allPass || b.label === 'NEUTRAL') { state.signal = null; return; }
  const dir = b.score > 0 ? 'long' : 'short';
  const cts = risk.useKelly ? kelly.contracts : risk.baseContracts;
  const slPts = risk.stopPts, tgtPts = risk.targetPts;
  const sl = Math.round((dir === 'long' ? ep-slPts : ep+slPts) / 0.25) * 0.25;
  const wall = dir === 'long' ? cw : pw;
  let tp = Math.round((dir === 'long' ? ep+tgtPts : ep-tgtPts) / 0.25) * 0.25;
  let finalTgtPts = tgtPts;
  if (wall != null && Math.abs(wall-ep) > slPts*1.5) { tp = wall; finalTgtPts = Math.abs(wall-ep); }
  const pWin = kelly.pWin * (1 + (q.quant_confidence - 0.5) * 0.2);
  const ev   = +((pWin * finalTgtPts*50*cts) - ((1-pWin) * slPts*50*cts)).toFixed(2);
  state.signal = {
    direction: dir, price: ep, stopLoss: sl, takeProfit: tp,
    contracts: cts, rr: +(finalTgtPts/slPts).toFixed(2), evUsd: ev,
    stopPts_actual: slPts, targetPts_actual: finalTgtPts,
    confidence: b.conf, kellyFraction: kelly.fraction,
    gexRegime: regime, gammaFlip: flip, callWall: cw, putWall: pw,
    quantRegime: q.quant_regime, vrpSignal: q.vrp_signal, gammaRegime: q.gamma_regime,
    quantConf: +q.quant_confidence.toFixed(3),
    reason: `${dir.toUpperCase()} | ${b.label} | ${regime} | ${q.quant_regime} | conf=${(b.conf*100).toFixed(0)}% | ${cts}ct | EV=$${ev} | ${kelly.reason}`,
    timestamp: new Date().toISOString(),
  };
  addLog(`✅ ${state.signal.reason}`);
}

// ══════════════════════════════════════════════════════════════════════════
//  TRADE RECORDING
// ══════════════════════════════════════════════════════════════════════════

function recordTrade({ direction, entry, exit, contracts, conf = 0, regime = '—' }) {
  entry = parseFloat(entry); exit = parseFloat(exit); contracts = parseInt(contracts) || 1;
  const pts = direction === 'long' ? exit - entry : entry - exit;
  const pnlUsd = pts * 50 * contracts;
  const win = pnlUsd > 0;
  const p = state.pnl, q = state.quant;
  p.allTime += pnlUsd; p.trades += 1; if (win) p.wins += 1;
  if (pnlUsd < 0) p.dailyLoss += Math.abs(pnlUsd);
  if (p.allTime > p.peak) p.peak = p.allTime;
  p.trailingDD = Math.max(0, p.peak - p.allTime); p.today = p.allTime;
  const ret = pts / (entry || 5300);
  q.returns_history.push(ret); if (q.returns_history.length > 60) q.returns_history.shift();
  const dep = state.dependency;
  dep.trades.push(win ? 1 : -1); if (dep.trades.length > 20) dep.trades.shift();
  let streak = 0;
  for (let i = dep.trades.length-1; i >= 0; i--) { if ((win && dep.trades[i]===1) || (!win && dep.trades[i]===-1)) streak += dep.trades[i]; else break; }
  dep.streak = streak;
  state.trades.unshift({ time: new Date().toISOString().split('T')[1].slice(0,8), direction, entry, exit, contracts, pnl: +pnlUsd.toFixed(2), pts: +pts.toFixed(2), conf, regime, win, quantRegime: q.quant_regime, vrpSignal: q.vrp_signal, gammaRegime: q.gamma_regime });
  if (state.trades.length > 100) state.trades.pop();
  addLog(`Trade: ${direction.toUpperCase()} ${pts >= 0 ? '+' : ''}${pts.toFixed(2)}pts = $${pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(0)} | Streak=${streak >= 0 ? '+' : ''}${streak}`, win ? 'info' : 'warn');
  if (p.dailyLoss >= TOPSTEP.maxDailyLoss) { risk.killSwitch = true; addLog('KILL SWITCH: Daily loss limit','error'); }
  if (p.trailingDD >= TOPSTEP.trailingDD)  { risk.killSwitch = true; addLog('KILL SWITCH: Trailing DD','error'); }
  // Clear active position
  activePosition = null; pendingOrderId = null;
  computeKelly(); evaluateSignal();
}

// ══════════════════════════════════════════════════════════════════════════
//  ALPHA-BIAS POLLING (GEX / Macro / COT / Session)
// ══════════════════════════════════════════════════════════════════════════

async function fetchAlphaBias() {
  addLog('Fetching Alpha-Bias data...');
  const keys  = ['gex','macro','cot','session','prices'];
  const paths = ['/api/gex','/api/macro','/api/cot','/api/session','/api/prices'];
  const results = await Promise.allSettled(paths.map(p => abGet(p)));
  results.forEach((res, i) => {
    if (res.status === 'fulfilled' && res.value) { state[keys[i]] = res.value; addLog(`${keys[i]} ✓`); }
    else addLog(`${keys[i]} failed`, 'warn');
  });
  checkMacroNewsWindow();
  computeVRP(); computeGammaFragility(); computeIntradayMomentum();
  computeDEX(); computeEWMAVaR(); computeOvernightVol(); computeQuantRegime();
  computeBias(); computeKelly(); evaluateSignal();
  state.lastUpdate = new Date().toISOString();
}

// ══════════════════════════════════════════════════════════════════════════
//  EXPRESS API ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════

app.get('/health', (req, res) => res.json({
  ok: true, tvConnected: tvWsReady, mdConnected: mdWsReady,
  loggedIn: !!tvAuth.accessToken, lastUpdate: state.lastUpdate,
  signal: state.signal?.direction || 'none', bias: state.bias.label,
  quantRegime: state.quant.quant_regime, autoTrade,
  account: tvAuth.accountName, demo: TV_DEMO,
}));

app.get('/algo/state', (req, res) => res.json({
  bias: state.bias, signal: state.signal, gates: state.gates,
  kelly: state.kelly, dependency: state.dependency,
  gex: state.gex, macro: state.macro, cot: state.cot,
  session: state.session, prices: state.prices,
  rithmic: state.rithmic,   // now populated by Tradovate
  pnl: state.pnl, trades: state.trades.slice(0,50),
  log: state.log.slice(0,40), risk, topstep: TOPSTEP,
  newsBlackout: state.newsBlackout, blackoutReason: state.blackoutReason,
  quant: state.quant, lastUpdate: state.lastUpdate,
  tvConnected: tvWsReady, mdConnected: mdWsReady, autoTrade,
  tvPosition: state.tvPosition, tvBalance: state.tvBalance,
}));

app.post('/algo/risk', (req, res) => {
  Object.entries(req.body).forEach(([k,v]) => { if (k in risk) risk[k] = v; });
  computeKelly(); evaluateSignal();
  addLog(`Risk updated: ${JSON.stringify(req.body)}`);
  res.json({ ok: true, risk });
});

app.post('/algo/gates', (req, res) => {
  Object.entries(req.body).forEach(([k,v]) => { if (k in gatesCfg) gatesCfg[k] = !!v; });
  evaluateSignal();
  res.json({ ok: true, gates: gatesCfg });
});

app.post('/algo/kill', (req, res) => {
  risk.killSwitch = !!req.body.active;
  if (risk.killSwitch && activePosition) {
    closePosition().catch(e => addLog(`Kill switch close error: ${e.message}`, 'error'));
  }
  addLog(`Kill switch: ${risk.killSwitch ? 'ON ⛔' : 'OFF ✓'}`, risk.killSwitch ? 'warn' : 'info');
  evaluateSignal();
  res.json({ ok: true, killSwitch: risk.killSwitch });
});

app.post('/algo/trade', (req, res) => {
  try { recordTrade(req.body); res.json({ ok: true, pnl: state.pnl }); }
  catch(e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/algo/refresh', async (req, res) => {
  try { await fetchAlphaBias(); res.json({ ok: true, lastUpdate: state.lastUpdate }); }
  catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/algo/news', (req, res) => {
  if (req.body.add)    { NEWS_EVENTS.push(req.body.add); addLog(`News event added: ${req.body.add}`); }
  if (req.body.remove) { const i=NEWS_EVENTS.indexOf(req.body.remove); if(i>-1) NEWS_EVENTS.splice(i,1); }
  checkMacroNewsWindow();
  res.json({ ok: true, events: NEWS_EVENTS });
});

// ── Tradovate-specific endpoints ──────────────────────────────────────────

// Toggle auto-trading on/off
app.post('/algo/autotrade', (req, res) => {
  autoTrade = !!req.body.active;
  addLog(`AutoTrade: ${autoTrade ? 'ENABLED ✅' : 'DISABLED ⛔'}`, autoTrade ? 'info' : 'warn');
  res.json({ ok: true, autoTrade });
});

// Manually place order (from dashboard signal)
app.post('/algo/order', async (req, res) => {
  try {
    const sig = req.body.signal || state.signal;
    if (!sig) return res.status(400).json({ ok: false, error: 'No signal available' });
    const result = await placeOrder(sig);
    res.json({ ok: true, result, orderId: pendingOrderId });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Cancel open order
app.post('/algo/cancel', async (req, res) => {
  try {
    const id = req.body.orderId || pendingOrderId;
    await cancelOrder(id);
    pendingOrderId = null;
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Close position
app.post('/algo/close', async (req, res) => {
  try {
    await closePosition();
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get Tradovate account info
app.get('/algo/account', async (req, res) => {
  try {
    const [accounts, positions, orders] = await Promise.all([
      tvRest('/account/list'),
      tvRest('/position/find?name=ES'),
      tvRest('/order/list'),
    ]);
    res.json({ ok: true, accounts, positions, orders });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Legacy rithmic endpoint (still supported for manual bridge if needed)
app.post('/algo/rithmic', (req, res) => {
  const d = req.body;
  if (d.price && d.price > 0 && !tickState.lastPrice) {
    // Only use if Tradovate WS not connected yet
    Object.assign(state.rithmic, d);
    state.rithmic.connected  = d.connected || false;
    state.rithmic.lastUpdate = new Date().toISOString();
    if (!state.prices) state.prices = {};
    state.prices.ES = { price: d.price };
    computeKelly(); evaluateSignal();
  }
  res.json({ ok: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'es_algo_dashboard.html')));

// ══════════════════════════════════════════════════════════════════════════
//  STARTUP
// ══════════════════════════════════════════════════════════════════════════

async function start() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  ES Algo v5 — Tradovate Edition                      ║');
  console.log('║  Automated Order Execution + Tick Data               ║');
  console.log(`║  Mode: ${TV_DEMO ? 'DEMO' : 'LIVE'} | Port: ${PORT}                              ║`);
  console.log('╚══════════════════════════════════════════════════════╝');

  // 1. Login to Tradovate
  try {
    await tvLogin();
  } catch(e) {
    console.error('[TV] Login error:', e.message);
    console.error('[TV] Check TRADOVATE_NAME / TRADOVATE_PASS env vars');
  }

  // 2. Connect trading WebSocket
  if (tvAuth.accessToken) {
    tvWsConnect();
    // Give WS time to connect then start MD
    setTimeout(() => {
      if (tvAuth.mdAccessToken) mdWsConnect();
    }, 3000);
  }

  // 3. Login to Alpha-Bias and start polling
  try {
    await abLogin();
    await fetchAlphaBias();
  } catch(e) {
    console.error('[AB] Error:', e.message);
  }

  // 4. Alpha-Bias polling every 60 seconds
  setInterval(async () => {
    try { await fetchAlphaBias(); }
    catch(e) { addLog(`Alpha-Bias poll error: ${e.message}`, 'warn'); }
  }, 60_000);

  // 5. Token refresh every 80 min
  setInterval(async () => {
    try { await tvLogin(); }
    catch(e) { addLog(`TV token refresh error: ${e.message}`, 'warn'); }
  }, 80 * 60_000);

  // 6. Daily reset at midnight UTC
  setInterval(() => {
    const now = new Date();
    if (now.getUTCHours() === 0 && now.getUTCMinutes() === 0) {
      state.pnl.dailyLoss = 0;
      state.quant.session_open = null;
      tickState.sessionBuyVol  = 0;
      tickState.sessionSellVol = 0;
      tickState.cumDelta       = 0;
      tickState.vwapNum        = 0;
      tickState.vwapDen        = 0;
      tickState.vwap           = null;
      if (risk.killSwitch && state.pnl.trailingDD < TOPSTEP.trailingDD) risk.killSwitch = false;
      addLog('Daily reset — session cleared');
    }
  }, 60_000);
}

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  start().catch(e => console.error('Startup error:', e.message));
});
