// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// ====== КОНСТАНТЫ ======
const FRONT_ORIGIN = "https://game-front-two.vercel.app";
const PORT = process.env.PORT || 10000;
const ROUND_TIME_MS = 60_000;   // 60 секунд на сбор ответов
const VOTE_STEP_TIMEOUT_MS = 30_000; // таймаут на шаг голосования (чтобы не зависало)
const TOTAL_ROUNDS = 3;
const ALLOWED_EMOJIS = ['😂', '🙂', '💩'];

// ====== Загрузка банка вопросов ======
let QUESTIONS_BANK = [
  "Самая нелепая ситуация в вашей жизни?",
  "Если бы вы стали супергероем на день — что бы сделали?",
  "Какую привычку вы хотели бы убрать у себя?",
  "Какой совет дали бы 10-летнему себе?",
  "Самая странная еда, которую вы пробовали?",
  "Какой навык вы бы прокачали за одну ночь?"
];
try {
  const p = path.join(__dirname, 'questions_40_1.json');
  if (fs.existsSync(p)) {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(data) && data.length) {
      QUESTIONS_BANK = data;
      console.log(`Loaded ${QUESTIONS_BANK.length} questions from questions_40_1.json`);
    }
  }
} catch (e) {
  console.warn("Failed to read questions_40_1.json, using fallback questions.");
}

const app = express();
app.use(cors({ origin: FRONT_ORIGIN }));
app.use(express.json());

// healthcheck для Render
app.get('/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: FRONT_ORIGIN, methods: ["GET", "POST"], credentials: true }
});

// ====== СТРУКТУРА ДАННЫХ КОМНАТЫ ======
// rooms[roomId] = {
//   players: [{id, name}],
//   hostId: <socketId>,
//   round: 0,
//   totalRounds: TOTAL_ROUNDS,
//   scores: { [playerId]: { '😂':0, '🙂':0, '💩':0 } },
//   state: 'lobby'|'answering'|'voting'|'results',
//   roundData: {
//     pairs: [ { members: [id1,id2], questions:[q1,q2],
//                answers: { 0: { [playerId]: text }, 1: { [playerId]: text } },
//                firstAnswerTimeMs: null } ],
//     answersCount: 0,
//     totalExpectedAnswers: pairs.length * 2 /*вопроса*/ * 2 /*в паре игроков*/,
//     roundTimer: Timeout,
//     votingCursor: { pairIndex:0, qIndex:0 },
//     votes: { [pairIdx]: { [qIdx]: { [voterId]: { targetPlayerId, emoji } } } }
//   }
// }

const rooms = {};

function shuffleArr(a) {
  const arr = [...a];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pairUp(playersIds) {
  const shuffled = shuffleArr(playersIds);
  const pairs = [];
  for (let i = 0; i < shuffled.length; i += 2) {
    if (i + 1 < shuffled.length) {
      pairs.push({ members: [shuffled[i], shuffled[i + 1]] });
    } else {
      // если нечётное, последний в тройку с предыдущей парой
      if (pairs.length > 0) {
        pairs[pairs.length - 1].members.push(shuffled[i]);
      } else {
        pairs.push({ members: [shuffled[i]] });
      }
    }
  }
  return pairs;
}

function getPlayerName(room, id) {
  const p = room.players.find(p => p.id === id);
  return p ? p.name : id;
}

// ====== СОКЕТ-СОБЫТИЯ ======
io.on('connection', (socket) => {
  console.log("Client connected:", socket.id);

  socket.on('joinRoom', ({ roomId, playerName }) => {
    if (!roomId || !playerName) return;

    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: [],
        hostId: socket.id,
        round: 0,
        totalRounds: TOTAL_ROUNDS,
        scores: {},
        state: 'lobby',
        roundData: null
      };
    }

    const room = rooms[roomId];

    // защита от повторного добавления
    if (!room.players.find(p => p.id === socket.id)) {
      room.players.push({ id: socket.id, name: playerName });
      if (!room.scores[socket.id]) {
        room.scores[socket.id] = { '😂': 0, '🙂': 0, '💩': 0 };
      }
    }

    socket.join(roomId);

    io.to(roomId).emit('roomJoined', {
      roomId,
      players: room.players,
      hostId: room.hostId,
      round: room.round,
      state: room.state
    });
    io.to(roomId).emit('playerListUpdate', room.players);
  });

  socket.on('startGame', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    if (socket.id !== room.hostId) return; // только хост может стартовать

    startRound(roomId);
  });

  socket.on('submitAnswer', ({ roomId, pairIndex, qIndex, answer }) => {
    const room = rooms[roomId];
    if (!room || room.state !== 'answering' || !room.roundData) return;

    const rd = room.roundData;
    const pair = rd.pairs[pairIndex];
    if (!pair) return;

    // Инициализация контейнеров
    if (!pair.answers) pair.answers = { 0: {}, 1: {} };
    if (typeof pair.firstAnswerTimeMs !== 'number') {
      pair.firstAnswerTimeMs = Date.now(); // для информации; глобальный таймер уже идёт
    }

    // Сохраняем ответ (каждый игрок может ответить по одному разу на вопрос)
    if (!pair.answers[qIndex][socket.id] && typeof answer === 'string' && answer.trim().length) {
      pair.answers[qIndex][socket.id] = answer.trim();
      rd.answersCount++;

      // Если оба (или все участники пары) ответили на текущий вопрос — выдать след. вопрос этой паре
      const needCount = pair.members.length; // 2 или 3 (редко)
      const gotCount = Object.keys(pair.answers[qIndex]).length;

      if (qIndex === 0 && gotCount >= Math.min(2, needCount)) {
        // выдать второй вопрос этой паре — рассылаем КАЖДОМУ участнику пары
        pair.members.forEach(sid => {
          io.to(sid).emit('showQuestion', {
            pairIndex,
            qIndex: 1,
            question: pair.questions[1]
          });
        });
      }
    }

    // Если уже собрали все ответы (всех пар, оба вопроса, от 2 игроков пары)
    if (rd.answersCount >= rd.totalExpectedAnswers) {
      clearTimeout(rd.roundTimer);
      startVoting(roomId);
    }
  });

  socket.on('submitVote', ({ roomId, pairIndex, qIndex, targetPlayerId, emoji }) => {
    const room = rooms[roomId];
    if (!room || room.state !== 'voting' || !room.roundData) return;
    if (!ALLOWED_EMOJIS.includes(emoji)) return;

    const rd = room.roundData;
    const pair = rd.pairs[pairIndex];
    if (!pair) return;

    // Голосовать не могут участники пары
    if (pair.members.includes(socket.id)) return;

    // Инициализация хранилища голосов
    if (!rd.votes[pairIndex]) rd.votes[pairIndex] = {};
    if (!rd.votes[pairIndex][qIndex]) rd.votes[pairIndex][qIndex] = {};

    // Один голос на этот (пара, вопрос)
    if (rd.votes[pairIndex][qIndex][socket.id]) return;

    // Цель голоса — один из отвечающих
    if (!pair.answers || !pair.answers[qIndex] || !pair.answers[qIndex][targetPlayerId]) return;

    rd.votes[pairIndex][qIndex][socket.id] = { targetPlayerId, emoji };

    // Проверим завершение шага голосования
    const eligibleVoters = room.players
      .map(p => p.id)
      .filter(id => !pair.members.includes(id)); // все, кроме участников пары

    const votesCount = Object.keys(rd.votes[pairIndex][qIndex]).length;
    if (votesCount >= eligibleVoters.length) {
      // Подсчёт очков
      tallyVotesForStep(roomId, pairIndex, qIndex);
      nextVotingStep(roomId);
    }
  });

  socket.on('nextRound', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    if (socket.id !== room.hostId) return;

    if (room.round < room.totalRounds) {
      startRound(roomId);
    }
  });

  socket.on('disconnect', () => {
    console.log("Client disconnected:", socket.id);
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        io.to(roomId).emit('playerListUpdate', room.players);
      }
      // Если хост вышел — назначим нового
      if (room.hostId === socket.id && room.players.length > 0) {
        room.hostId = room.players[0].id;
        io.to(roomId).emit('hostChanged', room.hostId);
      }
    }
  });
});

// ====== ЛОГИКА РАУНДА ======
function startRound(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.round += 1;
  room.state = 'answering';

  // Собираем пары
  const playerIds = room.players.map(p => p.id);
  const pairsRaw = pairUp(playerIds);

  // Назначаем 2 вопроса каждой паре
  const pairs = pairsRaw.map(pr => {
    // берём случайные вопросы
    const shuffled = shuffleArr(QUESTIONS_BANK);
    const q1 = String(shuffled[0]);
    const q2 = String(shuffled[1]);
    return {
      members: pr.members,
      questions: [q1, q2],
      answers: { 0: {}, 1: {} },
      firstAnswerTimeMs: null
    };
  });

  // Счётчик ожидаемых ответов
  let totalExpectedAnswers = 0;
  pairs.forEach(pr => { totalExpectedAnswers += 2 /*вопроса*/ * Math.min(2, pr.members.length); });

  room.roundData = {
    pairs,
    answersCount: 0,
    totalExpectedAnswers,
    roundTimer: null,
    votingCursor: { pairIndex: 0, qIndex: 0 },
    votes: {}
  };

  // Отправляем ВОПРОС 1 всем парам сразу (каждому участнику пары)
  pairs.forEach((pair, pairIndex) => {
    pair.members.forEach(sid => {
      io.to(sid).emit('showQuestion', {
        pairIndex,
        qIndex: 0,
        question: pair.questions[0]
      });
    });
  });

  // Общий таймер на раунд (60 секунд от выдачи первых вопросов)
  room.roundData.roundTimer = setTimeout(() => {
    // Переходим к голосованию даже если не все успели
    startVoting(roomId);
  }, ROUND_TIME_MS);

  io.to(roomId).emit('roundStarted', {
    round: room.round,
    pairs: pairs.map((p, i) => ({
      pairIndex: i,
      members: p.members
    })),
    totalRounds: room.totalRounds
  });
}

function startVoting(roomId) {
  const room = rooms[roomId];
  if (!room || !room.roundData) return;

  room.state = 'voting';
  const rd = room.roundData;

  // Начинаем с первой пары / первого вопроса
  rd.votingCursor = { pairIndex: 0, qIndex: 0 };

  // Рассылаем сигнал в комнату, что начинается голосование
  io.to(roomId).emit('votingPhaseStarted');

  // И запускаем первый шаг
  emitVotingStep(roomId);
}

function emitVotingStep(roomId) {
  const room = rooms[roomId];
  if (!room || !room.roundData) return;
  const rd = room.roundData;
  const { pairIndex, qIndex } = rd.votingCursor;

  const pair = rd.pairs[pairIndex];
  if (!pair) {
    // Голосование завершено
    finishRound(roomId);
    return;
  }

  // Если у пары нет ответов на этот вопрос — пропускаем шаг
  const ansObj = pair.answers[qIndex] || {};
  const playerIdsWithAnswers = Object.keys(ansObj);
  if (playerIdsWithAnswers.length < 2) {
    // принудительно двигаемся дальше
    return nextVotingStep(roomId);
  }

  const eligibleVoters = room.players
    .map(p => p.id)
    .filter(id => !pair.members.includes(id));

  // Отправим в комнату шаг голосования
  io.to(roomId).emit('votingStep', {
    pairIndex,
    qIndex,
    question: pair.questions[qIndex],
    answers: playerIdsWithAnswers.map(pid => ({
      playerId: pid,
      playerName: getPlayerName(room, pid),
      answer: ansObj[pid]
    })),
    eligibleVoters
  });

  // Таймер шага голосования (чтобы не зависло)
  if (!rd._voteStepTimer) {
    rd._voteStepTimer = setTimeout(() => {
      tallyVotesForStep(roomId, pairIndex, qIndex);
      nextVotingStep(roomId);
    }, VOTE_STEP_TIMEOUT_MS);
  }
}

function nextVotingStep(roomId) {
  const room = rooms[roomId];
  if (!room || !room.roundData) return;
  const rd = room.roundData;

  // Сброс таймера шага
  if (rd._voteStepTimer) {
    clearTimeout(rd._voteStepTimer);
    rd._voteStepTimer = null;
  }

  // Сдвигаем курсор: сначала qIndex 0 -> 1, потом следующая пара
  if (rd.votingCursor.qIndex === 0) {
    rd.votingCursor.qIndex = 1;
  } else {
    rd.votingCursor.qIndex = 0;
    rd.votingCursor.pairIndex += 1;
  }

  emitVotingStep(roomId);
}

function tallyVotesForStep(roomId, pairIndex, qIndex) {
  const room = rooms[roomId];
  if (!room || !room.roundData) return;

  const rd = room.roundData;
  const votesMap = (rd.votes[pairIndex] && rd.votes[pairIndex][qIndex]) || {};
  const entries = Object.values(votesMap); // [{targetPlayerId, emoji}, ...]

  entries.forEach(v => {
    if (!room.scores[v.targetPlayerId]) {
      room.scores[v.targetPlayerId] = { '😂': 0, '🙂': 0, '💩': 0 };
    }
    if (ALLOWED_EMOJIS.includes(v.emoji)) {
      room.scores[v.targetPlayerId][v.emoji] += 1;
    }
  });

  // Отправим промежуточные результаты этого шага (по желанию)
  io.to(roomId).emit('votingStepTally', {
    pairIndex, qIndex, votes: votesMap
  });
}

function finishRound(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.state = 'results';

  // Сформируем таблицу лидеров (с сортировкой по 😂, затем 🙂, затем обратн. по 💩)
  const leaderboard = room.players.map(p => {
    const s = room.scores[p.id] || { '😂': 0, '🙂': 0, '💩': 0 };
    return {
      playerId: p.id,
      name: p.name,
      laugh: s['😂'],
      smile: s['🙂'],
      poop: s['💩']
    };
  }).sort((a, b) => {
    if (b.laugh !== a.laugh) return b.laugh - a.laugh;
    if (b.smile !== a.smile) return b.smile - a.smile;
    return a.poop - b.poop; // меньше 💩 — лучше
  });

  io.to(roomId).emit('roundResults', {
    round: room.round,
    leaderboard,
    totalRounds: room.totalRounds
  });

  // Авто-переход к следующему раунду, если ещё не все прошли
  if (room.round < room.totalRounds) {
    setTimeout(() => {
      startRound(roomId);
    }, 5000);
  } else {
    // Игра окончена
    io.to(roomId).emit('gameFinished', { leaderboard });
  }
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
