import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { nanoid } from "nanoid";
import { ClientMessage, GameState, ServerMessage } from "@banco/shared";
import { GameEngine } from "./engine";

type RoomContext = {
  engine: GameEngine;
  connections: Map<string, WebSocket>;
};

const rooms = new Map<string, RoomContext>();
const session = new Map<WebSocket, { roomId?: string; playerId?: string }>();

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const server = app.listen(PORT, () => {
  console.log(`HTTP server ouvindo em http://localhost:${PORT}`);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  session.set(ws, {});
  ws.on("message", (data) => {
    try {
      const parsed = JSON.parse(data.toString()) as ClientMessage;
      handleMessage(ws, parsed);
    } catch (err: any) {
      safeSend(ws, { type: "error", message: err.message ?? "Erro desconhecido" });
    }
  });

  ws.on("close", () => {
    const info = session.get(ws);
    if (!info?.roomId || !info.playerId) return;
    const room = rooms.get(info.roomId);
    if (!room) return;
    const player = room.engine.state.players.find((p) => p.id === info.playerId);
    if (player) player.disconnected = true;
    room.connections.delete(info.playerId);
    broadcastState(room);
    session.delete(ws);
  });
});

function handleMessage(ws: WebSocket, message: ClientMessage) {
  switch (message.type) {
    case "createRoom":
      handleCreateRoom(ws, message);
      break;
    case "joinRoom":
      handleJoinRoom(ws, message);
      break;
    case "reconnect":
      handleReconnect(ws, message.roomId, message.playerId);
      break;
    case "startGame":
      handleWithRoom(ws, (room, playerId) => {
        if (room.engine.state.hostId !== playerId) throw new Error("Apenas o anfitrião pode iniciar.");
        room.engine.startGame();
        broadcastState(room);
      });
      break;
    case "finishGame":
      handleWithRoom(ws, (room, playerId) => {
        if (room.engine.state.hostId !== playerId) throw new Error("Apenas o anfitrião pode finalizar.");
        room.engine.finishByNetWorth();
        broadcastState(room);
      });
      break;
    case "rollDice":
      handleWithRoom(ws, (room, playerId) => {
        const roll = room.engine.rollDice(playerId);
        broadcast(room, { type: "dice", roll });
        broadcastState(room);
      });
      break;
    case "buyProperty":
      handleWithRoom(ws, (room, playerId) => {
        room.engine.buyProperty(playerId, message.propertyId);
        broadcastState(room);
      });
      break;
    case "passPurchase":
      handleWithRoom(ws, (room, playerId) => {
        room.engine.passPurchase(playerId);
        broadcastState(room);
      });
      break;
    case "payBail":
      handleWithRoom(ws, (room, playerId) => {
        room.engine.payBail(playerId);
        broadcastState(room);
      });
      break;
    case "endTurn":
      handleWithRoom(ws, (room, playerId) => {
        room.engine.endTurn(playerId);
        broadcastState(room);
      });
      break;
    default:
      safeSend(ws, { type: "error", message: "Ação não suportada" });
  }
}

function handleCreateRoom(ws: WebSocket, message: Extract<ClientMessage, { type: "createRoom" }>) {
  const roomId = nanoid(6);
  const engine = new GameEngine(roomId, message.playerName, message.settings);
  const ctx: RoomContext = { engine, connections: new Map() };
  rooms.set(roomId, ctx);
  const playerId = engine.state.hostId;
  ctx.connections.set(playerId, ws);
  session.set(ws, { roomId, playerId });
  safeSend(ws, { type: "roomCreated", roomId });
  safeSend(ws, { type: "joined", playerId, roomId });
  broadcastState(ctx);
}

function handleJoinRoom(ws: WebSocket, message: Extract<ClientMessage, { type: "joinRoom" }>) {
  const room = rooms.get(message.roomId);
  if (!room) {
    safeSend(ws, { type: "error", message: "Sala não encontrada" });
    return;
  }
  if (room.engine.state.status !== "lobby") {
    safeSend(ws, { type: "error", message: "Partida já iniciada" });
    return;
  }
  const player = room.engine.addPlayer(message.playerName);
  room.connections.set(player.id, ws);
  session.set(ws, { roomId: message.roomId, playerId: player.id });
  safeSend(ws, { type: "joined", playerId: player.id, roomId: message.roomId });
  broadcastState(room);
}

function handleReconnect(ws: WebSocket, roomId: string, playerId: string) {
  const room = rooms.get(roomId);
  if (!room) {
    safeSend(ws, { type: "error", message: "Sala não encontrada" });
    return;
  }
  const player = room.engine.reconnect(playerId);
  room.connections.set(playerId, ws);
  session.set(ws, { roomId, playerId });
  safeSend(ws, { type: "joined", playerId: player.id, roomId });
  broadcastState(room);
}

function handleWithRoom(
  ws: WebSocket,
  fn: (room: RoomContext, playerId: string, state: GameState) => void
) {
  const info = session.get(ws);
  if (!info?.roomId || !info.playerId) {
    safeSend(ws, { type: "error", message: "Você não está em uma sala" });
    return;
  }
  const room = rooms.get(info.roomId);
  if (!room) {
    safeSend(ws, { type: "error", message: "Sala não encontrada" });
    return;
  }
  try {
    fn(room, info.playerId, room.engine.state);
  } catch (err: any) {
    safeSend(ws, { type: "error", message: err.message ?? "Erro" });
  }
}

function broadcast(room: RoomContext, message: ServerMessage) {
  const payload = JSON.stringify(message);
  for (const ws of room.connections.values()) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

function broadcastState(room: RoomContext) {
  broadcast(room, { type: "state", state: room.engine.state });
}

function safeSend(ws: WebSocket, message: ServerMessage) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}
