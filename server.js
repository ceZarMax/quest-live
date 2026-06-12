const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");
const https   = require("https");

// Charge .env si présent
try { require("dotenv").config(); } catch(e) {}

// ════════════════════════════════════════════
//  EBAY AUTO-SYNC CONFIG
//  Remplis ces valeurs dans un fichier .env
//  ou directement ici pour tester
// ════════════════════════════════════════════

const EBAY_CLIENT_ID     = process.env.EBAY_CLIENT_ID     || "TON_CLIENT_ID";
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || "TON_CLIENT_SECRET";
const EBAY_REFRESH_TOKEN = process.env.EBAY_REFRESH_TOKEN || "TON_REFRESH_TOKEN";

// Intervalle de polling en ms
const EBAY_POLL_INTERVAL = 10_000;

// Activer/désactiver le polling (false = mode manuel uniquement)
let ebayAutoSync = false;
let ebayAccessToken = null;
let ebayTokenExpiry = 0;
let ebayPollTimer   = null;

// IDs de commandes déjà traitées (évite les doublons)
const processedOrderIds = new Set();

// Timestamp de démarrage du live (pour ne récupérer que les nouvelles commandes)
let liveStartTime = null;

// ── Détection de langue via le titre de l'article
function detectLangFromTitle(title) {
  const t = (title || "").toUpperCase();
  if (t.includes(" JP") || t.includes("JAPONAIS") || t.includes("JAPANESE")) return "jp";
  if (t.includes(" CN") || t.includes("CHINOIS")  || t.includes("CHINESE"))  return "cn";
  if (t.includes(" KR") || t.includes("CORÉEN")   || t.includes("KOREAN"))   return "kr";
  if (t.includes(" ID") || t.includes("INDONÉSIEN")|| t.includes("INDONESIAN")) return "id";
  return null; // fallback → timer actif
}

// ── Refresh du token OAuth eBay
async function refreshEbayToken() {
  return new Promise((resolve, reject) => {
    const creds   = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString("base64");
    const body    = `grant_type=refresh_token&refresh_token=${encodeURIComponent(EBAY_REFRESH_TOKEN)}&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope%2Fsell.fulfillment.readonly`;

    const options = {
      hostname: "api.ebay.com",
      path:     "/identity/v1/oauth2/token",
      method:   "POST",
      headers:  {
        "Content-Type":  "application/x-www-form-urlencoded",
        "Authorization": `Basic ${creds}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            ebayAccessToken = json.access_token;
            ebayTokenExpiry = Date.now() + (json.expires_in - 60) * 1000;
            console.log("✅ eBay token refreshed");
            resolve(ebayAccessToken);
          } else {
            reject(new Error("Token refresh failed: " + data));
          }
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Récupère un token valide (refresh si expiré)
async function getEbayToken() {
  if (!ebayAccessToken || Date.now() >= ebayTokenExpiry) {
    await refreshEbayToken();
  }
  return ebayAccessToken;
}

// ── Appel API eBay Orders
async function fetchNewOrders() {
  const token = await getEbayToken();

  // Filtre : commandes modifiées depuis le début du live
  const since = new Date(liveStartTime).toISOString();
  const path  = `/sell/fulfillment/v1/order?filter=lastModifiedDate:[${since}..${new Date().toISOString()}]&limit=50&orderBy=LAST_MODIFIED_DATE`;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.ebay.com",
      path,
      method:  "GET",
      headers: {
        "Authorization":  `Bearer ${token}`,
        "Content-Type":   "application/json",
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_FR",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ── Traitement des nouvelles commandes
async function pollEbayOrders() {
  if (!ebayAutoSync || !liveStartTime) return;

  try {
    const result = await fetchNewOrders();
    const orders = result.orders || [];

    for (const order of orders) {
      const orderId = order.orderId;
      if (processedOrderIds.has(orderId)) continue;

      // Statut : seulement les commandes payées
      const isPaid = order.orderFulfillmentStatus !== "NOT_STARTED" ||
                     order.paymentSummary?.payments?.[0]?.paymentStatus === "PAID";
      if (!isPaid) continue;

      processedOrderIds.add(orderId);

      const buyer  = order.buyer?.username || "Inconnu";
      const amount = parseFloat(order.pricingSummary?.total?.value || 0);
      if (amount <= 0) continue;

      // Détecte la langue via les titres des articles
      const titles = (order.lineItems || []).map(i => i.title || "").join(" ");
      let lang = detectLangFromTitle(titles);

      // Fallback : langue du timer actif
      if (!lang) lang = currentTimerLang || "jp";

      console.log(`🛒 Auto-achat: ${buyer} +${amount}€ [${lang}] — ${titles.slice(0,40)}`);

      // Injecte dans le système comme un achat manuel
      io.emit("purchase", processPurchase(buyer, amount, lang));
    }
  } catch (err) {
    console.error("eBay poll error:", err.message);
  }
}

// ── Démarre/arrête le polling
function startEbaySync() {
  if (ebayPollTimer) clearInterval(ebayPollTimer);
  liveStartTime = Date.now() - 60_000; // remonte 1 min en arrière au démarrage
  processedOrderIds.clear();
  ebayAutoSync = true;
  ebayPollTimer = setInterval(pollEbayOrders, EBAY_POLL_INTERVAL);
  console.log("✅ eBay auto-sync démarré");
  pollEbayOrders(); // premier appel immédiat
}

function stopEbaySync() {
  if (ebayPollTimer) { clearInterval(ebayPollTimer); ebayPollTimer = null; }
  ebayAutoSync = false;
  console.log("⏹ eBay auto-sync arrêté");
}

// Langue du timer actif (mis à jour par le socket timerLangChange)
let currentTimerLang = "jp";

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

const players = {};

let RANKS = [
  { threshold: 0,   emoji: "🌱",  name: "Explorateur"            },
  { threshold: 50,  emoji: "🗺️",  name: "Baroudeur du Quest Land" },
  { threshold: 100, emoji: "🛡️",  name: "Gardien du Quest Land"   },
  { threshold: 200, emoji: "⚔️",  name: "Champion du Quest Land"  },
  { threshold: 300, emoji: "👑",  name: "Seigneur du Quest Land"  },
  { threshold: 500, emoji: "🏆",  name: "Roi du Quest Land"       },
];

function getRank(total) {
  let rank = RANKS[0];
  for (const r of RANKS) { if (total >= r.threshold) rank = r; }
  return rank;
}

function getNextRank(total) {
  for (const r of RANKS) { if (r.threshold > total) return r; }
  return null;
}

app.use(express.static("public"));
app.use(express.json());

// CORS pour l'extension Chrome (ebay.fr → localhost)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Endpoint reçoit les achats de l'extension Chrome
app.post("/ebay-purchase", (req, res) => {
  const { user, amount, lang, title, source } = req.body;
  if (!user || !amount) return res.status(400).json({ error: "Missing user or amount" });

  const detectedLang = lang || currentTimerLang || "jp";
  const result = processPurchase(user.toUpperCase(), Number(amount), detectedLang);

  io.emit("purchase", result);
  console.log(`🛒 [Extension] ${user} +${amount}€ [${detectedLang}] — ${title || ""}`);

  res.json({ ok: true, user: result.user, amount: result.amount, lang: detectedLang });
});

// Palier passeport configurable (défaut 10€ par langue)
let passportThreshold = 10;

// ── Logique achat (partagée entre socket manuel et eBay auto)
function processPurchase(user, amount, lang) {
  const amountNum = Number(amount);

  if (!players[user]) {
    players[user] = {
      total: 0,
      langSpent: { jp: 0, cn: 0, id: 0, kr: 0 },
      passport:  { jp: false, cn: false, id: false, kr: false },
      passportCompletions: 0,
    };
  }

  const player  = players[user];
  const oldRank = getRank(player.total);

  player.total += amountNum;
  const oldStamp = player.passport[lang];
  player.langSpent[lang] += amountNum;
  if (player.langSpent[lang] >= passportThreshold) player.passport[lang] = true;

  const newStamp          = player.passport[lang];
  const stampUnlocked     = !oldStamp && newStamp;
  const passportCount     = Object.values(player.passport).filter(v => v).length;
  const passportCompleted = passportCount === 4;
  const newRank           = getRank(player.total);
  const rankUp            = newRank.threshold > oldRank.threshold;
  const nextRank          = getNextRank(player.total);

  return {
    user, amount: amountNum, lang,
    total: player.total,
    passport: player.passport,
    langSpent: player.langSpent,
    stampUnlocked, passportCount, passportCompleted,
    passportCompletions: player.passportCompletions || 0,
    rank: newRank, rankUp, nextRank,
  };
}

io.on("connection", (socket) => {
  console.log("Client connecté");
  socket.emit("init", players);
  socket.emit("passportThresholdUpdate", { threshold: passportThreshold });

  socket.on("resetPassport", (data) => {
    const { user } = data;
    if (!players[user]) return;
    players[user].langSpent = { jp: 0, cn: 0, id: 0, kr: 0 };
    players[user].passport  = { jp: false, cn: false, id: false, kr: false };
    players[user].passportCompletions = (players[user].passportCompletions || 0) + 1;
    const rank     = getRank(players[user].total);
    const nextRank = getNextRank(players[user].total);
    io.emit("resetPassport", {
      user,
      total: players[user].total,
      passport: players[user].passport,
      langSpent: players[user].langSpent,
      passportCount: 0, passportCompleted: false,
      passportCompletions: players[user].passportCompletions,
      rank, nextRank,
    });
  });

  // ── Timer langue : relay dashboard → overlay
  socket.on("timerUpdate",        (data) => socket.broadcast.emit("timerUpdate", data));
  socket.on("timerTick",          (data) => socket.broadcast.emit("timerTick", data));
  socket.on("timerLangChange",    (data) => socket.broadcast.emit("timerLangChange", data));
  socket.on("timerStop",          (data) => socket.broadcast.emit("timerStop", data));
  socket.on("timerPause",         (data) => socket.broadcast.emit("timerPause", data));
  socket.on("timerResume",        (data) => socket.broadcast.emit("timerResume", data));
  socket.on("leaderboardConfig",  (data) => socket.broadcast.emit("leaderboardConfig", data));
  socket.on("showLeaderboard",    (data) => io.emit("showLeaderboard", data));
  socket.on("sidebarConfig",      (data) => socket.broadcast.emit("sidebarConfig", data));

  // ── eBay Auto-Sync
  socket.on("ebayStartSync", () => {
    startEbaySync();
    io.emit("ebaySyncStatus", { active: true });
  });

  socket.on("ebayStopSync", () => {
    stopEbaySync();
    io.emit("ebaySyncStatus", { active: false });
  });

  socket.emit("ebaySyncStatus", { active: ebayAutoSync });

  // ── Suivi langue timer pour fallback
  socket.on("timerLangChange", (data) => {
    if (data.lang) currentTimerLang = data.lang;
    socket.broadcast.emit("timerLangChange", data);
  });
  socket.on("questLaunch",  (data) => socket.broadcast.emit("questLaunch",  data));
  socket.on("questUpdate",  (data) => socket.broadcast.emit("questUpdate",  data));
  socket.on("questEnd",     (data) => socket.broadcast.emit("questEnd",     data));

  // ── Config paliers de rang
  socket.on("setRankThresholds", (data) => {
    if (!Array.isArray(data.thresholds)) return;
    data.thresholds.forEach((t, i) => {
      if (RANKS[i] && i > 0) RANKS[i].threshold = parseInt(t) || RANKS[i].threshold;
    });
    io.emit("rankThresholdsUpdate", { thresholds: RANKS.map(r => r.threshold) });
    console.log("Paliers rangs:", RANKS.map(r => `${r.name}: ${r.threshold}€`).join(", "));
  });

  socket.emit("rankThresholdsUpdate", { thresholds: RANKS.map(r => r.threshold) });

  socket.on("purchase", (data) => {
    const { user, amount, lang } = data;
    io.emit("purchase", processPurchase(user, amount, lang));
  });
  socket.on("setPassportThreshold", (data) => {
    const val = parseInt(data.threshold);
    if (val > 0) {
      passportThreshold = val;
      io.emit("passportThresholdUpdate", { threshold: passportThreshold });
      console.log("Palier passeport:", passportThreshold + "€");
    }
  });

  // ── Volume : relay dashboard → overlay
  socket.on("setVolume", (data) => {
    socket.broadcast.emit("setVolume", data);
  });

  // ── Spin roue : le dashboard envoie les paramètres, le serveur rebroadcast à tous (overlay inclus)
  socket.on("spinWheel", (data) => {
    // data : { user, rewards (normalisés), winIndex, targetAngle, duration }
    io.emit("spinWheel", data);
  });
});

server.listen(3000, () => {
  console.log("Quest Live lancé sur http://localhost:3000");
});