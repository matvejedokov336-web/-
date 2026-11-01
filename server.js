const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

const rooms = new Map();
const WIDTH = 960, HEIGHT = 540;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
function freshPlayer(id, side) {
  return {
    id, side,
    x: side === 1 ? 145 : 815,
    y: 270,
    hits: 0,
    cover: false,
    throwAt: 0,
    cooldown: 0
  };
}
function resetRoom(room) {
  room.balls = [];
  room.gameOver = false;
  room.winner = null;
  room.lastTick = Date.now();
  let i = 1;
  for (const p of room.players.values()) {
    Object.assign(p, freshPlayer(p.id, i));
    i++;
  }
}
function publicState(room) {
  return {
    players: [...room.players.values()].map(p => ({
      id: p.id, side: p.side, x: p.x, y: p.y, hits: p.hits,
      cover: p.cover, throwAt: p.throwAt
    })),
    balls: room.balls.map(b => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, id: b.id })),
    gameOver: room.gameOver,
    winner: room.winner,
    started: room.players.size === 2
  };
}
function sendState(room) {
  io.to(room.code).emit("state", publicState(room));
}
function removePlayer(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  room.players.delete(socket.id);
  socket.leave(code);
  socket.data.roomCode = null;
  if (room.players.size === 0) rooms.delete(code);
  else {
    room.gameOver = true;
    room.winner = [...room.players.values()][0].id;
    io.to(code).emit("opponentLeft");
    sendState(room);
  }
}

io.on("connection", socket => {
  socket.on("createRoom", () => {
    removePlayer(socket);
    let code;
    do { code = makeCode(); } while (rooms.has(code));
    const room = { code, players: new Map(), balls: [], gameOver: false, winner: null, lastTick: Date.now() };
    room.players.set(socket.id, freshPlayer(socket.id, 1));
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit("roomJoined", { code, playerId: socket.id, side: 1 });
    sendState(room);
  });

  socket.on("joinRoom", rawCode => {
    const code = String(rawCode || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const room = rooms.get(code);
    if (!room) return socket.emit("joinError", "Комната не найдена. Проверь код.");
    if (room.players.size >= 2) return socket.emit("joinError", "В комнате уже два игрока.");
    if (socket.data.roomCode) removePlayer(socket);
    room.players.set(socket.id, freshPlayer(socket.id, 2));
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit("roomJoined", { code, playerId: socket.id, side: 2 });
    sendState(room);
  });

  socket.on("input", input => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.gameOver) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.input = {
      left: !!input.left, right: !!input.right,
      up: !!input.up, down: !!input.down,
      throw: !!input.throw, cover: !!input.cover
    };
  });

  socket.on("rematch", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.players.size !== 2) return;
    resetRoom(room);
    sendState(room);
  });

  socket.on("disconnect", () => removePlayer(socket));
});

let ballId = 0;
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const dt = Math.min(0.05, (now - room.lastTick) / 1000);
    room.lastTick = now;
    if (room.players.size !== 2 || room.gameOver) continue;

    const players = [...room.players.values()];
    for (const p of players) {
      const input = p.input || {};
      let dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      let dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
      const len = Math.hypot(dx, dy) || 1;
      const shielding = input.cover;
      const speed = shielding ? 105 : 235;
      p.cover = shielding;
      p.x = clamp(p.x + dx / len * speed * dt, 55, WIDTH - 55);
      p.y = clamp(p.y + dy / len * speed * dt, 105, HEIGHT - 75);

      if (input.throw && now - p.cooldown > 720) {
        const enemy = players.find(other => other.id !== p.id);
        const vx = enemy.x - p.x, vy = enemy.y - p.y;
        const dist = Math.hypot(vx, vy) || 1;
        room.balls.push({
          id: ++ballId,
          x: p.x + (p.side === 1 ? 28 : -28),
          y: p.y - 12,
          vx: vx / dist * 570,
          vy: vy / dist * 570,
          owner: p.id
        });
        p.cooldown = now;
        p.throwAt = now;
      }
    }

    for (const b of room.balls) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }
    room.balls = room.balls.filter(b => b.x > -30 && b.x < WIDTH + 30 && b.y > -30 && b.y < HEIGHT + 30);

    for (const b of [...room.balls]) {
      const target = players.find(p => p.id !== b.owner);
      if (!target) continue;
      if (Math.hypot(target.x - b.x, (target.y - 8) - b.y) < (target.cover ? 31 : 29)) {
        room.balls = room.balls.filter(item => item.id !== b.id);
        if (!target.cover) {
          target.hits += 1;
          io.to(room.code).emit("hit", { x: target.x, y: target.y, hits: target.hits });
          if (target.hits >= 5) {
            room.gameOver = true;
            room.winner = b.owner;
          }
        } else {
          io.to(room.code).emit("blocked", { x: target.x, y: target.y });
        }
      }
    }
    sendState(room);
  }
}, 33);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Snowball Fight listening on ${PORT}`));
