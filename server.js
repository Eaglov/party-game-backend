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
const io = new Server(server, {
  cors: {
    origin: "https://game-front-two.vercel.app", // твой фронт
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const BASE_URL = "https://game-front-two.vercel.app"; // твой фронт
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply('Welcome! Click below to open the game.', {
    reply_markup: {
      inline_keyboard: [[{ text: 'Open Party Game', web_app: { url: `${BASE_URL}/webapp.html` } }]]
    }
  });
});

const rooms = {}; // { roomId: { players: [] } }

io.on('connection', (socket) => {
    console.log("Client connected:", socket.id);

    socket.on('joinRoom', ({ roomId, playerName }) => {
        console.log("joinRoom", roomId, playerName);

        if (!rooms[roomId]) {
            rooms[roomId] = { players: [] };
        }
        rooms[roomId].players.push({ id: socket.id, name: playerName });
        socket.join(roomId);

        io.to(roomId).emit('roomJoined', rooms[roomId].players);
        io.to(roomId).emit('playerListUpdate', rooms[roomId].players);
    });

    socket.on('startGame', (roomId) => {
        console.log("startGame triggered for room:", roomId);
        const question = "Какой-то тестовый вопрос"; // здесь можно грузить из файла
        io.to(roomId).emit('gameStarted', { question });
    });
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('joinRoom', ({ roomId, playerName }) => {
    console.log('joinRoom', roomId, playerName);

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


