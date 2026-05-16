"""
ES Algo — Vollständige Version mit integriertem Web-Dashboard
Einzige Datei für Railway Deployment
"""

import asyncio
import base64
import json
import logging
import math
import os
import time
from datetime import datetime, timedelta
from typing import Optional
import aiohttp
from dotenv import load_dotenv
from flask import Flask, render_template_string, jsonify, request
from flask_cors import CORS

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("algo")

# ========== FLASK APP ==========
app = Flask(__name__)
CORS(app)

# ========== CONFIG ==========
ALPHA_BIAS_URL    = os.getenv("ALPHA_BIAS_URL",    "https://alpha-bias.com")
EMAIL             = os.getenv("ALPHA_BIAS_EMAIL",   "")
PASSWORD          = os.getenv("ALPHA_BIAS_PASSWORD","")
PORT              = int(os.getenv("PORT", 8080))
SUPABASE_URL      = "https://svnmcthtxppbahwimzjx.supabase.co"
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")

TOPSTEP = {
    "account_size":      50_000,
    "max_daily_loss":    1_000,
    "trailing_dd_limit": 2_000,
    "profit_target":     3_000,
    "max_contracts":     5,
}

NEWS_EVENTS = []

# ========== AUTH ==========
auth = {"access_token": "", "refresh_token": "", "expires_at": 0.0}

def decode_exp(token):
    try:
        p = token.split(".")[1]
        p += "=" * (4 - len(p) % 4)
        return float(json.loads(base64.b64decode(p)).get("exp", 0))
    except:
        return 0.0

async def login():
    logger.info(f"Logging in as {EMAIL}...")
    async with aiohttp.ClientSession() as s:
        async with s.post(f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
            json={"email": EMAIL, "password": PASSWORD},
            headers={"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"},
            timeout=aiohttp.ClientTimeout(total=15)) as r:
            if r.status != 200:
                raise Exception(f"Login failed {r.status}: {await r.text()}")
            d = await r.json()
            auth["access_token"] = d["access_token"]
            auth["refresh_token"] = d["refresh_token"]
            auth["expires_at"] = decode_exp(d["access_token"])
            logger.info(f"Login ✓ — token valid {int((auth['expires_at']-time.time())//60)} min")

async def do_refresh():
    async with aiohttp.ClientSession() as s:
        async with s.post(f"{SUPABASE_URL}/auth/v1/token?grant_type=refresh_token",
            json={"refresh_token": auth["refresh_token"]},
            headers={"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"},
            timeout=aiohttp.ClientTimeout(total=15)) as r:
            if r.status != 200:
                await login()
                return
            d = await r.json()
            auth["access_token"] = d["access_token"]
            auth["refresh_token"] = d.get("refresh_token", auth["refresh_token"])
            auth["expires_at"] = decode_exp(d["access_token"])
            logger.info("Token refreshed ✓")

async def ensure_auth():
    if not auth["access_token"]:
        await login()
        return
    if time.time() >= auth["expires_at"] - 300:
        try:
            await do_refresh()
        except:
            await login()

def hdrs():
    return {"Authorization": f"Bearer {auth['access_token']}"}

# ========== STATE ==========
state = {
    "macro": None, "gex": None, "cot": None, "session": None, "prices": None,
    "bias": {"score": 0.0, "conf": 0.0, "label": "NEUTRAL"},
    "gates": {}, "signal": None,
    "kelly": {"fraction": 0.5, "contracts": 1, "reason": "--"},
    "dependency": {"streak": 0, "multiplier": 1.0, "trades": []},
    "pnl": {
        "today": 0.0, "trades": 0, "wins": 0, "peak": 0.0,
        "all_time": 0.0, "trailing_dd": 0.0, "daily_loss": 0.0,
    },
    "trades": [], "log": [], "last_update": None,
    "news_blackout": False, "blackout_reason": "",
}

risk = {
    "base_contracts": 1, "max_contracts": 3, "stop_pts": 4.0, "target_pts": 8.0,
    "partial_pct": 0.25, "partial_at_pct": 0.50, "use_kelly": True, "use_dependency": True,
    "use_news_filter": True, "kill_switch": False, "max_daily_loss": TOPSTEP["max_daily_loss"],
    "trailing_dd": TOPSTEP["trailing_dd_limit"],
}

gates_cfg = {
    "bias": True, "regime": True, "gamma_flip": True, "gex_walls": True,
    "news": True, "daily_loss": True, "trailing_dd": True,
    "delta": True, "vwap": True, "dom": False,
}

def log(msg, level="info"):
    now = datetime.now()
    state["log"].insert(0, {"ts": now.strftime("%H:%M:%S"), "msg": msg, "level": level})
    if len(state["log"]) > 150:
        state["log"].pop()
    if level == "info":
        logger.info(msg)
    elif level == "warn":
        logger.warning(msg)
    else:
        logger.error(msg)

# ========== FETCH ==========
async def get(path):
    await ensure_auth()
    async with aiohttp.ClientSession() as s:
        async with s.get(ALPHA_BIAS_URL + path, headers=hdrs(),
                         timeout=aiohttp.ClientTimeout(total=12)) as r:
            if r.status == 401:
                await login()
                return None
            return await r.json() if r.ok else None

def check_news_blackout():
    """Block trading 30 minutes before and after high-impact news."""
    now = datetime.now()
    buffer = timedelta(minutes=30)
    state["news_blackout"] = False
    state["blackout_reason"] = ""

    for event_str in NEWS_EVENTS:
        try:
            event_dt = datetime.strptime(event_str, "%Y-%m-%d %H:%M")
            if (event_dt - buffer) <= now <= (event_dt + buffer):
                state["news_blackout"] = True
                state["blackout_reason"] = f"News blackout: {event_str} UTC"
                log(f"NEWS BLACKOUT: {event_str}", "warn")
                return
        except:
            pass

    macro = state.get("macro") or {}
    if macro.get("vix") and macro["vix"] > 30:
        state["news_blackout"] = True
        state["blackout_reason"] = f"VIX spike: {macro['vix']:.1f} -- high-impact event likely"
        log(f"VIX BLACKOUT: {macro['vix']:.1f}", "warn")

def compute_bias():
    score, conf = 0.0, []
    gex = state.get("gex") or {}
    macro = state.get("macro") or {}
    cot = state.get("cot") or {}
    sess = state.get("session") or {}
    prices = state.get("prices") or {}
    spy = gex.get("SPY") or {}
    ep = (prices.get("ES") or {}).get("price")
    regime = gex.get("sessionRegime", "MIXED")

    if spy:
        above = (ep > spy["gamma_flip"]) if ep and spy.get("gamma_flip") else None
        gs = {"MEAN REVERSION": 0.1 if spy.get("net_gex_label") == "positive" else -0.1,
              "TRENDING": 0.6 if above else -0.6,
              "HIGH VOL": -0.3, "CAUTION": -0.4, "MIXED": 0.0}.get(regime, 0.0)
        score += gs * 0.4
        conf.append(0.85 if regime != "MIXED" else 0.4)

    if cot.get("ES"):
        lf = (cot["ES"].get("leveragedFunds") or {})
        ss = (cot["ES"].get("smallSpec") or {})
        lfs = ((lf.get("index", 50) - 50) / 50)
        score += lfs * 0.3
        if ss.get("index", 50) > 80:
            score -= 0.08
        if ss.get("index", 50) < 20:
            score += 0.08
        conf.append(min(abs(lfs) + 0.3, 1.0))

    if macro.get("macroRegime4"):
        ms = {"GOLDILOCKS": 0.7, "REFLATION": 0.3, "DEFLATION": -0.3, "STAGFLATION": -0.8}.get(macro["macroRegime4"], 0.0)
        vix = macro.get("vix") or 15
        damp = 0.3 if vix > 30 else 0.5 if vix > 25 else 0.8 if vix > 20 else 1.0
        score += ms * damp * 0.2
        conf.append(0.7)

    if sess:
        a = (sess.get("asia") or {}).get("bias")
        l = (sess.get("london") or {}).get("bias")
        ss2 = 0.5 if a == "bullish" and l == "bullish" else -0.5 if a == "bearish" and l == "bearish" else 0.2 if (a == "bullish" or l == "bullish") else 0.0
        score += ss2 * 0.1
        conf.append(0.5)

    score = max(-1.0, min(1.0, score))
    c = sum(conf) / len(conf) if conf else 0.0
    lbl = ("STRONG BULL" if score > 0.5 else "BULL" if score > 0.15
           else "STRONG BEAR" if score < -0.5 else "BEAR" if score < -0.15 else "NEUTRAL")
    state["bias"] = {"score": round(score, 3), "conf": round(c, 3), "label": lbl}

def compute_kelly():
    macro = state.get("macro") or {}
    bias = state["bias"]
    pnl = state["pnl"]
    dep = state["dependency"]

    p_win = 0.5 + (bias["conf"] * 0.2)
    p_loss = 1 - p_win
    b = risk["target_pts"] / risk["stop_pts"]

    kelly_full = (p_win * b - p_loss) / b
    kelly_full = max(0.0, min(1.0, kelly_full))
    kelly_half = kelly_full * 0.5

    vix = macro.get("vix") or 15
    if vix > 30:
        vix_adj = 0.3
    elif vix > 25:
        vix_adj = 0.5
    elif vix > 20:
        vix_adj = 0.75
    else:
        vix_adj = 1.0

    dd_used = pnl["trailing_dd"]
    dd_limit = risk["trailing_dd"]
    if dd_limit > 0:
        dd_pct = dd_used / dd_limit
        if dd_pct > 0.75:
            dd_adj = 0.25
        elif dd_pct > 0.5:
            dd_adj = 0.5
        elif dd_pct > 0.25:
            dd_adj = 0.75
        else:
            dd_adj = 1.0
    else:
        dd_adj = 1.0

    streak = dep["streak"]
    if streak >= 3:
        streak_mult = 1.5
    elif streak >= 2:
        streak_mult = 1.25
    elif streak <= -3:
        streak_mult = 0.25
    elif streak <= -2:
        streak_mult = 0.5
    else:
        streak_mult = 1.0

    final_kelly = kelly_half * vix_adj * dd_adj * streak_mult
    final_kelly = max(0.1, min(1.0, final_kelly))

    base = risk["base_contracts"]
    max_c = min(risk["max_contracts"], TOPSTEP["max_contracts"])
    contracts = max(1, min(max_c, round(base * final_kelly / 0.5)))

    reason = (f"Kelly={final_kelly:.2f} "
              f"(VIX={vix:.0f}->{vix_adj:.2f} "
              f"DD={dd_pct*100:.0f}%->{dd_adj:.2f} "
              f"Streak={streak:+d}->{streak_mult:.2f})")

    state["kelly"] = {
        "fraction": round(final_kelly, 3),
        "contracts": contracts,
        "kelly_full": round(kelly_full, 3),
        "kelly_half": round(kelly_half, 3),
        "vix_adj": vix_adj,
        "dd_adj": dd_adj,
        "streak_mult": streak_mult,
        "p_win": round(p_win, 3),
        "reason": reason,
    }

def update_dependency(win: bool):
    dep = state["dependency"]
    trades = dep["trades"]
    trades.append(1 if win else -1)
    if len(trades) > 20:
        trades.pop(0)

    streak = 0
    for t in reversed(trades):
        if t == (1 if win else -1):
            streak += t
        else:
            break
    dep["streak"] = streak
    dep["multiplier"] = state["kelly"]["streak_mult"]
    log(f"Dependency: streak={streak:+d} mult={dep['multiplier']:.2f}")

def evaluate_signal():
    b = state["bias"]
    gex = state.get("gex") or {}
    spy = gex.get("SPY") or {}
    prices = state.get("prices") or {}
    ep = (prices.get("ES") or {}).get("price")
    regime = gex.get("sessionRegime", "")
    pnl = state["pnl"]
    kelly = state["kelly"]
    gates = {}

    def gate(k, name, passed, val=None):
        on = gates_cfg.get(k, True)
        gates[k] = {"on": on, "pass": not on or passed, "val": val or "--", "name": name}

    gate("bias", "Bias Confirmation", b["label"] != "NEUTRAL" and b["conf"] >= 0.4, f"{b['score']:+.2f}")
    gate("regime", "GEX Regime", regime in ["TRENDING", "MEAN REVERSION"], regime or "--")

    if spy.get("gamma_flip") and ep:
        dist = abs(ep - spy["gamma_flip"])
        gate("gamma_flip", "Gamma Flip Dist", dist >= 5, f"{dist:.1f}pts")
    else:
        gate("gamma_flip", "Gamma Flip Dist", True, "N/A")

    if spy.get("call_wall") and ep:
        dc = abs(ep - spy["call_wall"])
        dp = abs(ep - spy["put_wall"]) if spy.get("put_wall") else 999
        gate("gex_walls", "GEX Wall Dist", dc >= 8 and dp >= 8, f"CW:{dc:.0f} PW:{dp:.0f}")
    else:
        gate("gex_walls", "GEX Wall Dist", True, "N/A")

    gate("news", "News Blackout", not state["news_blackout"],
         state["blackout_reason"] if state["news_blackout"] else "Clear")

    daily_ok = pnl["daily_loss"] < risk["max_daily_loss"]
    gate("daily_loss", "Daily Loss Limit", daily_ok,
         f"-${pnl['daily_loss']:.0f} / ${risk['max_daily_loss']:.0f}")

    trailing_ok = pnl["trailing_dd"] < risk["trailing_dd"]
    gate("trailing_dd", "Trailing Drawdown", trailing_ok,
         f"-${pnl['trailing_dd']:.0f} / ${risk['trailing_dd']:.0f}")

    gate("delta", "Cumul. Delta", True, "Rithmic pending")
    gate("vwap", "VWAP Band", True, "Rithmic pending")
    gate("dom", "DOM Imbalance", True, "Rithmic pending")

    state["gates"] = gates

    if risk["kill_switch"] or not ep:
        state["signal"] = None
        return

    all_pass = all(g["pass"] for g in gates.values() if g["on"])
    if not all_pass or b["label"] == "NEUTRAL":
        state["signal"] = None
        return

    direction = "long" if b["score"] > 0 else "short"
    contracts = kelly["contracts"] if risk["use_kelly"] else risk["base_contracts"]

    sl_pts = risk["stop_pts"]
    sl = round((ep - sl_pts if direction == "long" else ep + sl_pts) / 0.25) * 0.25

    wall = spy.get("call_wall") if direction == "long" else spy.get("put_wall")
    tgt_pts = risk["target_pts"]
    if wall and abs(wall - ep) > sl_pts * 1.5:
        tp = wall
        tgt_pts = abs(wall - ep)
    else:
        tp = round((ep + tgt_pts if direction == "long" else ep - tgt_pts) / 0.25) * 0.25

    partial_price = round((ep + tgt_pts * risk["partial_at_pct"] if direction == "long"
                           else ep - tgt_pts * risk["partial_at_pct"]) / 0.25) * 0.25
    partial_contracts = max(1, round(contracts * risk["partial_pct"]))

    rr = round(abs(tp - ep) / max(abs(sl - ep), 0.25), 2)
    ev_per_trade = (kelly["p_win"] * tgt_pts * 50 * contracts) - ((1 - kelly["p_win"]) * sl_pts * 50 * contracts)

    state["signal"] = {
        "direction": direction,
        "price": ep,
        "stop_loss": sl,
        "take_profit": tp,
        "partial_price": partial_price,
        "partial_contracts": partial_contracts,
        "contracts": contracts,
        "rr": rr,
        "ev_usd": round(ev_per_trade, 2),
        "confidence": b["conf"],
        "kelly_fraction": kelly["fraction"],
        "gex_regime": regime,
        "gamma_flip": spy.get("gamma_flip"),
        "call_wall": spy.get("call_wall"),
        "put_wall": spy.get("put_wall"),
        "reason": (f"{direction.upper()} | {b['label']} | {regime} | "
                   f"conf={b['conf']:.0%} | {contracts}ct | "
                   f"EV=${ev_per_trade:.0f} | {kelly['reason']}"),
        "timestamp": datetime.now().isoformat(),
    }
    log(f"✅ {state['signal']['reason']}")

def record_trade(direction, entry, exit_price, contracts, conf, regime):
    pts = (exit_price - entry) if direction == "long" else (entry - exit_price)
    pnl_usd = pts * 50 * contracts
    win = pnl_usd > 0

    p = state["pnl"]
    p["all_time"] += pnl_usd
    p["trades"] += 1
    if win:
        p["wins"] += 1

    if pnl_usd < 0:
        p["daily_loss"] -= pnl_usd

    if p["all_time"] > p["peak"]:
        p["peak"] = p["all_time"]
    p["trailing_dd"] = max(0, p["peak"] - p["all_time"])
    p["today"] = p["all_time"]

    if risk["use_dependency"]:
        update_dependency(win)

    trade = {
        "time": datetime.now().strftime("%H:%M:%S"),
        "direction": direction,
        "entry": entry,
        "exit": exit_price,
        "contracts": contracts,
        "pnl": round(pnl_usd, 2),
        "pts": round(pts, 2),
        "conf": conf,
        "regime": regime,
        "win": win,
    }
    state["trades"].insert(0, trade)
    if len(state["trades"]) > 100:
        state["trades"].pop()

    log(f"Trade closed: {direction.upper()} {pts:+.2f}pts = ${pnl_usd:+.0f} | "
        f"DD=${p['trailing_dd']:.0f} | Streak={state['dependency']['streak']:+d}",
        "ok" if win else "warn")

    if p["daily_loss"] >= TOPSTEP["max_daily_loss"]:
        risk["kill_switch"] = True
        log(f"KILL SWITCH: Daily loss limit ${TOPSTEP['max_daily_loss']} reached", "error")

    if p["trailing_dd"] >= TOPSTEP["trailing_dd_limit"]:
        risk["kill_switch"] = True
        log(f"KILL SWITCH: Trailing DD ${TOPSTEP['trailing_dd_limit']} reached", "error")

async def fetch_all():
    log("Fetching data...")
    results = await asyncio.gather(
        get("/api/gex"), get("/api/macro"), get("/api/cot"),
        get("/api/session"), get("/api/prices"), return_exceptions=True,
    )
    for k, r in zip(["gex", "macro", "cot", "session", "prices"], results):
        if isinstance(r, Exception):
            log(f"{k}: {r}", "warn")
        elif r:
            state[k] = r
            log(f"{k} ✓")
    check_news_blackout()
    compute_bias()
    compute_kelly()
    evaluate_signal()
    state["last_update"] = datetime.now().isoformat()

# ========== FLASK ROUTES ==========
@app.route('/')
def dashboard():
    return render_template_string(HTML_TEMPLATE)

@app.route('/api/state')
def get_state():
    return jsonify({
        "bias": state["bias"],
        "signal": state["signal"],
        "gates": state["gates"],
        "kelly": state["kelly"],
        "dependency": state["dependency"],
        "gex": state.get("gex"),
        "macro": state.get("macro"),
        "cot": state.get("cot"),
        "session": state.get("session"),
        "prices": state.get("prices"),
        "pnl": state["pnl"],
        "news_blackout": state["news_blackout"],
        "blackout_reason": state["blackout_reason"],
        "trades": state["trades"][:50],
        "log": state["log"][:40],
        "risk": risk,
        "last_update": state["last_update"],
    })

@app.route('/api/refresh', methods=['POST'])
def refresh_data():
    asyncio.create_task(fetch_all())
    return jsonify({"ok": True, "last_update": state["last_update"]})

@app.route('/api/trade', methods=['POST'])
def add_trade():
    data = request.json
    record_trade(
        direction=data.get("direction", "long"),
        entry=float(data.get("entry", 0)),
        exit_price=float(data.get("exit", 0)),
        contracts=int(data.get("contracts", 1)),
        conf=float(data.get("conf", 0)),
        regime=data.get("regime", "--"),
    )
    return jsonify({"ok": True, "pnl": state["pnl"]})

@app.route('/health')
def health():
    return jsonify({"ok": True, "logged_in": bool(auth["access_token"]), "last_update": state["last_update"]})

# ========== HTML TEMPLATE ==========
HTML_TEMPLATE = '''
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ES Algo Dashboard</title>
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: #0a0a12;
            color: #e0e0e0;
            margin: 0;
            padding: 20px;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        h1 { color: #00d4ff; text-align: center; margin-bottom: 20px; }
        .status-bar {
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            padding: 15px;
            border-radius: 12px;
            margin-bottom: 20px;
            text-align: center;
            border-left: 4px solid #00d4ff;
        }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
            gap: 20px;
            margin-bottom: 20px;
        }
        .card {
            background: #16213e;
            border-radius: 12px;
            padding: 20px;
            border: 1px solid #2a2a4e;
            transition: all 0.3s;
        }
        .card:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(0,0,0,0.3); }
        .card h3 {
            margin: 0 0 15px 0;
            color: #00d4ff;
            font-size: 1.2em;
            border-bottom: 1px solid #2a2a4e;
            padding-bottom: 8px;
        }
        .signal-card {
            background: linear-gradient(135deg, #1a3a2e 0%, #0a2a1e 100%);
            border-left: 4px solid #00ff88;
        }
        .signal-card.bear { border-left-color: #ff4444; background: linear-gradient(135deg, #3a1a1a 0%, #2a0a0a 100%); }
        .value { font-size: 1.8em; font-weight: bold; color: #00d4ff; }
        .label { font-size: 0.85em; color: #888; margin-top: 5px; }
        pre {
            background: #0a0a12;
            padding: 12px;
            border-radius: 8px;
            overflow-x: auto;
            font-size: 0.85em;
            margin: 10px 0 0;
        }
        button {
            background: #00d4ff;
            color: #0a0a12;
            border: none;
            padding: 10px 24px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: bold;
            margin: 10px 5px;
            transition: all 0.3s;
        }
        button:hover { background: #00b8d4; transform: scale(1.02); }
        .refresh-btn { background: #4a4a6a; color: white; }
        .refresh-btn:hover { background: #5a5a7a; }
        .timestamp { font-size: 0.8em; color: #666; text-align: right; margin-top: 20px; }
        .log-entry { font-family: monospace; font-size: 0.8em; padding: 4px 0; border-bottom: 1px solid #2a2a4e; }
        .log-info { color: #aaa; }
        .log-warn { color: #ffaa44; }
        .log-error { color: #ff4444; }
        .log-ok { color: #44ff88; }
        .flex { display: flex; justify-content: space-between; align-items: center; }
        .gate-pass { color: #44ff88; }
        .gate-fail { color: #ff4444; }
    </style>
</head>
<body>
    <div class="container">
        <div class="flex">
            <h1>📊 ES Algo Dashboard v3</h1>
            <div>
                <button class="refresh-btn" onclick="refreshData()">🔄 Refresh</button>
                <button onclick="fetchData()">📈 Update</button>
            </div>
        </div>
        <div class="status-bar" id="statusBar">Loading data...</div>
        <div class="grid" id="dashboardGrid"></div>
        <div class="timestamp" id="timestamp"></div>
    </div>

    <script>
        async function fetchData() {
            const grid = document.getElementById('dashboardGrid');
            const statusBar = document.getElementById('statusBar');
            grid.innerHTML = '<div class="card"><div class="value">🔄 Loading...</div></div>';
            
            try {
                const response = await fetch('/api/state');
                const data = await response.json();
                displayData(data);
                statusBar.innerHTML = `✅ Last update: ${data.last_update || 'Just now'} | Signal: ${data.signal?.direction?.toUpperCase() || 'NONE'} | Kelly: ${(data.kelly?.fraction * 100 || 0).toFixed(0)}%`;
            } catch (error) {
                grid.innerHTML = `<div class="card"><h3>❌ Error</h3><pre>${error.message}</pre></div>`;
                statusBar.innerHTML = '❌ Failed to load data';
            }
        }
        
        async function refreshData() {
            const statusBar = document.getElementById('statusBar');
            statusBar.innerHTML = '🔄 Refreshing algo data...';
            try {
                await fetch('/api/refresh', { method: 'POST' });
                setTimeout(() => fetchData(), 1000);
            } catch (error) {
                statusBar.innerHTML = '❌ Refresh failed';
            }
        }
        
        function displayData(data) {
            const grid = document.getElementById('dashboardGrid');
            const signal = data.signal;
            const signalClass = signal?.direction === 'long' ? '' : (signal?.direction === 'short' ? 'bear' : '');
            
            const cards = [
                { title: "🎯 SIGNAL", content: signal ? `
                    <div class="value" style="color: ${signal.direction === 'long' ? '#00ff88' : '#ff4444'}">${signal.direction?.toUpperCase() || 'NONE'}</div>
                    <div class="label">${signal?.reason || 'No signal'}</div>
                    <div class="flex" style="margin-top: 12px;">
                        <span>📊 ${signal?.contracts || 0} ct</span>
                        <span>🎯 ${signal?.rr || 0}:1 RR</span>
                        <span>💰 EV: $${signal?.ev_usd || 0}</span>
                    </div>
                    <pre style="margin-top: 12px;">Stop: ${signal?.stop_loss || '--'}\\nTarget: ${signal?.take_profit || '--'}\\nPartial: ${signal?.partial_price || '--'} (${signal?.partial_contracts || 0} ct)</pre>
                ` : '<div class="label">No active signal — check gates</div>', class: signalClass },
                
                { title: "📈 BIAS", content: `
                    <div class="value">${data.bias?.label || 'NEUTRAL'}</div>
                    <div class="label">Score: ${(data.bias?.score || 0).toFixed(2)} | Conf: ${((data.bias?.conf || 0) * 100).toFixed(0)}%</div>
                `},
                
                { title: "💰 KELLY SIZING", content: `
                    <div class="value">${data.kelly?.contracts || 1} contracts</div>
                    <div class="label">Fraction: ${((data.kelly?.fraction || 0) * 100).toFixed(0)}%</div>
                    <pre style="font-size: 0.7em;">${data.kelly?.reason || '--'}</pre>
                `},
                
                { title: "📊 P&L (Today)", content: `
                    <div class="value" style="color: ${(data.pnl?.today || 0) >= 0 ? '#44ff88' : '#ff4444'}">$${(data.pnl?.today || 0).toFixed(0)}</div>
                    <div class="flex">
                        <span>📈 ${data.pnl?.wins || 0}/${data.pnl?.trades || 0} wins</span>
                        <span>📉 DD: $${(data.pnl?.trailing_dd || 0).toFixed(0)}</span>
                        <span>⚠️ Daily loss: $${(data.pnl?.daily_loss || 0).toFixed(0)}</span>
                    </div>
                `},
                
                { title: "🔒 GATES", content: Object.entries(data.gates || {}).slice(0, 6).map(([k, g]) => 
                    `<div class="flex"><span>${g?.name || k}:</span><span class="${g?.pass ? 'gate-pass' : 'gate-fail'}">${g?.pass ? '✓' : '✗'} ${g?.val || ''}</span></div>`
                ).join('') },
                
                { title: "📝 LOG", content: (data.log || []).slice(0, 8).map(l => 
                    `<div class="log-entry log-${l.level}">[${l.ts}] ${l.msg}</div>`
                ).join('') || '--' }
            ];
            
            grid.innerHTML = cards.map(card => `
                <div class="card ${card.class || ''}">
                    <h3>${card.title}</h3>
                    ${card.content}
                </div>
            `).join('');
            
            document.getElementById('timestamp').innerHTML = `Last update: ${data.last_update || new Date().toLocaleString()}`;
        }
        
        fetchData();
        setInterval(fetchData, 30000);
    </script>
</body>
</html>
'''

# ========== BACKGROUND TASKS ==========
async def poll_loop():
    try:
        await login()
    except Exception as e:
        log(f"Login failed: {e}", "warn")
    await fetch_all()
    while True:
        await asyncio.sleep(60)
        try:
            await fetch_all()
        except Exception as e:
            log(str(e), "warn")

async def token_loop():
    while True:
        await asyncio.sleep(50 * 60)
        try:
            await do_refresh()
        except Exception as e:
            log(f"Token refresh error: {e}", "warn")

def reset_daily():
    state["pnl"]["daily_loss"] = 0.0
    if risk["kill_switch"] and state["pnl"]["trailing_dd"] < TOPSTEP["trailing_dd_limit"]:
        risk["kill_switch"] = False
        log("Daily reset — Kill switch deactivated")
    log("Daily PnL reset")

async def daily_reset_loop():
    while True:
        now = datetime.now()
        next_reset = now.replace(hour=23, minute=0, second=0, microsecond=0)
        if now >= next_reset:
            next_reset += timedelta(days=1)
        await asyncio.sleep((next_reset - now).total_seconds())
        reset_daily()

# ========== MAIN ==========
async def main():
    import threading
    
    def run_flask():
        app.run(host='0.0.0.0', port=PORT, debug=False, use_reloader=False)
    
    flask_thread = threading.Thread(target=run_flask, daemon=True)
    flask_thread.start()
    
    log(f"ES Algo v3 — PORT {PORT} — Kelly+Dependency+NewsFilter+Partials")
    await asyncio.gather(poll_loop(), token_loop(), daily_reset_loop())

if __name__ == "__main__":
    asyncio.run(main())
