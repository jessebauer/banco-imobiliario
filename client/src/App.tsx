import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ClientMessage,
  DiceRoll,
  GameState,
  EVENT_CARDS,
  PlayerState,
  PropertyTile,
  RoomSummary,
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
type ActionOption = {
  label: string;
  action?: () => void;
  disabled?: boolean;
  tone?: "primary" | "ghost" | "danger";
  icon?: string;
  detail?: string;
};

export default function App() {
  const [mode, setMode] = useState<ConnectionMode>("host");
  const [serverUrl, setServerUrl] = useState(() => {
    if (typeof window === "undefined") return "ws://localhost:4000";
    const host = window.location.hostname || "localhost";
    return `ws://${host}:4000`;
  });
  const [name, setName] = useState(defaultName);
  const [roomInput, setRoomInput] = useState("");
  const [game, setGame] = useState<GameState | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [lastRoll, setLastRoll] = useState<DiceRoll | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [availableRooms, setAvailableRooms] = useState<RoomSummary[]>([]);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [createdRoomId, setCreatedRoomId] = useState<string | null>(null);
  const [lastMovedTileId, setLastMovedTileId] = useState<string | null>(null);
  const [seenEventLogId, setSeenEventLogId] = useState<string | null>(null);
  const [theme, setTheme] = useState<"classic" | "contrast">("classic");
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 900px)").matches : false
  );
  const [isActionSheetOpen, setIsActionSheetOpen] = useState(false);
  const [displayPositions, setDisplayPositions] = useState<Map<string, number>>(new Map());
  const [isAnimatingMove, setIsAnimatingMove] = useState(false);
  const [animatingPlayerId, setAnimatingPlayerId] = useState<string | null>(null);
  const [autoFocusMobile, setAutoFocusMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem("autoFocusMobile");
    return stored ? stored === "true" : true;
  });
  const boardRef = useRef<HTMLDivElement | null>(null);
  const tileRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [tileCenters, setTileCenters] = useState<Map<string, { x: number; y: number }>>(new Map());
  const previousGameRef = useRef<GameState | null>(null);
  const animationCancelRef = useRef<{ cancelled: boolean } | null>(null);
  const measureRafRef = useRef<number | null>(null);
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

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("autoFocusMobile", String(autoFocusMobile));
  }, [autoFocusMobile]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => setIsMobile(window.matchMedia("(max-width: 900px)").matches);
    handler();
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  const httpServerBase = useMemo(() => {
    if (!serverUrl) return "";
    if (serverUrl.startsWith("ws://") || serverUrl.startsWith("wss://")) {
      return serverUrl.replace("ws://", "http://").replace("wss://", "https://");
    }
    if (serverUrl.startsWith("http://") || serverUrl.startsWith("https://")) {
      return serverUrl;
    }
    return `http://${serverUrl}`;
  }, [serverUrl]);

  const connect = (payload: ClientMessage, targetServer = serverUrl) => {
    setConnecting(true);
    setError(null);
    if (!targetServer.startsWith("ws://") && !targetServer.startsWith("wss://")) {
      setConnecting(false);
      setError("Endereço do servidor deve começar com ws:// ou wss://");
      return;
    }
    if (ws) {
      suppressReconnectRef.current = true;
      ws.close();
    }
    let socket: WebSocket;
    try {
      socket = new WebSocket(targetServer);
    } catch (err: any) {
      setConnecting(false);
      setError("Não foi possível abrir conexão com o servidor. Verifique o endereço e a rede.");
      return;
    }
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
    socket.onerror = () => {
      setError("Falha ao comunicar com o servidor. Confira IP/porta e se o servidor está rodando.");
      setConnecting(false);
    };
    socket.onclose = () => {
      if (suppressReconnectRef.current) {
        suppressReconnectRef.current = false;
        return;
      }
      setConnecting(false);
      if (reconnectRef.current) {
        setInfo("Conexão perdida. Tentando reconectar...");
      } else {
        setError("Conexão perdida. Confira se o servidor está acessível na rede.");
      }
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

  const fetchRooms = useCallback(async () => {
    if (!httpServerBase) return;
    setRoomsError(null);
    setLoadingRooms(true);
    try {
      const res = await fetch(`${httpServerBase}/rooms`);
      if (!res.ok) {
        throw new Error("Não foi possível listar as salas.");
      }
      const data = (await res.json()) as { rooms?: RoomSummary[] };
      const rooms = (data.rooms ?? []).filter((room) => room.connectedCount > 0);
      setAvailableRooms(rooms);
    } catch (err: any) {
      const friendly =
        err instanceof Error && err.message.includes("Failed to fetch")
          ? "Não foi possível carregar as salas. Confira o endereço do servidor."
          : err?.message ?? "Erro ao buscar salas.";
      setRoomsError(friendly);
      setAvailableRooms([]);
    } finally {
      setLoadingRooms(false);
    }
  }, [httpServerBase]);

  useEffect(() => {
    if (mode !== "join") {
      setRoomsError(null);
      setAvailableRooms([]);
      return;
    }
    if (!httpServerBase) return;
    fetchRooms();
    if (typeof window === "undefined") return;
    const interval = window.setInterval(fetchRooms, 5000);
    return () => window.clearInterval(interval);
  }, [mode, fetchRooms, httpServerBase]);

  const handleQuickJoin = (roomId: string) => {
    setRoomInput(roomId);
    connect({ type: "joinRoom", roomId, playerName: name });
  };

  const measureTiles = useCallback(() => {
    if (!boardRef.current) return;
    const centers = new Map<string, { x: number; y: number }>();
    tileRefs.current.forEach((el, id) => {
      centers.set(id, {
        x: el.offsetLeft + el.clientWidth / 2,
        y: el.offsetTop + el.clientHeight / 2
      });
    });
    setTileCenters(centers);
  }, []);

  const scheduleMeasure = useCallback(() => {
    if (typeof window === "undefined") return;
    if (measureRafRef.current) window.cancelAnimationFrame(measureRafRef.current);
    measureRafRef.current = window.requestAnimationFrame(() => {
      measureTiles();
      measureRafRef.current = null;
    });
  }, [measureTiles]);

  const registerTileRef = useCallback(
    (tileId: string, el: HTMLDivElement | null) => {
      if (!el) {
        tileRefs.current.delete(tileId);
        return;
      }
      tileRefs.current.set(tileId, el);
      scheduleMeasure();
    },
    [scheduleMeasure]
  );

  useLayoutEffect(() => {
    scheduleMeasure();
    return () => {
      if (measureRafRef.current) {
        cancelAnimationFrame(measureRafRef.current);
        measureRafRef.current = null;
      }
    };
  }, [game?.tiles.length, isMobile, scheduleMeasure]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handle = () => scheduleMeasure();
    window.addEventListener("resize", handle);
    return () => window.removeEventListener("resize", handle);
  }, [scheduleMeasure]);

  const focusOnTileIndex = useCallback(
    (tileIndex: number, behavior: ScrollBehavior = "smooth") => {
      if (!isMobile || !autoFocusMobile) return;
      const tile = game?.tiles.find((t) => t.index === tileIndex);
      if (!tile) return;
      const el = tileRefs.current.get(tile.id);
      if (el) {
        el.scrollIntoView({ behavior, inline: "center", block: "center" });
      }
    },
    [autoFocusMobile, game?.tiles, isMobile]
  );

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
    if (!session?.roomId || !httpServerBase) return "";
    const url = `${httpServerBase}?room=${session.roomId}&server=${encodeURIComponent(serverUrl)}`;
    return url;
  }, [httpServerBase, serverUrl, session]);

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

  useEffect(() => {
    if (!game) {
      setDisplayPositions(new Map());
      previousGameRef.current = null;
      setIsAnimatingMove(false);
      setAnimatingPlayerId(null);
      return;
    }
    const prevGame = previousGameRef.current;
    setDisplayPositions((prev) => {
      const next = new Map(prev);
      game.players.forEach((p) => {
        const prevPos = prevGame?.players.find((prevPlayer) => prevPlayer.id === p.id)?.position;
        const hasMoved = prevPos !== undefined && prevPos !== p.position;
        const isCurrentAnimating = isAnimatingMove && animatingPlayerId === p.id;

        if (isCurrentAnimating) return;

        if (hasMoved && prevPos !== undefined) {
          // Keep pawn at the previous tile until the animation progresses.
          next.set(p.id, prevPos);
        } else if (!prev.has(p.id) || !isAnimatingMove || animatingPlayerId !== p.id) {
          next.set(p.id, p.position);
        }
      });
      return next;
    });
  }, [animatingPlayerId, game, isAnimatingMove]);

  const statusLabel =
    game?.status === "active" ? "Partida em andamento" : game?.status === "finished" ? "Partida encerrada" : "Sala aberta";

  const turnSteps = buildTurnSteps(isMyTurn, game?.turn, awaitingTile);
  const lastLogEntry = useMemo(() => (game?.log.length ? game.log[game.log.length - 1] : null), [game?.log]);

  const animatePlayerMovement = useCallback(
    async ({
      playerId,
      from,
      to,
      steps,
      tilesCount
    }: {
      playerId: string;
      from: number;
      to: number;
      steps: number;
      tilesCount: number;
    }) => {
      if (tilesCount <= 0) return;
      if (animationCancelRef.current) {
      animationCancelRef.current.cancelled = true;
    }
    const token = { cancelled: false };
    animationCancelRef.current = token;
    setIsAnimatingMove(true);
    setAnimatingPlayerId(playerId);
    setDisplayPositions((prev) => {
      const next = new Map(prev);
      next.set(playerId, from);
      return next;
    });
    focusOnTileIndex(from, "smooth");
    let current = from;
    const path = buildStepPath(from, steps, tilesCount);
    for (const pos of path) {
      if (token.cancelled) return;
        current = pos;
        setDisplayPositions((prev) => {
          const next = new Map(prev);
          next.set(playerId, pos);
          return next;
        });
        focusOnTileIndex(pos, "smooth");
        await sleep(380);
      }
      if (!token.cancelled && current !== to) {
        setDisplayPositions((prev) => {
          const next = new Map(prev);
          next.set(playerId, to);
          return next;
        });
        focusOnTileIndex(to, "smooth");
        current = to;
        await sleep(420);
      }
      if (!token.cancelled) {
        setDisplayPositions((prev) => {
          const next = new Map(prev);
          next.set(playerId, to);
          return next;
        });
      }
      if (token.cancelled) return;
      animationCancelRef.current = null;
      setIsAnimatingMove(false);
      setAnimatingPlayerId(null);
    },
    [focusOnTileIndex]
  );

  useEffect(() => {
    if (!game) return;
    const prev = previousGameRef.current;
    const tilesCount = game.tiles.length;
    const activeId = game.turn.currentPlayerId;
    const currentPlayer = game.players.find((p) => p.id === activeId);
    const prevPlayer = prev?.players.find((p) => p.id === activeId);
    if (prev && prevPlayer && currentPlayer && prevPlayer.position !== currentPlayer.position) {
      const diceChanged =
        !!game.turn.dice && (!prev.turn.dice || prev.turn.dice.timestamp !== game.turn.dice.timestamp);
      const steps = diceChanged
        ? game.turn.dice!.total
        : wrappedDelta(prevPlayer.position, currentPlayer.position, tilesCount);
      animatePlayerMovement({ playerId: activeId, from: prevPlayer.position, to: currentPlayer.position, steps, tilesCount });
    } else if (!prev && currentPlayer) {
      focusOnTileIndex(currentPlayer.position, "auto");
    }
    const turnChanged = prev?.turn.currentPlayerId !== game.turn.currentPlayerId;
    if (turnChanged && currentPlayer) {
      focusOnTileIndex(currentPlayer.position, "smooth");
    }
    previousGameRef.current = game;
    scheduleMeasure();
  }, [animatePlayerMovement, focusOnTileIndex, game, scheduleMeasure]);

  const primaryAction = useMemo<ActionOption>(() => {
    if (!game) return { label: "Conecte-se para jogar", disabled: true, tone: "ghost", icon: "⏳" };
    if (game.status === "lobby" && game.hostId === session?.playerId) {
      return {
        label: "Iniciar partida",
        action: () => send({ type: "startGame" }),
        tone: "primary",
        icon: "🚀",
        disabled: isAnimatingMove
      };
    }
    if (!isMyTurn) return { label: "Aguardando turno", disabled: true, tone: "ghost", icon: "⏳" };
    if (!game.turn.rolled)
      return {
        label: "Rolar dados",
        action: () => send({ type: "rollDice" }),
        tone: "primary",
        icon: "🎲",
        disabled: isAnimatingMove
      };
    if (awaitingTile)
      return {
        label: "Comprar",
        action: () => send({ type: "buyProperty", propertyId: awaitingTile.id }),
        tone: "primary",
        icon: "💰",
        disabled: isAnimatingMove
      };
    return {
      label: "Finalizar turno",
      action: () => send({ type: "endTurn" }),
      tone: "primary",
      icon: "✅",
      disabled: isAnimatingMove
    };
  }, [awaitingTile, game, isAnimatingMove, isMyTurn, send, session?.playerId]);

  const secondaryActions = useMemo<ActionOption[]>(() => {
    const actions: ActionOption[] = [];
    if (isMyTurn && awaitingTile) {
      actions.push({ label: "Passar compra", action: () => send({ type: "passPurchase" }), icon: "↩", disabled: isAnimatingMove });
    }
    if (isMyTurn && me?.inJailTurns) {
      actions.push({ label: "Pagar fiança", action: () => send({ type: "payBail" }), icon: "🪙", disabled: isAnimatingMove });
    }
    if (game?.hostId === session?.playerId && game?.status === "active") {
      actions.push({
        label: "Encerrar por patrimônio",
        action: () => send({ type: "finishGame" }),
        icon: "🏁",
        disabled: isAnimatingMove
      });
    }
    if (game?.hostId === session?.playerId && game?.status === "lobby") {
      actions.push({ label: "Iniciar partida", action: () => send({ type: "startGame" }), icon: "🚀", disabled: isAnimatingMove });
    }
    return actions.filter((a) => a.label !== primaryAction.label);
  }, [awaitingTile, game, isAnimatingMove, isMyTurn, me?.inJailTurns, primaryAction.label, send, session?.playerId]);

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
    <div className={`page ${isMobile ? "is-mobile" : ""}`}>
      {isMobile && (
        <MobileHud
          money={me?.money ?? game?.settings.startingCash ?? 0}
          playerName={me?.name || name}
          isMyTurn={isMyTurn}
          statusLabel={statusLabel}
          theme={theme}
          onToggleTheme={() => setTheme(theme === "classic" ? "contrast" : "classic")}
          lastRoll={lastRoll}
          logSnippet={lastLogEntry?.message}
        />
      )}
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
          {mode === "join" && (
            <div className="rooms-panel">
              <div className="rooms-header">
                <div>
                  <p className="eyebrow">Salas com jogadores</p>
                  <p className="muted">Clique para preencher o código e entrar direto.</p>
                </div>
                <button className="ghost" onClick={fetchRooms} disabled={loadingRooms}>
                  {loadingRooms ? "Atualizando..." : "Atualizar lista"}
                </button>
              </div>
              {roomsError && <span className="error">{roomsError}</span>}
              {loadingRooms && !availableRooms.length ? (
                <p className="muted">Carregando salas abertas...</p>
              ) : availableRooms.length === 0 ? (
                <p className="muted">Nenhuma sala com jogadores online neste servidor.</p>
              ) : (
                <div className="rooms-grid">
                  {availableRooms.map((room) => {
                    const isJoinable = room.status === "lobby";
                    const statusLabel =
                      room.status === "lobby"
                        ? "Sala aberta"
                        : room.status === "active"
                          ? "Partida em andamento"
                          : "Encerrada";
                    const visiblePlayers = room.players.slice(0, 5);
                    const hiddenCount = room.players.length - visiblePlayers.length;
                    return (
                      <button
                        key={room.id}
                        className={`room-card ${isJoinable ? "" : "disabled"}`}
                        onClick={() => handleQuickJoin(room.id)}
                        disabled={!isJoinable || connecting}
                        title={isJoinable ? "Entrar rapidamente" : "Partida já iniciada"}
                      >
                        <div className="room-card-head">
                          <div>
                            <p className="muted small">Sala</p>
                            <div className="room-code">{room.id}</div>
                          </div>
                          <div className="room-chip">
                            <span className={`chip ${room.status}`}>{statusLabel}</span>
                            <span className="badge">
                              {room.connectedCount} jogador{room.connectedCount === 1 ? "" : "es"} online
                            </span>
                          </div>
                        </div>
                        <div className="room-meta">
                          <span className="muted">
                            Anfitrião: <strong>{room.hostName ?? "Indefinido"}</strong>
                          </span>
                        </div>
                        <div className="pill-row">
                          {visiblePlayers.map((p) => (
                            <span key={p.id} className="pill success">
                              {p.name}
                            </span>
                          ))}
                          {hiddenCount > 0 && <span className="pill subtle">+{hiddenCount}</span>}
                        </div>
                        <p className="room-footer">
                          {isJoinable ? "Entrar com 1 clique" : "Partida já iniciada"}
                        </p>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
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
                compact={isMobile}
                displayPositions={displayPositions}
                tileCenters={tileCenters}
                registerTileRef={registerTileRef}
                boardRef={boardRef}
                animatingPlayerId={animatingPlayerId}
              />
              <TileOverlay
                awaitingTile={awaitingTile || undefined}
                currentTile={currentTile}
                eventCard={shouldShowEventCard ? lastEventCard : null}
                isMyTurn={isMyTurn}
                isAnimating={isAnimatingMove}
                onBuy={() => awaitingTile && send({ type: "buyProperty", propertyId: awaitingTile.id })}
                onPass={() => send({ type: "passPurchase" })}
                onDismissEvent={() => lastEventCard && setSeenEventLogId(lastEventCard.logId)}
              />
              {isMobile && lastLogEntry && (
                <div className="mobile-last-log">
                  <div className="dot" />
                  <div className="text">
                    <p className="muted small">Última ação</p>
                    <strong>{lastLogEntry.message}</strong>
                  </div>
                  <span className="badge event">Log</span>
                </div>
              )}
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
              <button disabled={!isMyTurn || !!game?.turn.rolled || isAnimatingMove} onClick={() => send({ type: "rollDice" })}>
                Rolar dados
              </button>
              <button
                disabled={!isMyTurn || !awaitingTile || isAnimatingMove}
                onClick={() => awaitingTile && send({ type: "buyProperty", propertyId: awaitingTile.id })}
                className="primary"
              >
                Comprar
              </button>
              <button disabled={!isMyTurn || !awaitingTile || isAnimatingMove} onClick={() => send({ type: "passPurchase" })}>
                Passar compra
              </button>
              <button disabled={!isMyTurn || isAnimatingMove} onClick={() => send({ type: "endTurn" })}>
                Finalizar turno
              </button>
              <button disabled={!isMyTurn || !me?.inJailTurns || isAnimatingMove} onClick={() => send({ type: "payBail" })}>
                Pagar fiança
              </button>
              {game?.hostId === session?.playerId && game?.status === "active" && (
                <button onClick={handleFinishNetWorth} disabled={isAnimatingMove}>
                  Encerrar por patrimônio
                </button>
              )}
              {game?.hostId === session?.playerId && game?.status === "lobby" && (
                <button onClick={() => send({ type: "startGame" })} className="primary" disabled={isAnimatingMove}>
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

          <div className="panel">
            <div className="panel-header">
              <h3>Configurações</h3>
              <span className="muted">Mobile</span>
            </div>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={autoFocusMobile}
                onChange={(e) => setAutoFocusMobile(e.target.checked)}
              />
              <div className="toggle-copy">
                <strong>Foco automático</strong>
                <p className="muted small">Acompanha o jogador ativo durante a movimentação.</p>
              </div>
            </label>
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
      {isMobile && game && (
        <MobileActionBar
          primary={primaryAction}
          secondary={secondaryActions}
          isOpen={isActionSheetOpen}
          onToggle={() => setIsActionSheetOpen((open) => !open)}
          lastRoll={lastRoll}
          lastLog={lastLogEntry?.message}
          isMyTurn={isMyTurn}
        />
      )}
    </div>
  );
}

function MobileHud({
  money,
  playerName,
  isMyTurn,
  statusLabel,
  theme,
  onToggleTheme,
  lastRoll,
  logSnippet
}: {
  money: number;
  playerName?: string;
  isMyTurn: boolean;
  statusLabel: string;
  theme: "classic" | "contrast";
  onToggleTheme: () => void;
  lastRoll: DiceRoll | null;
  logSnippet?: string;
}) {
  return (
    <div className="mobile-hud">
      <div className="hud-main">
        <div className="hud-left">
          <span className={`turn-icon ${isMyTurn ? "active" : ""}`}>{isMyTurn ? "🟢" : "⏳"}</span>
          <div>
            <p className="eyebrow">Dinheiro</p>
            <div className="money-large">{money.toLocaleString("pt-BR")}</div>
            <div className="muted small">{playerName}</div>
          </div>
        </div>
        <div className="hud-actions">
          <span className="chip inline">{statusLabel}</span>
          <button className="icon-button" onClick={onToggleTheme} aria-label="Alternar tema">
            {theme === "classic" ? "☀️" : "🌙"}
          </button>
          <button className="icon-button" aria-label="Menu rápido">
            ⋮
          </button>
        </div>
      </div>
      <div className="hud-meta">
        {lastRoll && (
          <span className="pill subtle">
            🎲 {lastRoll.values.join(" + ")} = {lastRoll.total}
          </span>
        )}
        {logSnippet && <span className="pill subtle">📝 {logSnippet}</span>}
      </div>
    </div>
  );
}

function MobileActionBar({
  primary,
  secondary,
  isOpen,
  onToggle,
  lastRoll,
  lastLog,
  isMyTurn
}: {
  primary: ActionOption;
  secondary: ActionOption[];
  isOpen: boolean;
  onToggle: () => void;
  lastRoll: DiceRoll | null;
  lastLog?: string | null;
  isMyTurn: boolean;
}) {
  const handlePrimary = () => {
    if (!primary.action || primary.disabled) return;
    primary.action();
  };
  const hasSheet = secondary.length > 0;

  return (
    <div className={`mobile-action-bar ${isOpen ? "open" : ""}`}>
      <div className="action-main">
        <div className={`turn-indicator ${isMyTurn ? "on" : ""}`}>{isMyTurn ? "🟢" : "⏳"}</div>
        <button
          className={`primary-action ${primary.tone ?? "ghost"}`}
          disabled={primary.disabled}
          onClick={handlePrimary}
        >
          {primary.icon && <span className="emoji">{primary.icon}</span>}
          <span>{primary.label}</span>
        </button>
        {hasSheet && (
          <button className="sheet-toggle" onClick={onToggle} aria-label="Ações secundárias">
            {isOpen ? "Fechar" : "Ações"}
          </button>
        )}
      </div>
      {hasSheet && (
        <div className="mobile-sheet">
          <div className="sheet-handle" onClick={onToggle} />
          <div className="secondary-grid">
            {secondary.map((action) => (
              <button
                key={action.label}
                className={`secondary-action ${action.tone ?? ""}`}
                disabled={action.disabled}
                onClick={() => action.action && action.action()}
              >
                {action.icon && <span className="emoji">{action.icon}</span>}
                <div className="text">
                  <span>{action.label}</span>
                  {action.detail && <span className="muted small">{action.detail}</span>}
                </div>
              </button>
            ))}
          </div>
          <div className="sheet-foot">
            {lastRoll && (
              <span className="pill subtle">
                🎲 {lastRoll.values.join(" + ")} = {lastRoll.total}
              </span>
            )}
            {lastLog && <span className="pill subtle">📝 {lastLog}</span>}
          </div>
        </div>
      )}
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
  lastMovedTileId,
  compact,
  displayPositions,
  tileCenters,
  registerTileRef,
  boardRef,
  animatingPlayerId
}: {
  tiles: Tile[];
  coords: { row: number; col: number }[];
  players: PlayerState[];
  currentPlayerId?: string;
  meId?: string;
  colors: Map<string, string>;
  lastMovedTileId?: string;
  compact?: boolean;
  displayPositions: Map<string, number>;
  tileCenters: Map<string, { x: number; y: number }>;
  registerTileRef?: (tileId: string, el: HTMLDivElement | null) => void;
  boardRef?: React.RefObject<HTMLDivElement>;
  animatingPlayerId?: string | null;
}) {
  const boardClass = `board ${compact ? "compact" : ""}`;
  const stacks = useMemo(() => {
    const grouped = new Map<number, string[]>();
    players.forEach((p) => {
      if (p.bankrupt) return;
      const pos = displayPositions.get(p.id) ?? p.position;
      const list = grouped.get(pos) ?? [];
      list.push(p.id);
      grouped.set(pos, list);
    });
    return grouped;
  }, [displayPositions, players]);
  return (
    <div className={boardClass} ref={boardRef}>
      {tiles.map((tile, idx) => {
        const pos = coords[idx];
        const tilePlayers = players.filter((p) => {
          const displayPos = displayPositions.get(p.id) ?? p.position;
          return displayPos === tile.index && !p.bankrupt;
        });
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
        const tileStyle = compact
          ? { ["--tile-accent" as any]: accent }
          : { gridRow: pos.row + 1, gridColumn: pos.col + 1, ["--tile-accent" as any]: accent };
        return (
          <div
            key={tile.id}
            className={tileClass}
            style={tileStyle}
            ref={(el) => registerTileRef?.(tile.id, el)}
          >
            <div className="tile-header">
              <span className="tile-icon">{tileGlyph(tile.type)}</span>
              <div className="tile-title">
                <span className="tile-type">{tileLabel(tile.type)}</span>
                <span className="tile-name">{tile.name}</span>
              </div>
            </div>
            <div className="tile-body">
              {tile.type === "property" && (
                <>
                  <div className="price-line">
                    <span className="pill">Preço {tile.price}</span>
                    <div className="rent-highlight">
                      <span className="rent-label">Aluguel</span>
                      <span className="rent-value">{(tile as PropertyTile).baseRent}</span>
                    </div>
                  </div>
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
          </div>
        );
      })}
      <div className="pawn-layer">
        {players
          .filter((p) => !p.bankrupt)
          .map((player) => {
            const pos = displayPositions.get(player.id) ?? player.position;
            const tile = tiles.find((t) => t.index === pos);
            if (!tile) return null;
            const center = tileCenters.get(tile.id);
            if (!center) return null;
            const stack = stacks.get(pos) ?? [];
            const stackIndex = Math.max(0, stack.indexOf(player.id));
            const offset = pawnOffset(stackIndex);
            const baseColor = colors.get(player.id) || playerColors[stackIndex % playerColors.length];
            const style = center
              ? {
                  ["--x" as any]: `${center.x + offset.x}px`,
                  ["--y" as any]: `${center.y + offset.y}px`,
                  background: baseColor
                }
              : undefined;
            const isActive = player.id === currentPlayerId;
            const isMoving = animatingPlayerId === player.id;
            const isMeHere = player.id === meId;
            return (
              <div
                key={player.id}
                className={`floating-pawn ${isActive ? "active" : ""} ${isMoving ? "moving" : ""} ${isMeHere ? "me" : ""}`}
                style={style}
                title={player.name}
              >
                <span className="initial">{player.name.slice(0, 1).toUpperCase()}</span>
              </div>
            );
          })}
      </div>
    </div>
  );
}

function TileOverlay({
  awaitingTile,
  currentTile,
  eventCard,
  isMyTurn,
  isAnimating,
  onBuy,
  onPass,
  onDismissEvent
}: {
  awaitingTile?: PropertyTile;
  currentTile?: Tile;
  eventCard?: { title: string; description?: string; logId?: string } | null;
  isMyTurn: boolean;
  isAnimating: boolean;
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
          <button className="primary" disabled={!isMyTurn || isAnimating} onClick={onBuy}>
            Comprar
          </button>
          <button className="ghost" disabled={!isMyTurn || isAnimating} onClick={onPass}>
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
          <button className="primary" onClick={onDismissEvent} disabled={isAnimating}>
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

function tileGlyph(type: Tile["type"]) {
  switch (type) {
    case "property":
      return "🏠";
    case "tax":
      return "💰";
    case "event":
      return "🎲";
    case "jail":
    case "go-to-jail":
      return "🚓";
    case "start":
      return "🏁";
    case "free":
      return "⏸️";
    default:
      return "⬢";
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

function buildStepPath(start: number, steps: number, size: number) {
  if (size <= 0 || steps === 0) return [];
  const direction = steps >= 0 ? 1 : -1;
  const count = Math.abs(steps);
  const path: number[] = [];
  for (let i = 1; i <= count; i++) {
    let next = (start + direction * i) % size;
    if (next < 0) next += size;
    path.push(next);
  }
  return path;
}

function wrappedDelta(from: number, to: number, size: number) {
  if (size === 0) return 0;
  const forward = ((to - from) % size + size) % size;
  const backward = -(((from - to) % size + size) % size);
  return Math.abs(backward) < forward ? backward : forward;
}

function pawnOffset(index: number) {
  const offsets = [
    { x: 0, y: 0 },
    { x: 16, y: 0 },
    { x: -16, y: 0 },
    { x: 0, y: 16 },
    { x: 0, y: -16 },
    { x: 14, y: 14 },
    { x: -14, y: -14 },
    { x: 14, y: -14 },
    { x: -14, y: 14 }
  ];
  const safeIndex = index >= 0 ? index % offsets.length : 0;
  return offsets[safeIndex];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
