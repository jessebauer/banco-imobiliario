import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ClientMessage,
  DiceRoll,
  GameState,
  EVENT_CARDS,
  PlayerState,
  PropertyTile,
  ServerMessage,
  Tile
} from "@banco/shared";
import QRCode from "qrcode.react";

type ConnectionMode = "host" | "join";

type Session = {
  roomId: string;
  playerId: string;
};

const playerColors = ["#5FE3B2", "#F5D76E", "#7DD6FF", "#F8A6C2", "#C4A4FF", "#8DF1A8", "#F3A45F"];
const defaultName = `Jogador-${Math.floor(Math.random() * 900 + 100)}`;

export default function App() {
  const [mode, setMode] = useState<ConnectionMode>("host");
  const [serverUrl, setServerUrl] = useState("ws://localhost:4000");
  const [name, setName] = useState(defaultName);
  const [roomInput, setRoomInput] = useState("");
  const [game, setGame] = useState<GameState | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [lastRoll, setLastRoll] = useState<DiceRoll | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [createdRoomId, setCreatedRoomId] = useState<string | null>(null);
  const [lastMovedTileId, setLastMovedTileId] = useState<string | null>(null);
  const [seenEventLogId, setSeenEventLogId] = useState<string | null>(null);
  const [theme, setTheme] = useState<"classic" | "contrast">("classic");
  const reconnectRef = useRef<{ roomId: string; playerId: string; server: string } | null>(null);
  const eventHydratedRef = useRef(false);
  const suppressReconnectRef = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const room = params.get("room");
    const server = params.get("server");
    const presetName = params.get("name");
    if (room) {
      setMode("join");
      setRoomInput(room);
    }
    if (server) setServerUrl(server);
    if (presetName) setName(presetName);
  }, []);

  useEffect(() => {
    return () => {
      if (ws) {
        suppressReconnectRef.current = true;
        ws.close();
      }
    };
  }, [ws]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const connect = (payload: ClientMessage, targetServer = serverUrl) => {
    setConnecting(true);
    setError(null);
    if (ws) {
      suppressReconnectRef.current = true;
      ws.close();
    }
    const socket = new WebSocket(targetServer);
    setWs(socket);
    socket.onopen = () => {
      suppressReconnectRef.current = false;
      socket.send(JSON.stringify(payload));
      setInfo("Conectado. Sincronizando estado...");
      if (payload.type === "createRoom") {
        reconnectRef.current = null;
      }
    };
    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data) as ServerMessage;
      if (msg.type === "roomCreated") {
        setCreatedRoomId(msg.roomId);
      }
      if (msg.type === "joined") {
        const newSession = { roomId: msg.roomId, playerId: msg.playerId };
        setSession(newSession);
        reconnectRef.current = { roomId: msg.roomId, playerId: msg.playerId, server: targetServer };
        setInfo(`Conectado à sala ${msg.roomId}`);
        setConnecting(false);
      }
      if (msg.type === "state") {
        setGame(msg.state);
        setConnecting(false);
      }
      if (msg.type === "dice") {
        setLastRoll(msg.roll);
      }
      if (msg.type === "error") {
        setError(msg.message);
        setConnecting(false);
      }
    };
    socket.onclose = () => {
      if (suppressReconnectRef.current) {
        suppressReconnectRef.current = false;
        return;
      }
      setConnecting(false);
      setInfo("Conexão perdida. Tentando reconectar...");
      if (reconnectRef.current) {
        setTimeout(() => {
          attemptReconnect(reconnectRef.current!);
        }, 1200);
      }
    };
  };

  const attemptReconnect = (payload: { roomId: string; playerId: string; server: string }) => {
    connect({ type: "reconnect", roomId: payload.roomId, playerId: payload.playerId }, payload.server);
  };

  const handleHost = () => {
    connect({ type: "createRoom", playerName: name });
  };

  const handleJoin = () => {
    if (!roomInput) {
      setError("Informe o código da sala.");
      return;
    }
    connect({ type: "joinRoom", roomId: roomInput.trim(), playerName: name });
  };

  const send = (message: ClientMessage) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError("Sem conexão com o servidor.");
      return;
    }
    ws.send(JSON.stringify(message));
  };

  const me = useMemo(() => game?.players.find((p) => p.id === session?.playerId), [game, session]);
  const playerColorMap = useMemo(() => {
    const map = new Map<string, string>();
    game?.players.forEach((p, idx) => {
      map.set(p.id, playerColors[idx % playerColors.length]);
    });
    return map;
  }, [game?.players]);
  const isMyTurn = !!game && game.turn.currentPlayerId === session?.playerId && game.status === "active";
  const awaitingTile: PropertyTile | undefined =
    game?.turn.awaitingPurchase
      ? (game.tiles.find((t) => t.id === game.turn.awaitingPurchase) as PropertyTile | undefined)
      : undefined;
  useEffect(() => {
    if (!game) return;
    const activePlayer = game.players.find((p) => p.id === game.turn.currentPlayerId);
    if (!activePlayer) return;
    const tile = game.tiles.find((t) => t.index === activePlayer.position);
    if (tile) setLastMovedTileId(tile.id);
  }, [game, lastRoll]);

  const joinUrl = useMemo(() => {
    if (!session?.roomId) return "";
    const base =
      serverUrl.startsWith("ws://") || serverUrl.startsWith("wss://")
        ? serverUrl.replace("ws://", "http://").replace("wss://", "https://")
        : serverUrl;
    const url = `${base}?room=${session.roomId}&server=${encodeURIComponent(serverUrl)}`;
    return url;
  }, [serverUrl, session]);

  const coords = useMemo(() => buildCoords(6), []);

  const currentTile = game?.tiles.find((t) => t.index === me?.position);

  const lastEventCard = useMemo(() => {
    const entry = game?.log.slice().reverse().find((l) => l.message.includes("puxou carta"));
    if (!entry) return null;
    const title = entry.message.split("puxou carta:")[1]?.trim() || entry.message.replace("puxou carta:", "").trim();
    const card = EVENT_CARDS.find((c) => c.title === title);
    return { logId: entry.id, title: title || "Carta", description: card?.description };
  }, [game?.log]);

  const shouldShowEventCard =
    lastEventCard && lastEventCard.logId !== seenEventLogId && game?.turn.currentPlayerId === session?.playerId;

  const statusLabel =
    game?.status === "active" ? "Partida em andamento" : game?.status === "finished" ? "Partida encerrada" : "Sala aberta";

  const turnSteps = buildTurnSteps(isMyTurn, game?.turn, awaitingTile);

  useEffect(() => {
    if (eventHydratedRef.current || !game) return;
    if (game.log.length) {
      const latest = game.log.slice().reverse().find((entry) => entry.message.includes("puxou carta"));
      if (latest) setSeenEventLogId(latest.id);
    }
    eventHydratedRef.current = true;
  }, [game]);

  const handleFinishNetWorth = () => {
    send({ type: "finishGame" });
  };

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <p className="eyebrow">Banco Imobiliário LAN</p>
          <h1>Tabuleiro classico, partidas em tempo real</h1>
          <p className="muted">Crie uma sala, compartilhe o link/QR e jogue com 2 a 12 pessoas na mesma rede.</p>
          <div className="top-actions">
            <span className={`chip ${game?.status ?? "lobby"}`}>{statusLabel}</span>
            <span className="badge">
              {game?.players.length || 0} jogador{(game?.players.length || 0) === 1 ? "" : "es"}
            </span>
            <button className="ghost" onClick={() => setTheme(theme === "classic" ? "contrast" : "classic")}>
              {theme === "classic" ? "Alto contraste" : "Tema clássico"}
            </button>
          </div>
        </div>
      </header>

      <section className="connect">
        <div className="card">
          <div className="row">
            <div className="field">
              <label>Nome</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Seu apelido" />
            </div>
            <div className="field">
              <label>Servidor (ws://IP:4000)</label>
              <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
            </div>
            <div className="field">
              <label>Modo</label>
              <div className="segmented">
                <button className={mode === "host" ? "active" : ""} onClick={() => setMode("host")}>
                  Criar sala
                </button>
                <button className={mode === "join" ? "active" : ""} onClick={() => setMode("join")}>
                  Entrar
                </button>
              </div>
            </div>
            {mode === "join" && (
              <div className="field">
                <label>Código da sala</label>
                <input value={roomInput} onChange={(e) => setRoomInput(e.target.value)} placeholder="Ex: X5K8ZQ" />
              </div>
            )}
          </div>
          <div className="actions">
            <button onClick={mode === "host" ? handleHost : handleJoin} className="primary" disabled={connecting}>
              {mode === "host" ? "Criar sala" : "Entrar na sala"}
            </button>
            {session && reconnectRef.current && (
              <button onClick={() => attemptReconnect({ ...reconnectRef.current, server: serverUrl })}>Reconectar</button>
            )}
            {info && <span className="info">{info}</span>}
            {error && <span className="error">{error}</span>}
          </div>
          {createdRoomId && (
            <div className="created">
              <p>
                Sala criada: <strong>{createdRoomId}</strong>
              </p>
              <p className="muted">Compartilhe o link ou escaneie o QR.</p>
              <div className="share">
                <input value={joinUrl || `${serverUrl}?room=${createdRoomId}`} readOnly />
                <div className="qr">
                  <QRCode value={joinUrl || `${serverUrl}?room=${createdRoomId}`} size={96} />
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="layout">
        <div className="board-card">
          {game ? (
            <>
              <Board
                tiles={game.tiles}
                coords={coords}
                players={game.players}
                currentPlayerId={game.turn.currentPlayerId}
                meId={session?.playerId}
                colors={playerColorMap}
                lastMovedTileId={lastMovedTileId || undefined}
              />
              <TileOverlay
                awaitingTile={awaitingTile || undefined}
                currentTile={currentTile}
                eventCard={shouldShowEventCard ? lastEventCard : null}
                isMyTurn={isMyTurn}
                onBuy={() => awaitingTile && send({ type: "buyProperty", propertyId: awaitingTile.id })}
                onPass={() => send({ type: "passPurchase" })}
                onDismissEvent={() => lastEventCard && setSeenEventLogId(lastEventCard.logId)}
              />
            </>
          ) : (
            <div className="empty">Conecte-se a uma sala para ver o tabuleiro.</div>
          )}
          {lastRoll && <Dice roll={lastRoll} />}
        </div>

        <div className="sidebar">
          <div className="panel">
            <div className="panel-header">
              <h3>Jogadores</h3>
              <span className="muted">
                {game?.players.length || 0} / {game?.settings.maxPlayers ?? 12}
              </span>
            </div>
            <div className="player-list">
              {game?.players.map((p, idx) => (
                <PlayerRow
                  key={p.id}
                  player={p}
                  color={playerColorMap.get(p.id) || playerColors[idx % playerColors.length]}
                  isTurn={game?.turn.currentPlayerId === p.id}
                  isMe={p.id === session?.playerId}
                  properties={ownedProperties(game?.tiles || [], p.id)}
                  cashBaseline={game?.settings.startingCash ?? 1500}
                />
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <h3>Ações</h3>
              <span className="muted">{isMyTurn ? "Seu turno" : "Aguarde"}</span>
            </div>
            <div className="actions-grid">
              <button disabled={!isMyTurn || !!game?.turn.rolled} onClick={() => send({ type: "rollDice" })}>
                Rolar dados
              </button>
              <button
                disabled={!isMyTurn || !awaitingTile}
                onClick={() => awaitingTile && send({ type: "buyProperty", propertyId: awaitingTile.id })}
                className="primary"
              >
                Comprar
              </button>
              <button disabled={!isMyTurn || !awaitingTile} onClick={() => send({ type: "passPurchase" })}>
                Passar compra
              </button>
              <button disabled={!isMyTurn} onClick={() => send({ type: "endTurn" })}>
                Finalizar turno
              </button>
              <button disabled={!isMyTurn || !me?.inJailTurns} onClick={() => send({ type: "payBail" })}>
                Pagar fiança
              </button>
              {game?.hostId === session?.playerId && game?.status === "active" && (
                <button onClick={handleFinishNetWorth}>Encerrar por patrimônio</button>
              )}
              {game?.hostId === session?.playerId && game?.status === "lobby" && (
                <button onClick={() => send({ type: "startGame" })} className="primary">
                  Iniciar partida
                </button>
              )}
            </div>
            <div className="turn-steps">
              {turnSteps.map((step) => (
                <div key={step.label} className={`step ${step.status}`}>
                  <span className="label">{step.label}</span>
                  <span className="hint">{step.hint}</span>
                </div>
              ))}
            </div>
            {awaitingTile && (
              <div className="callout">
                <strong>{awaitingTile.name}</strong> - preço {awaitingTile.price}, aluguel base {awaitingTile.baseRent}
              </div>
            )}
            {currentTile && (
              <div className="callout muted">
                Você está em <strong>{currentTile.name}</strong>
              </div>
            )}
          </div>

          <div className="panel log">
            <div className="panel-header">
              <h3>Log</h3>
            </div>
            <div className="log-list">
              {game?.log.slice().reverse().map((entry) => {
                const badge = logBadge(entry.message);
                return (
                  <div key={entry.id} className="log-item">
                    <div className="small" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span className="muted small">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                      {badge && <span className={`badge ${badge.tone}`}>{badge.label}</span>}
                    </div>
                    <span>{entry.message}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function Board({
  tiles,
  coords,
  players,
  currentPlayerId,
  meId,
  colors,
  lastMovedTileId
}: {
  tiles: Tile[];
  coords: { row: number; col: number }[];
  players: PlayerState[];
  currentPlayerId?: string;
  meId?: string;
  colors: Map<string, string>;
  lastMovedTileId?: string;
}) {
  return (
    <div className="board">
      {tiles.map((tile, idx) => {
        const pos = coords[idx];
        const tilePlayers = players.filter((p) => p.position === tile.index && !p.bankrupt);
        const ownerName =
          tile.type === "property" && (tile as PropertyTile).ownerId
            ? players.find((p) => p.id === (tile as PropertyTile).ownerId)?.name
            : null;
        const isActive = currentPlayerId && tilePlayers.some((p) => p.id === currentPlayerId);
        const isMeHere = meId ? tilePlayers.some((p) => p.id === meId) : false;
        const tileClass = `tile ${tile.type} ${isActive ? "active" : ""} ${
          lastMovedTileId === tile.id ? "recent" : ""
        } ${isMeHere ? "me" : ""}`;
        const accent =
          tile.type === "property"
            ? (tile as PropertyTile).color
            : tile.type === "tax"
              ? "#f5d76e"
              : tile.type === "event"
                ? "#58c3ff"
                : tile.type === "go-to-jail"
                  ? "#ff7b7b"
                  : undefined;
        return (
          <div
            key={tile.id}
            className={tileClass}
            style={{ gridRow: pos.row + 1, gridColumn: pos.col + 1, ["--tile-accent" as any]: accent }}
          >
            <div className="tile-header">
              <span className="tile-type">{tileLabel(tile.type)}</span>
              <span className="tile-name">{tile.name}</span>
            </div>
            <div className="tile-body">
              {tile.type === "property" && (
                <>
                  <span className="pill">
                    <span>{tile.price}</span>
                    <span>aluguel {(tile as PropertyTile).baseRent}</span>
                  </span>
                  {(tile as PropertyTile).ownerId && (
                    <span className="muted small">
                      Dono: {(tile as PropertyTile).ownerId === meId ? "Você" : ownerName ?? "Jogador"}
                    </span>
                  )}
                </>
              )}
              {tile.type === "tax" && <span className="badge tax">Imposto {tile.amount}</span>}
              {tile.type === "event" && <span className="badge event">Sorte/Revés</span>}
              {tile.type === "go-to-jail" && (
                <span className="badge" style={{ borderColor: "#ff7b7b", color: "#ff7b7b" }}>
                  Vá para prisão
                </span>
              )}
            </div>
            <div className="pawns">
              {tilePlayers.map((p, i) => (
                <span
                  key={p.id}
                  className="pawn"
                  style={{
                    background: colors.get(p.id) || playerColors[i % playerColors.length],
                    outline: p.id === currentPlayerId ? "2px solid rgba(255,255,255,0.8)" : "none"
                  }}
                  title={p.name}
                >
                  {p.name.slice(0, 1).toUpperCase()}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TileOverlay({
  awaitingTile,
  currentTile,
  eventCard,
  isMyTurn,
  onBuy,
  onPass,
  onDismissEvent
}: {
  awaitingTile?: PropertyTile;
  currentTile?: Tile;
  eventCard?: { title: string; description?: string; logId?: string } | null;
  isMyTurn: boolean;
  onBuy: () => void;
  onPass: () => void;
  onDismissEvent: () => void;
}) {
  const cards: JSX.Element[] = [];

  if (awaitingTile) {
    cards.push(
      <div
        className="tile-card"
        key="property"
        style={{ borderColor: awaitingTile.color, boxShadow: "0 12px 28px rgba(0,0,0,0.32)" }}
      >
        <div className="badge" style={{ borderColor: awaitingTile.color, color: awaitingTile.color }}>
          Propriedade
        </div>
        <h4>{awaitingTile.name}</h4>
        <p className="muted small">
          Preço {awaitingTile.price} · aluguel base {awaitingTile.baseRent}
        </p>
        <div className="actions-inline">
          <button className="primary" disabled={!isMyTurn} onClick={onBuy}>
            Comprar
          </button>
          <button className="ghost" disabled={!isMyTurn} onClick={onPass}>
            Passar compra
          </button>
        </div>
      </div>
    );
  }

  if (eventCard) {
    cards.push(
      <div className="tile-card" key="event">
        <div className="badge event">Sorte/Revés</div>
        <h4>{eventCard.title}</h4>
        <p className="muted small">{eventCard.description || "Carta sorteada. Veja o log para detalhes."}</p>
        <div className="actions-inline">
          <button className="primary" onClick={onDismissEvent}>
            Ok, continuar
          </button>
        </div>
      </div>
    );
  }

  if (!awaitingTile && currentTile?.type === "tax") {
    cards.push(
      <div className="tile-card" key="tax">
        <div className="badge tax">Imposto</div>
        <h4>{currentTile.name}</h4>
        <p className="muted small">Cobra automaticamente {currentTile.amount} ao cair nesta casa.</p>
      </div>
    );
  }

  if (!awaitingTile && currentTile?.type === "event" && !eventCard) {
    cards.push(
      <div className="tile-card" key="event-generic">
        <div className="badge event">Sorte/Revés</div>
        <h4>{currentTile.name}</h4>
        <p className="muted small">Carta puxada. Confira o log ou aguarde a ação automática.</p>
      </div>
    );
  }

  if (cards.length === 0) return null;
  return <div className="tile-overlay">{cards}</div>;
}

function Dice({ roll }: { roll: DiceRoll }) {
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    setAnimate(true);
    const t = setTimeout(() => setAnimate(false), 720);
    return () => clearTimeout(t);
  }, [roll.timestamp, roll.total]);

  return (
    <div className={`dice ${animate ? "animate" : ""}`}>
      <div className="die">{roll.values[0]}</div>
      <div className="die">{roll.values[1]}</div>
      <div className="muted small">Total {roll.total}</div>
    </div>
  );
}

function PlayerRow({
  player,
  color,
  isTurn,
  isMe,
  properties,
  cashBaseline
}: {
  player: PlayerState;
  color: string;
  isTurn: boolean;
  isMe: boolean;
  properties: PropertyTile[];
  cashBaseline: number;
}) {
  const balancePercent = Math.max(0, Math.min(1.2, player.money / (cashBaseline || 1)));
  const barWidth = Math.min(100, Math.max(6, Math.round(balancePercent * 100)));

  return (
    <div className={`player-row ${isTurn ? "turn" : ""}`}>
      <div className="avatar" style={{ background: color }}>
        {player.name.slice(0, 1).toUpperCase()}
      </div>
      <div className="player-meta">
        <div className="name-line">
          <strong>{player.name}</strong>
          {isMe && <span className="pill subtle">Você</span>}
          {player.bankrupt && <span className="pill danger">Falido</span>}
          {player.disconnected && <span className="pill warning">Off</span>}
          {isTurn && <span className="pill success">Turno</span>}
        </div>
        <div className="muted small">
          Dinheiro: {player.money} · Posição: {player.position} · Prisão: {player.inJailTurns}
        </div>
        <div className="money-bar">
          <div className="money-fill" style={{ width: `${barWidth}%` }} />
        </div>
        {properties.length > 0 && (
          <div className="prop-row">
            {properties.map((p) => (
              <span key={p.id} className="prop-pill" style={{ borderColor: p.color }}>
                {p.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function tileLabel(type: Tile["type"]) {
  switch (type) {
    case "start":
      return "Início";
    case "property":
      return "Propriedade";
    case "tax":
      return "Imposto";
    case "event":
      return "Sorte/Revés";
    case "jail":
      return "Prisão";
    case "go-to-jail":
      return "Vá para prisão";
    case "free":
      return "Pausa";
    default:
      return type;
  }
}

function buildTurnSteps(isMyTurn: boolean, turn?: GameState["turn"], awaitingTile?: PropertyTile | null) {
  const rolled = !!turn?.rolled;
  const awaiting = !!awaitingTile;
  return [
    {
      label: "Rolagem",
      status: rolled ? "done" : isMyTurn ? "active" : "",
      hint: rolled ? "Dados rolados" : "Rolar para avançar"
    },
    {
      label: "Resolver casa",
      status: rolled ? (awaiting ? "active" : "done") : "",
      hint: awaiting ? "Decida compra/imposto" : rolled ? "Casa resolvida" : "Após rolar"
    },
    {
      label: "Compra",
      status: awaiting ? "active" : rolled ? "done" : "",
      hint: awaiting ? "Comprar ou passar" : "Sem compra pendente"
    },
    {
      label: "Finalizar",
      status: isMyTurn && rolled && !awaiting ? "active" : rolled && !awaiting ? "done" : "",
      hint: isMyTurn ? "Finalize ou continue ações" : "Aguardando turno"
    }
  ];
}

function logBadge(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes("rolou")) return { label: "Rolagem", tone: "event" };
  if (lower.includes("comprou")) return { label: "Compra", tone: "event" };
  if (lower.includes("imposto")) return { label: "Imposto", tone: "tax" };
  if (lower.includes("pagou")) return { label: "Pagamento", tone: "tax" };
  if (lower.includes("recebeu") || lower.includes("bonus") || lower.includes("bônus")) return { label: "Recebido", tone: "event" };
  if (lower.includes("carta")) return { label: "Carta", tone: "event" };
  return null;
}

function buildCoords(size: number) {
  const coords: { row: number; col: number }[] = [];
  for (let c = 0; c < size; c++) coords.push({ row: size - 1, col: c });
  for (let r = size - 2; r >= 0; r--) coords.push({ row: r, col: size - 1 });
  for (let c = size - 2; c >= 0; c--) coords.push({ row: 0, col: c });
  for (let r = 1; r < size - 1; r++) coords.push({ row: r, col: 0 });
  return coords;
}

function ownedProperties(tiles: Tile[], playerId: string) {
  return tiles.filter((t) => t.type === "property" && (t as PropertyTile).ownerId === playerId) as PropertyTile[];
}
