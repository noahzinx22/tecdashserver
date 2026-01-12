// TecDash Online API (Render friendly) - minimal + JSON storage
import express from "express";
import cors from "cors";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR || "./data";
const DB_PATH = path.join(DATA_DIR, "players.json");

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}
ensureDataDir();

function loadDb() {
  try {
    const raw = fs.readFileSync(DB_PATH, "utf-8");
    const data = JSON.parse(raw);
    const db = (data && typeof data === "object") ? data : {};
    // Backwards-compatible normalization / migration.
    for (const k of Object.keys(db)) {
      db[k] = normalizePlayer(db[k]);
      db[k].playerId = String(db[k].playerId || k);
    }
    return db;
  } catch (_) {
    return {};
  }
}

function saveDb(db) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
  } catch (e) {
    console.error("DB save failed", e);
  }
}

function nowIso() { return new Date().toISOString(); }

function cleanNick(nick) {
  const n = String(nick || "").trim();
  if (!n) return "";
  if (n.length < 3 || n.length > 16) return "";
  if (!/^[A-Za-z0-9_]+$/.test(n)) return "";
  return n;
}

function safeSkinSrc(src) {
  const s = String(src || "").trim();
  if (s === "assets/player.png") return s;
  if (s && /^assets\/skins\/[A-Za-z0-9_\-]+\.png$/.test(s)) return s;
  return "assets/player.png";
}

function clampInt(v, min=0, max=2_000_000_000) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function randGroup(len=4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing 0/1/O/I
  let s = "";
  for (let i=0;i<len;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

function makeRecoveryCode(nick) {
  const prefixRaw = (nick || "TECDASH").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const prefix = (prefixRaw.slice(0,4).padEnd(4,"X"));
  return `${prefix}-${randGroup(4)}-${randGroup(4)}`;
}


function clampTs(v, min=0, max=9_000_000_000_000_000) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function safeSkinId(id) {
  const s = String(id || "").trim();
  if (!s) return "";
  if (!/^[a-z0-9_\-]{1,32}$/i.test(s)) return "";
  return s.toLowerCase();
}

function safeOwnedSkins(arr) {
  const out = [];
  const seen = new Set();
  const push = (x) => { if (x && !seen.has(x)) { seen.add(x); out.push(x); } };

  if (Array.isArray(arr)) {
    for (const item of arr) {
      const sid = safeSkinId(item);
      if (sid) push(sid);
      if (out.length >= 64) break;
    }
  }

  // Always include default
  if (!seen.has("default")) out.unshift("default");
  return out;
}

function isoToEpochMs(iso) {
  const t = Date.parse(String(iso || ""));
  return Number.isFinite(t) ? t : 0;
}

function normalizePlayer(rec) {
  const r = (rec && typeof rec === "object") ? rec : {};
  const out = { ...r };

  out.nick = cleanNick(out.nick) || "Player";
  out.skinSrc = safeSkinSrc(out.skinSrc);

  out.orbsTotal = clampInt(out.orbsTotal, 0);
  out.deathsTotal = clampInt(out.deathsTotal, 0);

  out.walletOrbs = clampInt(out.walletOrbs, 0);
  out.ownedSkins = safeOwnedSkins(out.ownedSkins);

  const baseTs = isoToEpochMs(out.updatedAt) || isoToEpochMs(out.createdAt) || Date.now();
  out.invUpdatedAt = clampTs(out.invUpdatedAt, 0);
  if (!out.invUpdatedAt) out.invUpdatedAt = baseTs;

  out.createdAt = String(out.createdAt || nowIso());
  out.updatedAt = String(out.updatedAt || nowIso());
  return out;
}


async function qrDataUrl(text) {
  try {
    return await QRCode.toDataURL(text, { margin: 1, scale: 6 });
  } catch (_) {
    return "";
  }
}

function leaderboardFromDb(db) {
  const players = Object.values(db);
  players.sort((a,b) => (b.orbsTotal - a.orbsTotal) || (a.updatedAt < b.updatedAt ? 1 : -1));
  return players;
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, t: nowIso() });
});

app.post("/register", async (req, res) => {
  const { playerId, token, nick, skinSrc, orbsTotal, deathsTotal, walletOrbs, ownedSkins, invUpdatedAt } = req.body || {};
  if (!playerId || !token) return res.status(400).json({ ok:false });

  const db = loadDb();
  const pid = String(playerId);
  const tok = String(token);

  const prev = db[pid];
  if (prev && prev.token && prev.token !== tok) {
    // Don't allow takeover without recovery code
    return res.status(401).json({ ok:false, reason:"token_mismatch" });
  }

  const cn = cleanNick(nick);
  const recCode = prev?.recoveryCode || makeRecoveryCode(cn || "TECD");

  const incomingInvAt = clampTs(invUpdatedAt, 0);
  const prevInvAt = clampTs(prev?.invUpdatedAt, 0);

  // Inventory sync is "newer wins" (prevents wiping server state after a local reset).
  let finalWallet = clampInt(prev?.walletOrbs ?? 0, 0);
  let finalOwned = safeOwnedSkins(prev?.ownedSkins);
  let finalInvAt = prevInvAt || (isoToEpochMs(prev?.updatedAt) || Date.now());

  if (!prev) {
    finalWallet = clampInt(walletOrbs, 0);
    finalOwned = safeOwnedSkins(ownedSkins);
    finalInvAt = incomingInvAt || Date.now();
  } else if (incomingInvAt > prevInvAt) {
    finalWallet = clampInt(walletOrbs, 0);
    finalOwned = safeOwnedSkins(ownedSkins);
    finalInvAt = incomingInvAt;
  }

  const record = {
    playerId: pid,
    token: tok,
    nick: cn || prev?.nick || "Player",
    skinSrc: safeSkinSrc(skinSrc || prev?.skinSrc),

    // Never decrease lifetime stats on the server.
    orbsTotal: Math.max(clampInt(prev?.orbsTotal ?? 0, 0), clampInt(orbsTotal, 0)),
    deathsTotal: Math.max(clampInt(prev?.deathsTotal ?? 0, 0), clampInt(deathsTotal, 0)),

    walletOrbs: finalWallet,
    ownedSkins: finalOwned,
    invUpdatedAt: finalInvAt,

    recoveryCode: recCode,
    createdAt: prev?.createdAt || nowIso(),
    updatedAt: nowIso()
  };

  db[pid] = record;
  saveDb(db);

  return res.json({
    ok:true,
    recoveryCode: record.recoveryCode,
    walletOrbs: record.walletOrbs,
    ownedSkins: record.ownedSkins,
    invUpdatedAt: record.invUpdatedAt
    // Keep QR generation opt-in (client can request /me)
  });
});

app.post("/sync", async (req, res) => {
  const { playerId, token, nick, skinSrc, orbsTotal, deathsTotal, walletOrbs, ownedSkins, invUpdatedAt } = req.body || {};
  if (!playerId || !token) return res.status(400).json({ ok:false });

  const db = loadDb();
  const pid = String(playerId);
  const tok = String(token);

  const prev = db[pid];
  if (!prev) return res.status(404).json({ ok:false, reason:"not_registered" });
  if (prev.token !== tok) return res.status(401).json({ ok:false, reason:"token_mismatch" });

  const cn = cleanNick(nick) || prev.nick;

  const incomingInvAt = clampTs(invUpdatedAt, 0);
  const prevInvAt = clampTs(prev?.invUpdatedAt, 0);

  let finalWallet = clampInt(prev?.walletOrbs ?? 0, 0);
  let finalOwned = safeOwnedSkins(prev?.ownedSkins);
  let finalInvAt = prevInvAt || (isoToEpochMs(prev?.updatedAt) || Date.now());

  if (incomingInvAt > prevInvAt) {
    finalWallet = clampInt(walletOrbs, 0);
    finalOwned = safeOwnedSkins(ownedSkins);
    finalInvAt = incomingInvAt;
  }

  const updated = normalizePlayer({
    ...prev,
    nick: cn,
    skinSrc: safeSkinSrc(skinSrc || prev.skinSrc),

    // Never decrease lifetime stats.
    orbsTotal: Math.max(clampInt(prev?.orbsTotal ?? 0, 0), clampInt(orbsTotal, 0)),
    deathsTotal: Math.max(clampInt(prev?.deathsTotal ?? 0, 0), clampInt(deathsTotal, 0)),

    walletOrbs: finalWallet,
    ownedSkins: finalOwned,
    invUpdatedAt: finalInvAt,

    updatedAt: nowIso()
  });

  db[pid] = updated;
  saveDb(db);

  return res.json({
    ok:true,
    walletOrbs: updated.walletOrbs,
    ownedSkins: updated.ownedSkins,
    invUpdatedAt: updated.invUpdatedAt,
    orbsTotal: updated.orbsTotal,
    deathsTotal: updated.deathsTotal,
    nick: updated.nick,
    skinSrc: updated.skinSrc
  });
});

app.get("/leaderboard", (req, res) => {
  const pid = String(req.query.playerId || "");
  const db = loadDb();
  const list = leaderboardFromDb(db);

  const top10 = list.slice(0, 10).map(p => ({
    playerId: p.playerId,
    nick: p.nick,
    skinSrc: p.skinSrc,
    orbsTotal: p.orbsTotal,
    deathsTotal: p.deathsTotal
  }));

  let you = null;
  if (pid) {
    const idx = list.findIndex(p => p.playerId === pid);
    if (idx >= 0) {
      const p = list[idx];
      you = {
        playerId: p.playerId,
        nick: p.nick,
        skinSrc: p.skinSrc,
        orbsTotal: p.orbsTotal,
        deathsTotal: p.deathsTotal,
        rank: idx + 1
      };
    } else {
      you = null;
    }
  }

  res.json({ ok:true, top10, you });
});

app.get("/me", async (req, res) => {
  const pid = String(req.query.playerId || "");
  const tok = String(req.query.token || "");
  if (!pid || !tok) return res.status(400).json({ ok:false });

  const db = loadDb();
  const p = db[pid];
  if (!p) return res.status(404).json({ ok:false });
  if (p.token !== tok) return res.status(401).json({ ok:false });

  const dataUrl = await qrDataUrl(p.recoveryCode);
  res.json({
    ok:true,
    recoveryCode: p.recoveryCode,
    qrDataUrl: dataUrl,
    nick: p.nick,
    skinSrc: p.skinSrc,
    orbsTotal: p.orbsTotal,
    deathsTotal: p.deathsTotal,
    walletOrbs: p.walletOrbs,
    ownedSkins: p.ownedSkins,
    invUpdatedAt: p.invUpdatedAt
  });
});

app.post("/recover", async (req, res) => {
  const { recoveryCode } = req.body || {};
  const code = String(recoveryCode || "").trim();
  if (!code) return res.status(400).json({ ok:false });

  const db = loadDb();
  const players = Object.values(db);
  const p = players.find(x => x.recoveryCode === code);
  if (!p) return res.status(404).json({ ok:false });

  // rotate token on recovery (safer)
  const newToken = "t_" + randGroup(8) + randGroup(8) + randGroup(8);
  const updated = { ...p, token: newToken, updatedAt: nowIso() };
  db[p.playerId] = updated;
  saveDb(db);

  res.json({
    ok:true,
    playerId: updated.playerId,
    token: updated.token,
    nick: updated.nick,
    skinSrc: updated.skinSrc,
    orbsTotal: updated.orbsTotal,
    deathsTotal: updated.deathsTotal,
    walletOrbs: updated.walletOrbs,
    ownedSkins: updated.ownedSkins,
    invUpdatedAt: updated.invUpdatedAt,
    recoveryCode: updated.recoveryCode
  });
});


app.post("/delete", (req, res) => {
  const { playerId, token } = req.body || {};
  if (!playerId || !token) return res.status(400).json({ ok:false });

  const db = loadDb();
  const pid = String(playerId);
  const tok = String(token);

  const prev = db[pid];
  if (!prev) return res.status(404).json({ ok:false, reason:"not_found" });
  if (prev.token !== tok) return res.status(401).json({ ok:false, reason:"token_mismatch" });

  delete db[pid];
  saveDb(db);
  return res.json({ ok:true });
});

app.listen(PORT, () => {
  console.log("TecDash Online API listening on", PORT);
});
