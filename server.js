const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;

const rooms = {};

const STARTING_CHIPS = 1000;
const SMALL_BLIND = 5;
const BIG_BLIND = 10;
const AUTO_NEXT_HAND_DELAY = 5000;

function generateRoomId() {
  let roomId = "";
  do {
    roomId = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms[roomId]);
  return roomId;
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function createDeck() {
  const deck = [];
  for (let suit = 0; suit < 4; suit++) {
    for (let rank = 2; rank <= 14; rank++) {
      deck.push({ suit, rank });
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

function clearAutoNextHandTimer(room) {
  if (room && room.auto_next_hand_timer) {
    clearTimeout(room.auto_next_hand_timer);
    room.auto_next_hand_timer = null;
  }
}

function scheduleAutoNextHand(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  clearAutoNextHandTimer(room);

  room.auto_next_hand_timer = setTimeout(() => {
    const latestRoom = rooms[roomId];
    if (!latestRoom || latestRoom.players.length !== 2 || !latestRoom.game) return;
    if (latestRoom.game.phase !== "SHOWDOWN") return;
    if (latestRoom.players[0].chips <= 0 || latestRoom.players[1].chips <= 0) return;

    startNextHand(roomId);
  }, AUTO_NEXT_HAND_DELAY);
}

function getStraightHigh(uniqueRanks) {
  const ranks = [...uniqueRanks];
  if (ranks.includes(14)) ranks.push(1);

  ranks.sort((a, b) => a - b);

  let consecutive = 1;
  let bestHigh = 0;

  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i] === ranks[i - 1]) continue;

    if (ranks[i] === ranks[i - 1] + 1) {
      consecutive += 1;
      if (consecutive >= 5) bestHigh = ranks[i];
    } else {
      consecutive = 1;
    }
  }

  return bestHigh;
}

function analyzeCardsScore(playerCards, communityCards) {
  const allCards = [...playerCards, ...communityCards];

  const rankCounts = {};
  const suitGroups = {};

  for (const card of allCards) {
    rankCounts[card.rank] = (rankCounts[card.rank] || 0) + 1;

    if (!suitGroups[card.suit]) {
      suitGroups[card.suit] = [];
    }
    suitGroups[card.suit].push(card);
  }

  const allRanks = Object.keys(rankCounts).map(Number).sort((a, b) => b - a);

  let flushCards = [];
  for (const suit in suitGroups) {
    if (suitGroups[suit].length >= 5) {
      flushCards = [...suitGroups[suit]];
      break;
    }
  }

  const straightHigh = getStraightHigh(allRanks);

  if (flushCards.length >= 5) {
    const flushRanks = [...new Set(flushCards.map((c) => c.rank))].sort((a, b) => b - a);
    const straightFlushHigh = getStraightHigh(flushRanks);

    if (straightFlushHigh > 0) {
      return {
        level: 8,
        name: "同花順",
        tiebreak: [straightFlushHigh]
      };
    }
  }

  let fourRank = 0;
  for (const r of allRanks) {
    if (rankCounts[r] === 4) {
      fourRank = r;
      break;
    }
  }

  if (fourRank > 0) {
    let kicker = 0;
    for (const r of allRanks) {
      if (r !== fourRank) {
        kicker = r;
        break;
      }
    }

    return {
      level: 7,
      name: "鐵支",
      tiebreak: [fourRank, kicker]
    };
  }

  const tripleRanks = [];
  const pairRanks = [];

  for (const r of allRanks) {
    if (rankCounts[r] >= 3) {
      tripleRanks.push(r);
    } else if (rankCounts[r] >= 2) {
      pairRanks.push(r);
    }
  }

  if (tripleRanks.length >= 2) {
    return {
      level: 6,
      name: "葫蘆",
      tiebreak: [tripleRanks[0], tripleRanks[1]]
    };
  }

  if (tripleRanks.length >= 1 && pairRanks.length >= 1) {
    return {
      level: 6,
      name: "葫蘆",
      tiebreak: [tripleRanks[0], pairRanks[0]]
    };
  }

  if (flushCards.length >= 5) {
    const flushRanksOnly = flushCards
      .map((c) => c.rank)
      .sort((a, b) => b - a)
      .slice(0, 5);

    return {
      level: 5,
      name: "同花",
      tiebreak: flushRanksOnly
    };
  }

  if (straightHigh > 0) {
    return {
      level: 4,
      name: "順子",
      tiebreak: [straightHigh]
    };
  }

  if (tripleRanks.length >= 1) {
    const trips = tripleRanks[0];
    const kickers = [];

    for (const r of allRanks) {
      if (r !== trips) kickers.push(r);
      if (kickers.length === 2) break;
    }

    return {
      level: 3,
      name: "三條",
      tiebreak: [trips, kickers[0], kickers[1]]
    };
  }

  const pairs = [];
  for (const r of allRanks) {
    if (rankCounts[r] >= 2) pairs.push(r);
  }

  if (pairs.length >= 2) {
    let kicker = 0;
    for (const r of allRanks) {
      if (r !== pairs[0] && r !== pairs[1]) {
        kicker = r;
        break;
      }
    }

    return {
      level: 2,
      name: "兩對",
      tiebreak: [pairs[0], pairs[1], kicker]
    };
  }

  if (pairs.length === 1) {
    const pairRank = pairs[0];
    const kickers = [];

    for (const r of allRanks) {
      if (r !== pairRank) kickers.push(r);
      if (kickers.length === 3) break;
    }

    return {
      level: 1,
      name: "一對",
      tiebreak: [pairRank, kickers[0], kickers[1], kickers[2]]
    };
  }

  return {
    level: 0,
    name: "高牌",
    tiebreak: allRanks.slice(0, 5)
  };
}

function compareScores(a, b) {
  if (a.level > b.level) return 1;
  if (a.level < b.level) return -1;

  const n = Math.min(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < n; i++) {
    if (a.tiebreak[i] > b.tiebreak[i]) return 1;
    if (a.tiebreak[i] < b.tiebreak[i]) return -1;
  }

  return 0;
}

function findRoomAndPlayerByWs(ws) {
  for (const roomId in rooms) {
    const room = rooms[roomId];
    const playerIndex = room.players.findIndex((p) => p.ws === ws);
    if (playerIndex !== -1) {
      return { roomId, room, playerIndex };
    }
  }
  return null;
}

function otherPlayerIndex(index) {
  return 1 - index;
}

function isBettingRoundComplete(game) {
  const activePlayers = [0, 1].filter((i) => !game.folded[i]);

  if (activePlayers.length <= 1) return true;

  for (const i of activePlayers) {
    if (!game.acted[i]) return false;
  }

  const firstBet = game.round_bets[activePlayers[0]];
  for (const i of activePlayers) {
    if (game.round_bets[i] !== firstBet) return false;
  }

  return true;
}

function moveTurnToNextActivePlayer(game, fromIndex) {
  const next = otherPlayerIndex(fromIndex);
  if (!game.folded[next]) {
    game.current_turn = next;
    return;
  }
  game.current_turn = fromIndex;
}

function settleShowdown(roomId) {
  const room = rooms[roomId];
  if (!room || !room.game) return;

  const game = room.game;

  if (game.folded[0]) {
    game.winner = 1;
    game.win_name = "對手棄牌";
    room.players[1].chips += game.pot;
    game.pot = 0;
    broadcastGameState(roomId);
    scheduleAutoNextHand(roomId);
    return;
  }

  if (game.folded[1]) {
    game.winner = 0;
    game.win_name = "對手棄牌";
    room.players[0].chips += game.pot;
    game.pot = 0;
    broadcastGameState(roomId);
    scheduleAutoNextHand(roomId);
    return;
  }

  const p1 = analyzeCardsScore(game.hands[0], game.community_cards);
  const p2 = analyzeCardsScore(game.hands[1], game.community_cards);
  const cmp = compareScores(p1, p2);

  if (cmp > 0) {
    game.winner = 0;
    game.win_name = p1.name;
    room.players[0].chips += game.pot;
    game.pot = 0;
  } else if (cmp < 0) {
    game.winner = 1;
    game.win_name = p2.name;
    room.players[1].chips += game.pot;
    game.pot = 0;
  } else {
    game.winner = -1;
    game.win_name = "平手";
    const splitPot = Math.floor(game.pot / 2);
    room.players[0].chips += splitPot;
    room.players[1].chips += game.pot - splitPot;
    game.pot = 0;
  }

  broadcastGameState(roomId);
  scheduleAutoNextHand(roomId);
}

function broadcastRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const playerNames = room.players.map((p) => p.name);

  room.players.forEach((player) => {
    send(player.ws, {
      type: "room_update",
      room_id: roomId,
      players: playerNames
    });
  });

  if (room.players.length === 2) {
    startGame(roomId);
  }
}

function startGame(roomId) {
  const room = rooms[roomId];
  if (!room || room.players.length !== 2) return;

  clearAutoNextHandTimer(room);

  room.dealer_index = 1 - room.dealer_index;

  const dealer = room.dealer_index;
  const smallBlindIndex = dealer;
  const bigBlindIndex = otherPlayerIndex(dealer);

  if (
    room.players[smallBlindIndex].chips < SMALL_BLIND ||
    room.players[bigBlindIndex].chips < BIG_BLIND
  ) {
    room.game = {
      phase: "SHOWDOWN",
      pot: 0,
      current_turn: -1,
      current_bet: 0,
      round_bets: [0, 0],
      community_cards: [],
      hands: [[], []],
      deck: [],
      acted: [false, false],
      folded: [false, false],
      winner: null,
      win_name: "有玩家籌碼不足，無法開始新局",
      dealer_index: dealer,
      small_blind_index: smallBlindIndex,
      big_blind_index: bigBlindIndex,
      small_blind_amount: SMALL_BLIND,
      big_blind_amount: BIG_BLIND
    };
    broadcastGameState(roomId);
    return;
  }

  const deck = createDeck();
  shuffleDeck(deck);

  const playerHands = [
    [deck.pop(), deck.pop()],
    [deck.pop(), deck.pop()]
  ];

  room.players[smallBlindIndex].chips -= SMALL_BLIND;
  room.players[bigBlindIndex].chips -= BIG_BLIND;

  room.game = {
    phase: "PRE_FLOP",
    pot: SMALL_BLIND + BIG_BLIND,
    current_turn: smallBlindIndex,
    current_bet: BIG_BLIND,
    round_bets: [0, 0],
    community_cards: [],
    hands: playerHands,
    deck,
    acted: [false, false],
    folded: [false, false],
    winner: null,
    win_name: "",
    dealer_index: dealer,
    small_blind_index: smallBlindIndex,
    big_blind_index: bigBlindIndex,
    small_blind_amount: SMALL_BLIND,
    big_blind_amount: BIG_BLIND
  };

  room.game.round_bets[smallBlindIndex] = SMALL_BLIND;
  room.game.round_bets[bigBlindIndex] = BIG_BLIND;

  room.players.forEach((player, index) => {
    send(player.ws, {
      type: "game_start",
      room_id: roomId,
      your_index: index
    });
  });

  broadcastGameState(roomId);
}

function broadcastGameState(roomId) {
  const room = rooms[roomId];
  if (!room || !room.game) return;

  const playerNames = room.players.map((p) => p.name);
  const chipAmounts = room.players.map((p) => p.chips);
  const isShowdown = room.game.phase === "SHOWDOWN";

  room.players.forEach((player, index) => {
    const opponentIndex = 1 - index;

    const payload = {
      type: "game_state",
      phase: String(room.game.phase),
      pot: Number(room.game.pot),
      current_turn: Number(room.game.current_turn),
      current_bet: Number(room.game.current_bet),
      round_bets: Array.isArray(room.game.round_bets) ? room.game.round_bets : [0, 0],
      players: playerNames,
      chips: chipAmounts,
      your_hand: room.game.hands[index] || [],
      opponent_hand: isShowdown ? (room.game.hands[opponentIndex] || []) : [],
      community_cards: room.game.community_cards || [],
      folded: room.game.folded || [false, false],
      winner: room.game.winner === undefined ? null : room.game.winner,
      win_name: room.game.win_name || "",
      dealer_index: room.game.dealer_index,
      small_blind_index: room.game.small_blind_index,
      big_blind_index: room.game.big_blind_index,
      small_blind_amount: room.game.small_blind_amount,
      big_blind_amount: room.game.big_blind_amount
    };

    send(player.ws, payload);
  });
}

function advancePhase(roomId) {
  const room = rooms[roomId];
  if (!room || !room.game) return;

  const game = room.game;

  game.acted = [false, false];
  game.current_bet = 0;
  game.round_bets = [0, 0];
  game.current_turn = game.small_blind_index;

  if (game.phase === "PRE_FLOP") {
    game.phase = "FLOP";
    game.community_cards.push(game.deck.pop());
    game.community_cards.push(game.deck.pop());
    game.community_cards.push(game.deck.pop());
    broadcastGameState(roomId);
    return;
  }

  if (game.phase === "FLOP") {
    game.phase = "TURN";
    game.community_cards.push(game.deck.pop());
    broadcastGameState(roomId);
    return;
  }

  if (game.phase === "TURN") {
    game.phase = "RIVER";
    game.community_cards.push(game.deck.pop());
    broadcastGameState(roomId);
    return;
  }

  if (game.phase === "RIVER") {
    game.phase = "SHOWDOWN";
    game.current_turn = -1;
    settleShowdown(roomId);
    return;
  }

  broadcastGameState(roomId);
}

function handlePlayerAction(roomId, playerIndex, action, amount = 0) {
  const room = rooms[roomId];
  if (!room || !room.game) return;

  const game = room.game;
  const player = room.players[playerIndex];

  if (game.phase === "SHOWDOWN") return;
  if (game.current_turn !== playerIndex) return;
  if (game.folded[playerIndex]) return;

  if (action === "fold") {
    game.folded[playerIndex] = true;
    game.acted[playerIndex] = true;
    game.phase = "SHOWDOWN";
    game.current_turn = -1;
    settleShowdown(roomId);
    return;
  }

  if (action === "check") {
    if (game.current_bet > game.round_bets[playerIndex]) {
      return;
    }

    game.acted[playerIndex] = true;

    if (isBettingRoundComplete(game)) {
      advancePhase(roomId);
      return;
    }

    moveTurnToNextActivePlayer(game, playerIndex);
    broadcastGameState(roomId);
    return;
  }

  if (action === "call") {
    const needed = game.current_bet - game.round_bets[playerIndex];
    if (needed < 0) return;
    if (player.chips < needed) return;

    game.round_bets[playerIndex] += needed;
    game.pot += needed;
    player.chips -= needed;
    game.acted[playerIndex] = true;

    if (isBettingRoundComplete(game)) {
      advancePhase(roomId);
      return;
    }

    moveTurnToNextActivePlayer(game, playerIndex);
    broadcastGameState(roomId);
    return;
  }

  if (action === "raise") {
    const raiseAmount = Number(amount) || 0;
    if (raiseAmount <= 0) return;

    const callNeeded = game.current_bet - game.round_bets[playerIndex];
    if (callNeeded < 0) return;

    const totalNeeded = callNeeded + raiseAmount;
    if (player.chips < totalNeeded) return;

    player.chips -= totalNeeded;
    game.pot += totalNeeded;
    game.round_bets[playerIndex] += totalNeeded;
    game.current_bet = game.round_bets[playerIndex];

    game.acted[playerIndex] = true;
    game.acted[otherPlayerIndex(playerIndex)] = false;

    moveTurnToNextActivePlayer(game, playerIndex);
    broadcastGameState(roomId);
    return;
  }
}

function startNextHand(roomId) {
  const room = rooms[roomId];
  if (!room || room.players.length !== 2) return;

  clearAutoNextHandTimer(room);

  if (room.players[0].chips <= 0 || room.players[1].chips <= 0) {
    if (room.game) {
      room.game.phase = "SHOWDOWN";
      room.game.current_turn = -1;
      room.game.win_name = "有玩家籌碼歸零，無法開始下一手";
      broadcastGameState(roomId);
    }
    return;
  }

  startGame(roomId);
}

function removePlayer(ws) {
  for (const roomId in rooms) {
    const room = rooms[roomId];
    const index = room.players.findIndex((p) => p.ws === ws);

    if (index !== -1) {
      clearAutoNextHandTimer(room);

      const leftPlayer = room.players[index];
      room.players.splice(index, 1);

      console.log(`玩家離開房間 ${roomId}: ${leftPlayer.name}`);

      if (room.players.length === 0) {
        delete rooms[roomId];
        console.log(`房間 ${roomId} 已刪除`);
      } else {
        room.game = null;
        broadcastRoom(roomId);
      }
      return;
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Poker WebSocket server is running.");
});

const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws) => {
  console.log("有玩家連線進來");

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === "create_room") {
        const roomId = generateRoomId();

        rooms[roomId] = {
          players: [
            {
              name: data.player_name || "玩家1",
              ws,
              chips: STARTING_CHIPS
            }
          ],
          dealer_index: 1,
          game: null,
          auto_next_hand_timer: null
        };

        console.log(`房間已建立: ${roomId}`);

        send(ws, {
          type: "room_created",
          room_id: roomId
        });

        broadcastRoom(roomId);
        return;
      }

      if (data.type === "join_room") {
        const roomId = data.room_id;

        if (!rooms[roomId]) {
          send(ws, {
            type: "error",
            message: "房間不存在"
          });
          return;
        }

        if (rooms[roomId].players.length >= 2) {
          send(ws, {
            type: "error",
            message: "房間已滿"
          });
          return;
        }

        rooms[roomId].players.push({
          name: data.player_name || "玩家2",
          ws,
          chips: STARTING_CHIPS
        });

        console.log(`玩家加入房間 ${roomId}: ${data.player_name}`);

        broadcastRoom(roomId);
        return;
      }

      if (data.type === "player_action") {
        const found = findRoomAndPlayerByWs(ws);

        if (!found) {
          send(ws, {
            type: "error",
            message: "找不到你所在的房間"
          });
          return;
        }

        handlePlayerAction(found.roomId, found.playerIndex, data.action, data.amount);
        return;
      }

      if (data.type === "start_new_hand") {
        const found = findRoomAndPlayerByWs(ws);

        if (!found) {
          send(ws, {
            type: "error",
            message: "找不到你所在的房間"
          });
          return;
        }

        if (!found.room.game || found.room.game.phase !== "SHOWDOWN") {
          return;
        }

        startNextHand(found.roomId);
        return;
      }

      send(ws, {
        type: "error",
        message: "未知的訊息類型"
      });
    } catch (err) {
      console.error("訊息處理失敗:", err);
      send(ws, {
        type: "error",
        message: "伺服器解析訊息失敗"
      });
    }
  });

  ws.on("close", () => {
    console.log("玩家斷線");
    removePlayer(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});