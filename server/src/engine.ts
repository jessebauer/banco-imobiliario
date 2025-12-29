import {
  DEFAULT_BOARD,
  DEFAULT_SETTINGS,
  DiceRoll,
  EventCard,
  EVENT_CARDS,
  GameSettings,
  GameState,
  LogEntry,
  PlayerState,
  PropertyTile,
  Tile,
  MAX_PROPERTY_LEVEL,
  PROPERTY_PRICE_MULTIPLIER,
  PROPERTY_RENT_MULTIPLIER,
  propertyAssetValue,
  propertyRent,
  propertyUpgradeCost
} from "@banco/shared";
import { nanoid } from "nanoid";

const BAIL_COST = 50;
const MAX_JAIL_TURNS = 3;

export class GameEngine {
  state: GameState;

  constructor(roomId: string, hostName: string, settings?: Partial<GameSettings>) {
    const hostId = nanoid(8);
    const merged = sanitizeSettings(settings);
    this.state = {
      roomId,
      hostId,
      status: "lobby",
      players: [
        {
          id: hostId,
          name: hostName,
          money: merged.startingCash,
          position: 0,
          inJailTurns: 0,
          bankrupt: false
        }
      ],
      tiles: cloneBoard(DEFAULT_BOARD),
      settings: merged,
      turnNumber: 1,
      turn: {
        currentPlayerId: hostId,
        rolled: false,
        turnStartedAt: Date.now(),
        awaitingUpgrade: undefined
      },
      log: [],
      deck: shuffle(EVENT_CARDS.map((c) => ({ ...c })))
    };
    this.log(`Sala ${roomId} criada por ${hostName}`);
  }

  addPlayer(name: string) {
    if (this.state.players.length >= this.state.settings.maxPlayers) {
      throw new Error("Sala cheia");
    }
    const id = nanoid(8);
    const player: PlayerState = {
      id,
      name,
      money: this.state.settings.startingCash,
      position: 0,
      inJailTurns: 0,
      bankrupt: false
    };
    this.state.players.push(player);
    this.log(`${name} entrou na sala`);
    return player;
  }

  startGame() {
    if (this.state.status !== "lobby") throw new Error("Partida já iniciada");
    if (this.state.players.length < 2) throw new Error("Precisa de pelo menos 2 jogadores");
    this.state.status = "active";
    const starting =
      this.getPlayer(this.state.hostId)?.bankrupt === false
        ? this.state.hostId
        : this.nextAlivePlayer(this.state.hostId);
    this.state.turn = {
      currentPlayerId: starting,
      rolled: false,
      turnStartedAt: Date.now()
    };
    this.log("Partida iniciada");
  }

  reconnect(playerId: string) {
    const player = this.getPlayer(playerId);
    if (!player) throw new Error("Jogador desconhecido");
    player.disconnected = false;
    return player;
  }

  rollDice(playerId: string) {
    this.ensureActivePlayer(playerId);
    const player = this.getPlayer(playerId);
    if (!player || player.bankrupt) throw new Error("Jogador inválido");
    if (this.state.turn.rolled) throw new Error("Dados já foram rolados neste turno.");
    if (this.state.turn.awaitingPurchase) throw new Error("Decida comprar ou passar a propriedade antes.");
    const wasInJail = player.inJailTurns > 0;

    const roll: DiceRoll = {
      values: [rollDie(), rollDie()],
      total: 0,
      timestamp: Date.now()
    };
    roll.total = roll.values[0] + roll.values[1];
    this.state.turn.dice = roll;
    this.state.turn.rolled = true;

    const isDouble = roll.values[0] === roll.values[1];
    if (wasInJail) {
      if (isDouble) {
        player.inJailTurns = 0;
        this.log(`${player.name} tirou duplo e saiu da prisão.`);
        this.movePlayer(player, roll.total);
        this.log(`${player.name} rolou ${roll.values[0]} + ${roll.values[1]} = ${roll.total}`);
        const tile = this.state.tiles[player.position];
        this.resolveTile(player, tile);
        this.checkVictory();
        return roll;
      }

      if (player.inJailTurns === 1) {
        this.chargeBank(
          player,
          BAIL_COST,
          `${player.name} pagou fiança (${BAIL_COST}) após ${MAX_JAIL_TURNS} turnos na prisão.`
        );
        if (player.bankrupt) return roll;
        player.inJailTurns = 0;
        this.movePlayer(player, roll.total);
        this.log(`${player.name} rolou ${roll.values[0]} + ${roll.values[1]} = ${roll.total}`);
        const tile = this.state.tiles[player.position];
        this.resolveTile(player, tile);
        this.checkVictory();
        return roll;
      }

      player.inJailTurns -= 1;
      this.log(
        `${player.name} rolou ${roll.values[0]} + ${roll.values[1]} = ${roll.total}, não tirou duplo e segue preso (${player.inJailTurns} tentativas restantes).`
      );
      return roll;
    }

    this.movePlayer(player, roll.total);
    this.log(`${player.name} rolou ${roll.values[0]} + ${roll.values[1]} = ${roll.total}`);
    const tile = this.state.tiles[player.position];
    this.resolveTile(player, tile);
    this.checkVictory();
    return roll;
  }

  buyProperty(playerId: string, propertyId: string) {
    this.ensureActivePlayer(playerId);
    const player = this.getPlayer(playerId);
    if (!player) throw new Error("Jogador não encontrado");
    if (this.state.turn.awaitingPurchase !== propertyId) {
      throw new Error("Nenhuma compra pendente para esta propriedade.");
    }
    const tile = this.getProperty(propertyId);
    if (!tile) throw new Error("Propriedade inválida");
    if (tile.ownerId) throw new Error("Propriedade já possui dono");
    if (player.money < tile.price) throw new Error("Dinheiro insuficiente");

    player.money -= tile.price;
    tile.ownerId = player.id;
    tile.level = 1;
    this.state.turn.awaitingPurchase = undefined;
    this.log(`${player.name} comprou ${tile.name} por ${tile.price}`);
    this.checkVictory();
  }

  passPurchase(playerId: string) {
    this.ensureActivePlayer(playerId);
    if (!this.state.turn.awaitingPurchase) throw new Error("Nada a passar.");
    this.state.turn.awaitingPurchase = undefined;
    this.log("Compra recusada");
  }

  upgradeProperty(playerId: string, propertyId: string) {
    this.ensureActivePlayer(playerId);
    const player = this.getPlayer(playerId);
    if (!player) throw new Error("Jogador não encontrado");
    const tile = this.getProperty(propertyId);
    if (!tile) throw new Error("Propriedade inválida");
    if (tile.ownerId !== playerId) throw new Error("Você não é o dono desta propriedade.");
    if (this.state.turn.awaitingUpgrade !== propertyId) {
      throw new Error("Melhoria disponível apenas ao visitar esta propriedade neste turno.");
    }
    if (player.position !== tile.index) {
      throw new Error("Você precisa estar na propriedade para melhorá-la.");
    }
    const level = Math.max(1, tile.level ?? 1);
    if (level >= MAX_PROPERTY_LEVEL) throw new Error("Propriedade já está no nível máximo.");
    const cost = propertyUpgradeCost(tile);
    if (cost === null) throw new Error("Nenhuma melhoria disponível.");
    if (player.money < cost) throw new Error("Dinheiro insuficiente para melhorar a propriedade.");
    player.money -= cost;
    tile.level = level + 1;
    this.state.turn.awaitingUpgrade = undefined;
    this.log(`${player.name} melhorou ${tile.name} para o nível ${tile.level} por ${cost}.`);
    this.checkBankruptcy(player);
  }

  payBail(playerId: string) {
    this.ensureActivePlayer(playerId);
    const player = this.getPlayer(playerId);
    if (!player) throw new Error("Jogador inválido");
    if (player.inJailTurns <= 0) throw new Error("Você não está preso");
    if (this.state.turn.rolled) throw new Error("Fiança só pode ser paga no início do turno.");
    if (player.money < BAIL_COST) throw new Error("Dinheiro insuficiente para pagar fiança");
    player.money -= BAIL_COST;
    player.inJailTurns = 0;
    this.log(`${player.name} pagou fiança (${BAIL_COST}) e está livre.`);
    this.checkBankruptcy(player);
  }

  endTurn(playerId: string) {
    this.ensureActivePlayer(playerId);
    if (this.state.turn.awaitingPurchase) {
      throw new Error("Resolva a compra antes de finalizar o turno.");
    }
    const player = this.getPlayer(playerId);
    if (!player) throw new Error("Jogador inválido");
    if (!this.state.turn.rolled) {
      throw new Error(
        player.inJailTurns > 0
          ? "Tente sair da prisão (role os dados ou pague fiança) antes de finalizar o turno."
          : "Role os dados antes de finalizar o turno."
      );
    }
    this.advanceTurn();
  }

  finishByNetWorth() {
    if (this.state.status === "finished") return;
    const alive = this.state.players.filter((p) => !p.bankrupt);
    if (alive.length === 0) throw new Error("Sem jogadores ativos");
    const richest = [...alive].sort((a, b) => this.netWorth(b.id) - this.netWorth(a.id))[0];
    this.state.status = "finished";
    this.state.winnerId = richest.id;
    this.log(`${richest.name} venceu por maior patrimônio.`);
  }

  private resolveTile(player: PlayerState, tile: Tile, cameFromEvent = false) {
    switch (tile.type) {
      case "start":
        break;
      case "property":
        this.handleProperty(player, tile);
        break;
      case "tax":
        this.chargeBank(player, tile.amount, `${player.name} pagou imposto de ${tile.amount}`);
        break;
      case "event":
        this.handleEvent(player);
        break;
      case "jail":
        // Just visiting
        break;
      case "go-to-jail":
        this.sendToJail(player);
        break;
      case "free":
        if (!cameFromEvent) this.log(`${player.name} fez uma pausa em ${tile.name}`);
        break;
      default:
        break;
    }
  }

  private handleProperty(player: PlayerState, tile: PropertyTile) {
    this.state.turn.awaitingUpgrade = undefined;
    if (!tile.ownerId) {
      this.state.turn.awaitingPurchase = tile.id;
      this.log(`${player.name} caiu em ${tile.name}. Pode comprar por ${tile.price}.`);
      return;
    }
    if (tile.ownerId === player.id) {
      tile.level = Math.max(1, tile.level ?? 1);
      if (tile.level < MAX_PROPERTY_LEVEL) {
        this.state.turn.awaitingUpgrade = tile.id;
        const cost = propertyUpgradeCost(tile);
        this.log(
          `${player.name} visitou ${tile.name} (nível ${tile.level}). Pode melhorar para o próximo nível por ${cost}.`
        );
      } else {
        this.log(`${player.name} visitou sua própria propriedade (${tile.name}) no nível máximo (${tile.level}).`);
      }
      return;
    }
    const owner = this.getPlayer(tile.ownerId);
    if (!owner || owner.bankrupt) return;
    tile.level = Math.max(1, tile.level ?? 1);
    const rent = propertyRent(tile);
    player.money -= rent;
    owner.money += rent;
    this.log(`${player.name} pagou ${rent} de aluguel para ${owner.name} (${tile.name}).`);
    this.checkBankruptcy(player);
  }

  private handleEvent(player: PlayerState) {
    if (this.state.deck.length === 0) {
      this.state.deck = shuffle(EVENT_CARDS.map((c) => ({ ...c })));
    }
    const card = this.state.deck.shift() as EventCard;
    this.log(`${player.name} puxou carta: ${card.title}`);
    if (card.effect.money) {
      player.money += card.effect.money;
      if (card.effect.money > 0) {
        this.log(`${player.name} recebeu ${card.effect.money}`);
      } else {
        this.log(`${player.name} pagou ${Math.abs(card.effect.money)}`);
      }
      this.checkBankruptcy(player);
    }
    if (card.effect.goToJail) {
      this.sendToJail(player);
      return;
    }
    if (card.effect.move) {
      this.movePlayer(player, card.effect.move);
      this.resolveTile(player, this.state.tiles[player.position], true);
    }
    if (card.effect.toPosition !== undefined) {
      player.position = card.effect.toPosition;
      this.resolveTile(player, this.state.tiles[player.position], true);
    }
  }

  private sendToJail(player: PlayerState) {
    const jailIndex = this.state.tiles.findIndex((t) => t.type === "jail");
    player.position = jailIndex >= 0 ? jailIndex : player.position;
    player.inJailTurns = MAX_JAIL_TURNS;
    this.log(`${player.name} foi para a prisão.`);
  }

  private chargeBank(player: PlayerState, amount: number, reason: string) {
    player.money -= amount;
    this.log(reason);
    this.checkBankruptcy(player);
  }

  private movePlayer(player: PlayerState, steps: number) {
    const oldPos = player.position;
    const tilesCount = this.state.tiles.length;
    let newPos = (player.position + steps) % tilesCount;
    if (newPos < 0) newPos += tilesCount;
    const passedStart = (player.position + steps) >= tilesCount || newPos === 0 && steps > 0 && oldPos !== 0;
    player.position = newPos;
    if (passedStart) {
      player.money += this.state.settings.passStartBonus;
      this.log(`${player.name} passou pelo início e recebeu ${this.state.settings.passStartBonus}`);
    }
  }

  private advanceTurn() {
    const next = this.nextAlivePlayer(this.state.turn.currentPlayerId);
    this.state.turn = {
      currentPlayerId: next,
      rolled: false,
      turnStartedAt: Date.now(),
      awaitingPurchase: undefined,
      awaitingUpgrade: undefined,
      dice: undefined
    };
    this.state.turnNumber = (this.state.turnNumber ?? 1) + 1;
    this.checkVictory();
  }

  private nextAlivePlayer(currentId: string) {
    if (this.state.players.length === 0) throw new Error("Sem jogadores");
    const order = this.state.players;
    let idx = order.findIndex((p) => p.id === currentId);
    if (idx === -1) idx = 0;
    for (let i = 1; i <= order.length; i++) {
      const candidate = order[(idx + i) % order.length];
      if (!candidate.bankrupt) return candidate.id;
    }
    return currentId;
  }

  private getPlayer(id: string) {
    return this.state.players.find((p) => p.id === id);
  }

  private getProperty(id: string) {
    const tile = this.state.tiles.find((t) => t.id === id);
    if (tile && tile.type === "property") return tile as PropertyTile;
    return undefined;
  }

  private ensureActivePlayer(playerId: string) {
    if (this.state.status !== "active") {
      throw new Error("Partida não está ativa.");
    }
    if (this.state.turn.currentPlayerId !== playerId) {
      throw new Error("Ação inválida: não é seu turno.");
    }
  }

  private checkBankruptcy(player: PlayerState) {
    if (player.money >= 0 || player.bankrupt) return;
    player.bankrupt = true;
    player.inJailTurns = 0;
    this.state.tiles
      .filter((t) => t.type === "property" && t.ownerId === player.id)
      .forEach((t) => {
        (t as PropertyTile).ownerId = undefined;
      });
    this.log(`${player.name} faliu e devolveu suas propriedades ao banco.`);
    this.checkVictory();
  }

  private checkVictory() {
    if (this.state.status === "finished") return;
    const alive = this.state.players.filter((p) => !p.bankrupt);
    if (alive.length === 1) {
      this.state.status = "finished";
      this.state.winnerId = alive[0].id;
      this.log(`${alive[0].name} venceu a partida!`);
    }
  }

  private netWorth(playerId: string) {
    const player = this.getPlayer(playerId);
    if (!player) return 0;
    const propertyValue = this.state.tiles
      .filter((t) => t.type === "property" && (t as PropertyTile).ownerId === playerId)
      .reduce((sum, t) => sum + propertyAssetValue(t as PropertyTile), 0);
    return player.money + propertyValue;
  }

  private log(message: string) {
    const entry: LogEntry = {
      id: nanoid(8),
      message,
      timestamp: Date.now()
    };
    this.state.log.push(entry);
    if (this.state.log.length > 200) {
      this.state.log.shift();
    }
    return entry;
  }
}

function rollDie() {
  return Math.floor(Math.random() * 6) + 1;
}

function shuffle<T>(arr: T[]) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function sanitizeSettings(settings?: Partial<GameSettings>): GameSettings {
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  merged.startingCash = clamp(merged.startingCash, 500, 4000);
  merged.passStartBonus = clamp(merged.passStartBonus, 100, 500);
  merged.maxPlayers = clamp(merged.maxPlayers, 2, 12);
  return merged;
}

function cloneBoard(board: Tile[]): Tile[] {
  return board.map((tile) => {
    if (tile.type !== "property") return { ...tile };
    const property = tile as PropertyTile;
    return {
      ...property,
      price: Math.round(property.price * PROPERTY_PRICE_MULTIPLIER),
      baseRent: Math.round(property.baseRent * PROPERTY_RENT_MULTIPLIER),
      level: 0
    };
  });
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
