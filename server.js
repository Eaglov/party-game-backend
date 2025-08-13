require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const questions = JSON.parse(fs.readFileSync('questions_40_1.json', 'utf8'));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const BASE_URL = process.env.BASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const bot = new Telegraf(BOT_TOKEN);

// При старте бота отправляем ссылку на фронт (Vercel)
bot.start((ctx) => {
  ctx.reply('Welcome! Click below to open the game.', {
    reply_markup: {
      inline_keyboard: [[{ text: 'Open Party Game', web_app: { url: `${BASE_URL}` } }]]
    }
  });
});

let rooms = {};

// Логика подключения игроков
io.on('connection', (socket) => {
  socket.on('joinRoom', ({ roomId, playerName }) => {
    socket.join(roomId);
    if (!rooms[roomId]) {
      rooms[roomId] = { players: [], questions: [], answers: [] };
    }
    rooms[roomId].players.push({ id: socket.id, name: playerName });
    io.to(roomId).emit('updatePlayers', rooms[roomId].players);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  bot.launch();
});