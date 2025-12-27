export type TileType = "start" | "property" | "tax" | "event" | "jail" | "go-to-jail" | "free";

export type TileBase = {
  id: string;
  name: string;
  index: number;
  type: TileType;
};

export type StartTile = TileBase & {
  type: "start";
  bonus: number;
};

export type PropertyTile = TileBase & {
  type: "property";
  price: number;
  baseRent: number;
  color: string;
  ownerId?: string;
  mortgaged?: boolean;
};

export type TaxTile = TileBase & {
  type: "tax";
  amount: number;
};

export type EventTile = TileBase & {
  type: "event";
  cardId?: string;
};

export type JailTile = TileBase & {
  type: "jail";
  visiting?: boolean;
};

export type GoToJailTile = TileBase & {
  type: "go-to-jail";
};

export type FreeTile = TileBase & {
  type: "free";
};

export type Tile =
  | StartTile
  | PropertyTile
  | TaxTile
  | EventTile
  | JailTile
  | GoToJailTile
  | FreeTile;

export type EventCard = {
  id: string;
  title: string;
  description: string;
  effect: {
    money?: number;
    move?: number;
    toPosition?: number;
  };
};

export type PlayerState = {
  id: string;
  name: string;
  position: number;
  money: number;
  inJailTurns: number;
  bankrupt: boolean;
  disconnected?: boolean;
};

export type GameSettings = {
  startingCash: number;
  passStartBonus: number;
  maxPlayers: number;
  boardName: string;
  winCondition: "last-standing" | "highest-net-worth";
};

export type DiceRoll = {
  values: [number, number];
  total: number;
  timestamp: number;
};

export type LogEntry = {
  id: string;
  message: string;
  timestamp: number;
};

export type GameStatus = "lobby" | "active" | "finished";

export type TurnState = {
  currentPlayerId: string;
  dice?: DiceRoll;
  awaitingPurchase?: string;
  rolled: boolean;
  turnStartedAt: number;
};

export type GameState = {
  roomId: string;
  hostId: string;
  status: GameStatus;
  turnNumber?: number;
  players: PlayerState[];
  tiles: Tile[];
  settings: GameSettings;
  turn: TurnState;
  log: LogEntry[];
  deck: EventCard[];
  winnerId?: string;
};

export type ClientMessage =
  | { type: "createRoom"; playerName: string; settings?: Partial<GameSettings> }
  | { type: "joinRoom"; roomId: string; playerName: string }
  | { type: "reconnect"; roomId: string; playerId: string }
  | { type: "startGame" }
  | { type: "finishGame" }
  | { type: "rollDice" }
  | { type: "buyProperty"; propertyId: string }
  | { type: "passPurchase" }
  | { type: "endTurn" }
  | { type: "payBail" };

export type ServerMessage =
  | { type: "roomCreated"; roomId: string }
  | { type: "joined"; playerId: string; roomId: string }
  | { type: "state"; state: GameState }
  | { type: "error"; message: string }
  | { type: "log"; entry: LogEntry }
  | { type: "dice"; roll: DiceRoll };

export const DEFAULT_SETTINGS: GameSettings = {
  startingCash: 1500,
  passStartBonus: 200,
  maxPlayers: 12,
  boardName: "Aurora",
  winCondition: "last-standing"
};

export const EVENT_CARDS: EventCard[] = [
  {
    id: "bonus-100",
    title: "Bônus inesperado",
    description: "Receba 100",
    effect: { money: 100 }
  },
  {
    id: "tax-100",
    title: "Imposto especial",
    description: "Pague 100",
    effect: { money: -100 }
  },
  {
    id: "avanço-3",
    title: "Avance 3 casas",
    description: "Move 3 casas à frente",
    effect: { move: 3 }
  },
  {
    id: "volta-2",
    title: "Volte 2 casas",
    description: "Retrocede 2 casas",
    effect: { move: -2 }
  }
];

export const DEFAULT_BOARD: Tile[] = [
  { id: "start", name: "Início", index: 0, type: "start", bonus: 200 },
  { id: "p1", name: "Lago Azul", index: 1, type: "property", price: 100, baseRent: 25, color: "#5FB3B3" },
  { id: "p2", name: "Praça Solar", index: 2, type: "property", price: 120, baseRent: 30, color: "#5FB3B3" },
  { id: "tax1", name: "Imposto de Renda", index: 3, type: "tax", amount: 150 },
  { id: "event1", name: "Sorte/Reves", index: 4, type: "event" },
  { id: "p3", name: "Vila Sombra", index: 5, type: "property", price: 140, baseRent: 35, color: "#E27D60" },
  { id: "p4", name: "Jardim Âmbar", index: 6, type: "property", price: 160, baseRent: 40, color: "#E27D60" },
  { id: "jail", name: "Prisao/Visita", index: 7, type: "jail" },
  { id: "p5", name: "Mar Turquesa", index: 8, type: "property", price: 180, baseRent: 45, color: "#4D9DE0" },
  { id: "p6", name: "Orla Safira", index: 9, type: "property", price: 200, baseRent: 50, color: "#4D9DE0" },
  { id: "tax2", name: "Imposto de Luxo", index: 10, type: "tax", amount: 100 },
  { id: "event2", name: "Sorte/Reves", index: 11, type: "event" },
  { id: "p7", name: "Vale Rubi", index: 12, type: "property", price: 220, baseRent: 55, color: "#C06C84" },
  { id: "p8", name: "Forte Carmim", index: 13, type: "property", price: 240, baseRent: 60, color: "#C06C84" },
  { id: "free", name: "Pausa Zen", index: 14, type: "free" },
  { id: "p9", name: "Distrito Âmbar", index: 15, type: "property", price: 260, baseRent: 65, color: "#F67280" },
  { id: "p10", name: "Colina Coral", index: 16, type: "property", price: 280, baseRent: 70, color: "#F67280" },
  { id: "event3", name: "Sorte/Reves", index: 17, type: "event" },
  { id: "p11", name: "Aurora Prime", index: 18, type: "property", price: 300, baseRent: 75, color: "#355C7D" },
  { id: "go-to-jail", name: "Vá para Prisão", index: 19, type: "go-to-jail" }
];

export const DEFAULT_SETTINGS_OPTIONS = {
  minPlayers: 2,
  maxPlayers: 12,
  minStartingCash: 500,
  maxStartingCash: 4000
};
