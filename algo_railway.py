"""
ES Algo — Vollständige Version
Integriert:
  - Alpha-Bias (GEX, Macro, COT, Session) via Auto-Login
  - Kelly-basiertes Position Sizing (ATR + VIX angepasst)
  - Dependency Analysis (Streak-basierte Größenanpassung)
  - Partials statt Breakeven-Stop (25% bei 50% Weg zum Target)
  - News Blackout (FOMC, NFP, CPI — 30 Min vor/nach)
  - Regime Filter (Dispersion/Correlation Proxy via VIX + GEX)
  - Drawdown Aversion (Kelly reduziert bei erhöhtem DD)
  - Topstep Regeln (Max Daily Loss, Trailing DD)
"""

import asyncio
import base64
import json
import logging
import math
import os
import time
from datetime import datetime, date, timedelta
from typing import Optional
import aiohttp
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("algo")

# ── Config ────────────────────────────────────────────────────────────────

ALPHA_BIAS_URL    = os.getenv("ALPHA_BIAS_URL",    "https://alpha-bias.com")
EMAIL             = os.getenv("ALPHA_BIAS_EMAIL",   "")
PASSWORD          = os.getenv("ALPHA_BIAS_PASSWORD","")
PORT              = int(os.getenv("PORT", 8080))
SUPABASE_URL      = "https://svnmcthtxppbahwimzjx.supabase.co"
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")

# ── Topstep Risk Rules ────────────────────────────────────────────────────

TOPSTEP = {
    "account_size":      50_000,
    "max_daily_loss":    1_000,    # Hard stop — no more trades after this
    "trailing_dd_limit": 2_000,    # Trailing drawdown from peak
    "profit_target":     3_000,    # Express funded target
    "max_contracts":     5,        # Max allowed on 50k account
}

# ── News Blackout Calendar ────────────────────────────────────────────────
# Format: "YYYY-MM-DD HH:MM" UTC — 30 min buffer added automatically
NEWS_EVENTS = [
    # Add upcoming high-impact events here
    # "2025-06-11 18:00",  # FOMC
    # "2025-06-06 12:30",  # NFP
]

# ── Auth ──────────────────────────────────────────────────────────────────

auth = {"access_token": "", "refresh_token": "", "expires_at": 0.0}

def decode_exp(token):
    try:
        p = token.split(".")[1]; p += "=" * (4 - len(p) % 4)
        return float(json.loads(base64.b64decode(p)).get("exp", 0))
    except: return 0.0

async def login():
    logger.info(f"Logging in as {EMAIL}...")
    async with aiohttp.ClientSession() as s:
        async with s.post(f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
            json={"email": EMAIL, "password": PASSWORD},
            headers={"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"},
            timeout=aiohttp.ClientTimeout(total=15)) as r:
            if r.status != 200: raise Exception(f"Login failed {r.status}: {await r.text()}")
            d = await r.json()
            auth["access_token"]  = d["access_token"]
            auth["refresh_token"] = d["refresh_token"]
            auth["expires_at"]    = decode_exp(d["access_token"])
            logger.info(f"Login ✓ — token valid {int((auth['expires_at']-time.time())//60)} min")

async def do_refresh():
    async with aiohttp.ClientSession() as s:
        async with s.post(f"{SUPABASE_URL}/auth/v1/token?grant_type=refresh_token",
            json={"refresh_token": auth["refresh_token"]},
            headers={"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"},
            timeout=aiohttp.ClientTimeout(total=15)) as r:
            if r.status != 200: await login(); return
            d = await r.json()
            auth["access_token"]  = d["access_token"]
            auth["refresh_token"] = d.get("refresh_token", auth["refresh_token"])
            auth["expires_at"]    = decode_exp(d["access_token"])
            logger.info("Token refreshed ✓")

async def ensure_auth():
    if not auth["access_token"]: await login(); return
    if time.time() >= auth["expires_at"] - 300:
        try: await do_refresh()
        except: await login()

def hdrs(): return {"Authorization": f"Bearer {auth['access_token']}"}

# ── State ──────────────────────────────────────────────────────────────────

state = {
    "macro": None, "gex": None, "cot": None, "session": None, "prices": None,
    "bias": {"score": 0.0, "conf": 0.0, "label": "NEUTRAL"},
    "gates": {}, "signal": None,
    "kelly": {"fraction": 0.5, "contracts": 1, "reason": "—"},
    "dependency": {"streak": 0, "multiplier": 1.0, "trades": []},
    "pnl": {
        "today": 0.0, "trades": 0, "wins": 0, "peak": 0.0,
        "all_time": 0.0, "trailing_dd": 0.0, "daily_loss": 0.0,
    },
    "trades": [], "log": [], "last_update": None,
    "news_blackout": False, "blackout_reason": "",
}

risk = {
    "base_contracts":  1,
    "max_contracts":   3,
    "stop_pts":        4.0,
    "target_pts":      8.0,
    "partial_pct":     0.25,     # Close 25% at 50% of target
    "partial_at_pct":  0.50,     # Trigger partial at 50% of way to target
    "use_kelly":       True,
    "use_dependency":  True,
    "use_news_filter": True,
    "kill_switch":     False,
    "max_daily_loss":  TOPSTEP["max_daily_loss"],
    "trailing_dd":     TOPSTEP["trailing_dd_limit"],
}

gates_cfg = {
    "bias": True, "regime": True, "gamma_flip": True, "gex_walls": True,
    "news": True, "daily_loss": True, "trailing_dd": True,
    "delta": True, "vwap": True, "dom": False,
}

def log(msg, level="info"):
    state["log"].insert(0, {"ts": datetime.utcnow().strftime("%H:%M:%S"), "msg": msg, "level": level})
    if len(state["log"]) > 150: state["log"].pop()
    (logger.info if level == "info" else logger.warning)(msg)

# ── Fetch ──────────────────────────────────────────────────────────────────

async def get(path):
    await ensure_auth()
    async with aiohttp.ClientSession() as s:
        async with s.get(ALPHA_BIAS_URL + path, headers=hdrs(),
                         timeout=aiohttp.ClientTimeout(total=12)) as r:
            if r.status == 401: await login(); return None
            return await r.json() if r.ok else None

async def fetch_all():
    log("Fetching data...")
    results = await asyncio.gather(
        get("/api/gex"), get("/api/macro"), get("/api/cot"),
        get("/api/session"), get("/api/prices"), return_exceptions=True,
    )
    for k, r in zip(["gex","macro","cot","session","prices"], results):
        if isinstance(r, Exception): log(f"{k}: {r}", "warn")
        elif r: state[k] = r; log(f"{k} ✓")
    check_news_blackout()
    compute_bias()
    compute_kelly()
    evaluate_signal()
    state["last_update"] = datetime.utcnow().isoformat()

# ── News Blackout ──────────────────────────────────────────────────────────

def check_news_blackout():
    """Block trading 30 minutes before and after high-impact news."""
    now = datetime.utcnow()
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
        except: pass

    # Auto-detect from macro data: FOMC minutes at :00 (approx)
    # Additional: check if VIX spiked suddenly (proxy for surprise events)
    macro = state.get("macro") or {}
    if macro.get("vix") and macro["vix"] > 30:
        state["news_blackout"] = True
        state["blackout_reason"] = f"VIX spike: {macro['vix']:.1f} — high-impact event likely"
        log(f"VIX BLACKOUT: {macro['vix']:.1f}", "warn")

# ── Bias ───────────────────────────────────────────────────────────────────

def compute_bias():
    score, conf = 0.0, []
    gex    = state.get("gex") or {}
    macro  = state.get("macro") or {}
    cot    = state.get("cot") or {}
    sess   = state.get("session") or {}
    prices = state.get("prices") or {}
    spy    = gex.get("SPY") or {}
    ep     = (prices.get("ES") or {}).get("price")
    regime = gex.get("sessionRegime", "MIXED")

    # GEX 40%
    if spy:
        above = (ep > spy["gamma_flip"]) if ep and spy.get("gamma_flip") else None
        gs = {"MEAN REVERSION": 0.1 if spy.get("net_gex_label")=="positive" else -0.1,
              "TRENDING": 0.6 if above else -0.6,
              "HIGH VOL": -0.3, "CAUTION": -0.4, "MIXED": 0.0}.get(regime, 0.0)
        score += gs * 0.4; conf.append(0.85 if regime != "MIXED" else 0.4)

    # COT 30% — Leveraged Funds (Smart Money)
    if cot.get("ES"):
        lf  = (cot["ES"].get("leveragedFunds") or {})
        ss  = (cot["ES"].get("smallSpec") or {})
        lfs = ((lf.get("index", 50) - 50) / 50)
        score += lfs * 0.3
        if ss.get("index", 50) > 80: score -= 0.08   # Retail extreme long = contrarian bearish
        if ss.get("index", 50) < 20: score += 0.08   # Retail extreme short = contrarian bullish
        conf.append(min(abs(lfs) + 0.3, 1.0))

    # Macro 20% — Growth/Inflation Regime
    if macro.get("macroRegime4"):
        ms = {"GOLDILOCKS":0.7,"REFLATION":0.3,"DEFLATION":-0.3,"STAGFLATION":-0.8}.get(macro["macroRegime4"],0.0)
        # High dispersion + high correlation = danger (2008 regime) → dampen
        vix = macro.get("vix") or 15
        damp = 0.3 if vix > 30 else 0.5 if vix > 25 else 0.8 if vix > 20 else 1.0
        score += ms * damp * 0.2; conf.append(0.7)

    # Session 10%
    if sess:
        a = (sess.get("asia") or {}).get("bias")
        l = (sess.get("london") or {}).get("bias")
        ss2 = 0.5 if a=="bullish" and l=="bullish" else -0.5 if a=="bearish" and l=="bearish" \
              else 0.2 if (a=="bullish" or l=="bullish") else 0.0
        score += ss2 * 0.1; conf.append(0.5)

    score = max(-1.0, min(1.0, score))
    c     = sum(conf) / len(conf) if conf else 0.0
    lbl   = ("STRONG BULL" if score > 0.5 else "BULL" if score > 0.15
             else "STRONG BEAR" if score < -0.5 else "BEAR" if score < -0.15 else "NEUTRAL")
    state["bias"] = {"score": round(score, 3), "conf": round(c, 3), "label": lbl}

# ── Kelly Position Sizing ─────────────────────────────────────────────────

def compute_kelly():
    """
    Half-Kelly mit Fat Tail Anpassung basierend auf:
    - VIX (Volatilitäts-Proxy für ATR)
    - Aktuellem Drawdown (Drawdown Aversion)
    - Bias Confidence
    - Dependency Streak
    """
    macro  = state.get("macro") or {}
    bias   = state["bias"]
    pnl    = state["pnl"]
    dep    = state["dependency"]

    # Base: Win Rate schätzung aus Bias Confidence
    p_win  = 0.5 + (bias["conf"] * 0.2)   # 50-70% abhängig von Confidence
    p_loss = 1 - p_win
    b      = risk["target_pts"] / risk["stop_pts"]   # Reward/Risk Ratio

    # Kelly Formel: f* = (p*b - q) / b
    kelly_full = (p_win * b - p_loss) / b
    kelly_full = max(0.0, min(1.0, kelly_full))

    # Half-Kelly (konservativer, reduziert Ruin-Risiko)
    kelly_half = kelly_full * 0.5

    # Fat Tail Anpassung: VIX-basiert
    vix = macro.get("vix") or 15
    if vix > 30:    vix_adj = 0.3    # Extrem hohe Vol → stark reduzieren
    elif vix > 25:  vix_adj = 0.5    # Hohe Vol
    elif vix > 20:  vix_adj = 0.75   # Erhöhte Vol
    else:           vix_adj = 1.0    # Normal

    # Drawdown Aversion: Je näher am Trailing DD Limit, desto kleiner
    dd_used = pnl["trailing_dd"]
    dd_limit = risk["trailing_dd"]
    if dd_limit > 0:
        dd_pct = dd_used / dd_limit
        if dd_pct > 0.75:   dd_adj = 0.25   # >75% DD verwendet → sehr klein
        elif dd_pct > 0.5:  dd_adj = 0.5    # >50% → halb
        elif dd_pct > 0.25: dd_adj = 0.75   # >25% → leicht reduziert
        else:               dd_adj = 1.0
    else:
        dd_adj = 1.0

    # Dependency Adjustment (Streak)
    streak = dep["streak"]
    if streak >= 3:      streak_mult = 1.5    # 3+ Wins → Press the edge
    elif streak >= 2:    streak_mult = 1.25
    elif streak <= -3:   streak_mult = 0.25   # 3+ Losses → Survival mode
    elif streak <= -2:   streak_mult = 0.5
    else:                streak_mult = 1.0

    # Finaler Kelly Fraction
    final_kelly = kelly_half * vix_adj * dd_adj * streak_mult
    final_kelly = max(0.1, min(1.0, final_kelly))

    # Kontrakte berechnen
    base = risk["base_contracts"]
    max_c = min(risk["max_contracts"], TOPSTEP["max_contracts"])
    contracts = max(1, min(max_c, round(base * final_kelly / 0.5)))

    reason = (f"Kelly={final_kelly:.2f} "
              f"(VIX={vix:.0f}→{vix_adj:.2f} "
              f"DD={dd_pct*100:.0f}%→{dd_adj:.2f} "
              f"Streak={streak:+d}→{streak_mult:.2f})")

    state["kelly"] = {
        "fraction":   round(final_kelly, 3),
        "contracts":  contracts,
        "kelly_full": round(kelly_full, 3),
        "kelly_half": round(kelly_half, 3),
        "vix_adj":    vix_adj,
        "dd_adj":     dd_adj,
        "streak_mult":streak_mult,
        "p_win":      round(p_win, 3),
        "reason":     reason,
    }

# ── Dependency Analysis ────────────────────────────────────────────────────

def update_dependency(win: bool):
    """
    Turlakov Dependency: Wins follow Wins → Increase size.
    Losses follow Losses → Decrease size (Survival mode).
    """
    dep = state["dependency"]
    trades = dep["trades"]
    trades.append(1 if win else -1)
    if len(trades) > 20: trades.pop(0)

    # Streak berechnen
    streak = 0
    for t in reversed(trades):
        if t == (1 if win else -1): streak += t
        else: break
    dep["streak"] = streak
    dep["multiplier"] = state["kelly"]["streak_mult"]
    log(f"Dependency: streak={streak:+d} mult={dep['multiplier']:.2f}")

# ── Gates + Signal ─────────────────────────────────────────────────────────

def evaluate_signal():
    b      = state["bias"]
    gex    = state.get("gex") or {}
    spy    = gex.get("SPY") or {}
    prices = state.get("prices") or {}
    ep     = (prices.get("ES") or {}).get("price")
    regime = gex.get("sessionRegime", "")
    pnl    = state["pnl"]
    kelly  = state["kelly"]
    gates  = {}

    def gate(k, name, passed, val=None):
        on = gates_cfg.get(k, True)
        gates[k] = {"on": on, "pass": not on or passed, "val": val or "—", "name": name}

    # ── Core Bias Gates ──────────────────────────────────────────────────
    gate("bias",    "Bias Confirmation",   b["label"] != "NEUTRAL" and b["conf"] >= 0.4, f"{b['score']:+.2f}")
    gate("regime",  "GEX Regime",          regime in ["TRENDING","MEAN REVERSION"], regime or "—")

    # ── GEX Level Gates ──────────────────────────────────────────────────
    if spy.get("gamma_flip") and ep:
        dist = abs(ep - spy["gamma_flip"])
        gate("gamma_flip", "Gamma Flip Dist", dist >= 5, f"{dist:.1f}pts")
    else:
        gate("gamma_flip", "Gamma Flip Dist", True, "N/A")

    if spy.get("call_wall") and ep:
        dc = abs(ep - spy["call_wall"]); dp = abs(ep - spy["put_wall"]) if spy.get("put_wall") else 999
        gate("gex_walls", "GEX Wall Dist", dc >= 8 and dp >= 8, f"CW:{dc:.0f} PW:{dp:.0f}")
    else:
        gate("gex_walls", "GEX Wall Dist", True, "N/A")

    # ── News Blackout Gate ───────────────────────────────────────────────
    gate("news", "News Blackout", not state["news_blackout"],
         state["blackout_reason"] if state["news_blackout"] else "Clear")

    # ── Topstep Risk Gates ───────────────────────────────────────────────
    daily_ok = pnl["daily_loss"] < risk["max_daily_loss"]
    gate("daily_loss",   "Daily Loss Limit",   daily_ok,
         f"-${pnl['daily_loss']:.0f} / ${risk['max_daily_loss']:.0f}")

    trailing_ok = pnl["trailing_dd"] < risk["trailing_dd"]
    gate("trailing_dd",  "Trailing Drawdown",  trailing_ok,
         f"-${pnl['trailing_dd']:.0f} / ${risk['trailing_dd']:.0f}")

    # ── Rithmic Gates (pending) ──────────────────────────────────────────
    gate("delta", "Cumul. Delta",    True, "Rithmic pending")
    gate("vwap",  "VWAP Band",       True, "Rithmic pending")
    gate("dom",   "DOM Imbalance",   True, "Rithmic pending")

    state["gates"] = gates

    # ── Kill Switch / Signal ─────────────────────────────────────────────
    if risk["kill_switch"] or not ep:
        state["signal"] = None; return

    all_pass = all(g["pass"] for g in gates.values() if g["on"])
    if not all_pass or b["label"] == "NEUTRAL":
        state["signal"] = None; return

    direction = "long" if b["score"] > 0 else "short"
    contracts = kelly["contracts"] if risk["use_kelly"] else risk["base_contracts"]

    # Stop Loss
    sl_pts = risk["stop_pts"]
    sl = round((ep - sl_pts if direction=="long" else ep + sl_pts) / 0.25) * 0.25

    # Target — GEX Wall wenn erreichbar, sonst Standard
    wall = spy.get("call_wall") if direction=="long" else spy.get("put_wall")
    tgt_pts = risk["target_pts"]
    if wall and abs(wall - ep) > sl_pts * 1.5:
        tp = wall
        tgt_pts = abs(wall - ep)
    else:
        tp = round((ep + tgt_pts if direction=="long" else ep - tgt_pts) / 0.25) * 0.25

    # Partial Exit Level (25% bei 50% des Weges zum Target)
    partial_price = round((ep + tgt_pts * risk["partial_at_pct"] if direction=="long"
                           else ep - tgt_pts * risk["partial_at_pct"]) / 0.25) * 0.25
    partial_contracts = max(1, round(contracts * risk["partial_pct"]))

    rr = round(abs(tp - ep) / max(abs(sl - ep), 0.25), 2)

    # EV Berechnung (Kelly-basiert)
    p_win = kelly["p_win"]
    ev_per_trade = (p_win * tgt_pts * 50 * contracts) - ((1-p_win) * sl_pts * 50 * contracts)

    state["signal"] = {
        "direction":          direction,
        "price":              ep,
        "stop_loss":          sl,
        "take_profit":        tp,
        "partial_price":      partial_price,
        "partial_contracts":  partial_contracts,
        "contracts":          contracts,
        "rr":                 rr,
        "ev_usd":             round(ev_per_trade, 2),
        "confidence":         b["conf"],
        "kelly_fraction":     kelly["fraction"],
        "gex_regime":         regime,
        "gamma_flip":         spy.get("gamma_flip"),
        "call_wall":          spy.get("call_wall"),
        "put_wall":           spy.get("put_wall"),
        "reason":             (f"{direction.upper()} | {b['label']} | {regime} | "
                               f"conf={b['conf']:.0%} | {contracts}ct | "
                               f"EV=${ev_per_trade:.0f} | {kelly['reason']}"),
        "timestamp":          datetime.utcnow().isoformat(),
    }
    log(f"✅ {state['signal']['reason']}")

# ── PnL Tracking ───────────────────────────────────────────────────────────

def record_trade(direction, entry, exit_price, contracts, conf, regime):
    """Aufzeichnen eines abgeschlossenen Trades."""
    pts    = (exit_price - entry) if direction == "long" else (entry - exit_price)
    pnl_usd = pts * 50 * contracts   # ES: $50/Punkt
    win    = pnl_usd > 0

    p = state["pnl"]
    p["all_time"]  += pnl_usd
    p["trades"]    += 1
    if win: p["wins"] += 1

    # Tagesverlust
    if pnl_usd < 0:
        p["daily_loss"] -= pnl_usd   # daily_loss ist positiv (absoluter Verlust)

    # Trailing Drawdown
    if p["all_time"] > p["peak"]:
        p["peak"] = p["all_time"]
    p["trailing_dd"] = max(0, p["peak"] - p["all_time"])
    p["today"]       = p["all_time"]   # Vereinfacht — in Produktion: nur heute

    # Dependency update
    if risk["use_dependency"]:
        update_dependency(win)

    # Trade log
    trade = {
        "time":      datetime.utcnow().strftime("%H:%M:%S"),
        "direction": direction,
        "entry":     entry,
        "exit":      exit_price,
        "contracts": contracts,
        "pnl":       round(pnl_usd, 2),
        "pts":       round(pts, 2),
        "conf":      conf,
        "regime":    regime,
        "win":       win,
    }
    state["trades"].insert(0, trade)
    if len(state["trades"]) > 100: state["trades"].pop()

    log(f"Trade closed: {direction.upper()} {pts:+.2f}pts = ${pnl_usd:+.0f} | "
        f"DD=${p['trailing_dd']:.0f} | Streak={state['dependency']['streak']:+d}",
        "ok" if win else "warn")

    # Topstep Safety Checks
    if p["daily_loss"] >= TOPSTEP["max_daily_loss"]:
        risk["kill_switch"] = True
        log(f"KILL SWITCH: Daily loss limit ${TOPSTEP['max_daily_loss']} reached", "error")

    if p["trailing_dd"] >= TOPSTEP["trailing_dd_limit"]:
        risk["kill_switch"] = True
        log(f"KILL SWITCH: Trailing DD ${TOPSTEP['trailing_dd_limit']} reached", "error")

# ── Poll Loop ──────────────────────────────────────────────────────────────

async def poll_loop():
    try: await login()
    except Exception as e: log(f"Login failed: {e}", "warn")
    await fetch_all()
    while True:
        await asyncio.sleep(60)
        try: await fetch_all()
        except Exception as e: log(str(e), "warn")

async def token_loop():
    while True:
        await asyncio.sleep(50 * 60)
        try: await do_refresh()
        except Exception as e: log(f"Token refresh error: {e}", "warn")

def reset_daily():
    """Jeden Tag um 18:00 ET (23:00 UTC) zurücksetzen."""
    state["pnl"]["daily_loss"] = 0.0
    if risk["kill_switch"] and state["pnl"]["trailing_dd"] < TOPSTEP["trailing_dd_limit"]:
        risk["kill_switch"] = False
        log("Daily reset — Kill switch deactivated")
    log("Daily PnL reset")

async def daily_reset_loop():
    while True:
        now = datetime.utcnow()
        # Reset at 23:00 UTC (18:00 ET)
        next_reset = now.replace(hour=23, minute=0, second=0, microsecond=0)
        if now >= next_reset:
            next_reset += timedelta(days=1)
        await asyncio.sleep((next_reset - now).total_seconds())
        reset_daily()

# ── HTTP API ───────────────────────────────────────────────────────────────

async def handle(scope, receive, send):
    path   = scope["path"]
    method = scope["method"]

    async def respond(data, status=200):
        body = json.dumps(data, default=str).encode()
        await send({"type":"http.response.start","status":status,"headers":[
            [b"content-type",b"application/json"],
            [b"access-control-allow-origin",b"*"],
            [b"access-control-allow-headers",b"*"]]})
        await send({"type":"http.response.body","body":body})

    if method == "OPTIONS":
        await send({"type":"http.response.start","status":204,"headers":[
            [b"access-control-allow-origin",b"*"],
            [b"access-control-allow-methods",b"GET,POST"],
            [b"access-control-allow-headers",b"*"]]})
        await send({"type":"http.response.body","body":b""}); return

    body = b""
    if method == "POST":
        while True:
            msg = await receive(); body += msg.get("body",b"")
            if not msg.get("more_body"): break

    if path == "/health":
        await respond({"ok": True, "logged_in": bool(auth["access_token"]),
                       "last_update": state["last_update"]})

    elif path == "/algo/state":
        await respond({
            "bias":       state["bias"],
            "signal":     state["signal"],
            "gates":      state["gates"],
            "kelly":      state["kelly"],
            "dependency": state["dependency"],
            "gex":        state["gex"],
            "macro":      state["macro"],
            "cot":        state["cot"],
            "session":    state["session"],
            "prices":     state["prices"],
            "pnl":        state["pnl"],
            "news_blackout": state["news_blackout"],
            "blackout_reason": state["blackout_reason"],
            "trades":     state["trades"][:50],
            "log":        state["log"][:40],
            "risk":       risk,
            "topstep":    TOPSTEP,
            "last_update": state["last_update"],
        })

    elif path == "/algo/risk" and method == "POST":
        data = json.loads(body)
        risk.update({k: v for k, v in data.items() if k in risk})
        compute_kelly(); evaluate_signal()
        log(f"Risk updated: {data}")
        await respond({"ok": True, "risk": risk})

    elif path == "/algo/gates" and method == "POST":
        data = json.loads(body)
        gates_cfg.update({k: bool(v) for k, v in data.items() if k in gates_cfg})
        evaluate_signal()
        await respond({"ok": True})

    elif path == "/algo/kill" and method == "POST":
        data = json.loads(body)
        risk["kill_switch"] = bool(data.get("active", False))
        log(f"Kill switch: {'ON ⛔' if risk['kill_switch'] else 'OFF ✓'}",
            "warn" if risk["kill_switch"] else "info")
        evaluate_signal()
        await respond({"ok": True, "kill_switch": risk["kill_switch"]})

    elif path == "/algo/trade" and method == "POST":
        # Dashboard meldet manuell ausgeführten Trade
        data = json.loads(body)
        record_trade(
            direction  = data.get("direction", "long"),
            entry      = float(data.get("entry", 0)),
            exit_price = float(data.get("exit", 0)),
            contracts  = int(data.get("contracts", 1)),
            conf       = float(data.get("conf", 0)),
            regime     = data.get("regime", "—"),
        )
        await respond({"ok": True, "pnl": state["pnl"]})

    elif path == "/algo/refresh" and method == "POST":
        await fetch_all()
        await respond({"ok": True, "last_update": state["last_update"]})

    elif path == "/algo/news" and method == "POST":
        # News Event hinzufügen/entfernen
        data = json.loads(body)
        if data.get("add"):
            NEWS_EVENTS.append(data["add"])
            log(f"News event added: {data['add']}")
        check_news_blackout()
        await respond({"ok": True, "events": NEWS_EVENTS})

    else:
        await respond({"error": "not found"}, 404)


class App:
    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            await handle(scope, receive, send)

async def main():
    import uvicorn
    config = uvicorn.Config(App(), host="0.0.0.0", port=PORT, log_level="warning")
    server = uvicorn.Server(config)
    log(f"ES Algo v3 — PORT {PORT} — Kelly+Dependency+NewsFilter+Partials")
    await asyncio.gather(poll_loop(), token_loop(), daily_reset_loop(), server.serve())

if __name__ == "__main__":
    asyncio.run(main())
