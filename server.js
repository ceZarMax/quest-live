const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const players = {};

const RANKS = [
  { threshold: 0,   emoji: "🌱", name: "Explorateur" },
  { threshold: 50,  emoji: "🗺️", name: "Baroudeur du Quest Land" },
  { threshold: 100, emoji: "🛡️", name: "Gardien du Quest Land" },
  { threshold: 150, emoji: "⚔️", name: "Champion du Quest Land" },
  { threshold: 250, emoji: "👑", name: "Seigneur du Quest Land" },
  { threshold: 350, emoji: "🏆", name: "Roi du Quest Land" },
];

function getRank(total) {
  let rank = RANKS[0];
  for (const r of RANKS) {
    if (total >= r.threshold) rank = r;
  }
  return rank;
}

function getNextRank(total) {
  for (const r of RANKS) {
    if (r.threshold > total) return r;
  }
  return null;
}

app.use(express.static("public"));

io.on("connection", (socket) => {
  console.log("Client connecté");

  // Envoie l'état actuel à tout nouveau client (dashboard rechargé)
  socket.emit("init", players);

  socket.on("purchase", (data) => {
    const { user, amount, lang } = data;
    const amountNum = Number(amount);

    if (!players[user]) {
      players[user] = {
        total: 0,
        langSpent: { jp: 0, cn: 0, id: 0, kr: 0 },
        passport: { jp: false, cn: false, id: false, kr: false },
      };
    }

    const player = players[user];
    const oldRank = getRank(player.total);

    player.total += amountNum;
    const oldStamp = player.passport[lang];
    player.langSpent[lang] += amountNum;

    if (player.langSpent[lang] >= 10) {
      player.passport[lang] = true;
    }

    const newStamp = player.passport[lang];
    const stampUnlocked = !oldStamp && newStamp;
    const passportCount = Object.values(player.passport).filter(v => v).length;
    const passportCompleted = passportCount === 4;
    const newRank = getRank(player.total);
    const rankUp = newRank.threshold > oldRank.threshold;
    const nextRank = getNextRank(player.total);

    io.emit("purchase", {
      user,
      amount: amountNum,
      lang,
      total: player.total,
      passport: player.passport,
      langSpent: player.langSpent,
      stampUnlocked,
      passportCount,
      passportCompleted,
      rank: newRank,
      rankUp,
      nextRank,
    });
  });

  socket.on("resetPassport", (data) => {
    const { user } = data;
    if (!players[user]) return;

    players[user].langSpent = { jp: 0, cn: 0, id: 0, kr: 0 };
    players[user].passport = { jp: false, cn: false, id: false, kr: false };

    const rank = getRank(players[user].total);
    const nextRank = getNextRank(players[user].total);

    io.emit("resetPassport", {
      user,
      total: players[user].total,
      passport: players[user].passport,
      langSpent: players[user].langSpent,
      passportCount: 0,
      passportCompleted: false,
      rank,
      nextRank,
    });
  });
});

server.listen(3000, () => {
  console.log("Quest Live lancé sur http://localhost:3000");
});
