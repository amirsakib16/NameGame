/**
 * Dots and Boxes - Multiplayer Server
 * Express + Socket.io
 *
 * Run: node server.js
 * Deploy to Railway / Render / Fly.io (free tiers work)
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.static('public')); // optional: serve the HTML from here too

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const DOTS = 8;
const BOXES = DOTS - 1;

// In-memory rooms
const rooms = new Map();

function createEmptyState() {
  return {
    hLines: Array.from({ length: DOTS }, () => Array(BOXES).fill(null)),
    vLines: Array.from({ length: BOXES }, () => Array(DOTS).fill(null)),
    boxes: Array.from({ length: BOXES }, () => Array(BOXES).fill(null)),
    scores: { A: 0, B: 0 },
    currentTurn: 'A',
    gameOver: false,
    players: { A: null, B: null } // socket ids
  };
}

function checkBox(state, r, c, player) {
  const { hLines, vLines, boxes } = state;
  const top = hLines[r][c];
  const bottom = hLines[r + 1][c];
  const left = vLines[r][c];
  const right = vLines[r][c + 1];
  if (top && bottom && left && right && !boxes[r][c]) {
    boxes[r][c] = player;
    state.scores[player]++;
    return true;
  }
  return false;
}

function applyMove(state, type, r, c, player) {
  if (state.gameOver) return false;
  if (type === 'h') {
    if (state.hLines[r][c]) return false;
    state.hLines[r][c] = player;
  } else {
    if (state.vLines[r][c]) return false;
    state.vLines[r][c] = player;
  }

  let completed = false;
  if (type === 'h') {
    if (r > 0) completed = checkBox(state, r - 1, c, player) || completed;
    if (r < BOXES) completed = checkBox(state, r, c, player) || completed;
  } else {
    if (c > 0) completed = checkBox(state, r, c - 1, player) || completed;
    if (c < BOXES) completed = checkBox(state, r, c, player) || completed;
  }

  if (!completed) {
    state.currentTurn = state.currentTurn === 'A' ? 'B' : 'A';
  }

  const total = BOXES * BOXES;
  if (state.scores.A + state.scores.B === total) {
    state.gameOver = true;
  }
  return true;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('createRoom', () => {
    let code;
    do {
      code = generateRoomCode();
    } while (rooms.has(code));

    const state = createEmptyState();
    state.players.A = socket.id;
    rooms.set(code, state);
    socket.join(code);
    socket.emit('roomCreated', { roomId: code, player: 'A' });
    console.log(`Room ${code} created by ${socket.id}`);
  });

  socket.on('joinRoom', (code) => {
    code = (code || '').toUpperCase().trim();
    const state = rooms.get(code);
    if (!state) {
      socket.emit('error', 'Room not found');
      return;
    }
    if (state.players.B) {
      socket.emit('error', 'Room is full');
      return;
    }
    state.players.B = socket.id;
    socket.join(code);
    socket.emit('roomJoined', { roomId: code, player: 'B' });
    // Notify both that game can start
    io.to(code).emit('startGame', {
      hLines: state.hLines,
      vLines: state.vLines,
      boxes: state.boxes,
      scores: state.scores,
      currentTurn: state.currentTurn,
      gameOver: state.gameOver
    });
    console.log(`Player B joined room ${code}`);
  });

  socket.on('move', ({ roomId, type, r, c }) => {
    const state = rooms.get(roomId);
    if (!state) return;

    const player = state.players.A === socket.id ? 'A' : (state.players.B === socket.id ? 'B' : null);
    if (!player || player !== state.currentTurn) {
      socket.emit('error', 'Not your turn');
      return;
    }

    const ok = applyMove(state, type, r, c, player);
    if (!ok) {
      socket.emit('error', 'Invalid move');
      return;
    }

    io.to(roomId).emit('moveMade', {
      type, r, c, player,
      hLines: state.hLines,
      vLines: state.vLines,
      boxes: state.boxes,
      scores: state.scores,
      currentTurn: state.currentTurn,
      gameOver: state.gameOver
    });
  });

  socket.on('newGame', (roomId) => {
    const state = rooms.get(roomId);
    if (!state) return;
    // Keep players, reset board
    const players = { ...state.players };
    Object.assign(state, createEmptyState());
    state.players = players;
    io.to(roomId).emit('startGame', {
      hLines: state.hLines,
      vLines: state.vLines,
      boxes: state.boxes,
      scores: state.scores,
      currentTurn: state.currentTurn,
      gameOver: state.gameOver
    });
  });

  socket.on('leaveRoom', (roomId) => {
    const state = rooms.get(roomId);
    if (!state) return;
    if (state.players.A === socket.id) state.players.A = null;
    if (state.players.B === socket.id) state.players.B = null;
    socket.leave(roomId);
    io.to(roomId).emit('opponentLeft');
    if (!state.players.A && !state.players.B) {
      rooms.delete(roomId);
    }
  });

  socket.on('disconnect', () => {
    // Clean up any rooms this socket was in
    for (const [code, state] of rooms) {
      if (state.players.A === socket.id || state.players.B === socket.id) {
        if (state.players.A === socket.id) state.players.A = null;
        if (state.players.B === socket.id) state.players.B = null;
        io.to(code).emit('opponentLeft');
        if (!state.players.A && !state.players.B) rooms.delete(code);
      }
    }
    console.log('Player disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Dots & Boxes server running on port ${PORT}`);
});