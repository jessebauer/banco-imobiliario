import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { GameEngine } from "../src/engine";
import { PropertyTile, propertyRent } from "@banco/shared";

describe("GameEngine rules", () => {
  let engine: GameEngine;
  let hostId: string;
  let guestId: string;

  beforeEach(() => {
    engine = new GameEngine("room", "Host");
    hostId = engine.state.hostId;
    guestId = engine.addPlayer("Ana").id;
    engine.startGame();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rolls dice, lands on property and allows purchase", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // always 1
    engine.rollDice(hostId); // from start to index 2 (property)
    expect(engine.state.turn.awaitingPurchase).toBe("p2");
    engine.buyProperty(hostId, "p2");
    const tile = engine.state.tiles.find((t) => t.id === "p2") as PropertyTile;
    expect(tile.ownerId).toBe(hostId);
    expect(tile.level).toBe(1);
  });

  it("charges rent to visitors", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    engine.rollDice(hostId);
    engine.buyProperty(hostId, "p2");
    engine.endTurn(hostId);

    const hostMoneyBefore = engine.state.players.find((p) => p.id === hostId)?.money || 0;
    engine.rollDice(guestId); // lands on same property
    const guest = engine.state.players.find((p) => p.id === guestId)!;
    const host = engine.state.players.find((p) => p.id === hostId)!;
    const rent = propertyRent(engine.state.tiles.find((t) => t.id === "p2") as PropertyTile);
    expect(host.money).toBe(hostMoneyBefore + rent);
    expect(guest.money).toBeLessThan(engine.state.settings.startingCash);
  });

  it("offers upgrade when owner lands on property and increases rent", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    engine.rollDice(hostId);
    engine.buyProperty(hostId, "p2");
    const tile = engine.state.tiles.find((t) => t.id === "p2") as PropertyTile;
    const host = engine.state.players.find((p) => p.id === hostId)!;
    const rentBefore = propertyRent(tile);
    engine.state.turn.awaitingUpgrade = tile.id;
    engine.state.turn.rolled = true;
    host.position = tile.index;
    const cost = tile.price * (tile.level ?? 1);
    engine.upgradeProperty(hostId, tile.id);
    expect(tile.level).toBe(2);
    expect(propertyRent(tile)).toBeGreaterThan(rentBefore);
    expect(host.money).toBe(engine.state.settings.startingCash - tile.price - cost);
  });

  it("doubles base price and rent from the reference board", () => {
    const tile = engine.state.tiles.find((t) => t.id === "p1") as PropertyTile;
    expect(tile.price).toBe(200);
    expect(tile.baseRent).toBe(50);
  });

  it("applies taxes and bankruptcy", () => {
    const player = engine.state.players.find((p) => p.id === hostId)!;
    player.money = 50;
    // move host directly to tax tile index 3
    player.position = 3;
    engine.state.turn.currentPlayerId = hostId;
    engine.state.turn.rolled = true;
    // trigger tax manually
    (engine as any).chargeBank(player, 150, "Teste de imposto");
    expect(player.bankrupt).toBe(true);
  });

  it("blocks paying bail when player lacks cash", () => {
    const player = engine.state.players.find((p) => p.id === hostId)!;
    player.inJailTurns = 3;
    player.money = 40;
    expect(() => engine.payBail(hostId)).toThrow(/Dinheiro insuficiente/);
    expect(player.inJailTurns).toBe(3);
  });

  it("lets player leave jail by rolling doubles", () => {
    const player = engine.state.players.find((p) => p.id === hostId)!;
    const jailIndex = engine.state.tiles.findIndex((t) => t.type === "jail");
    player.position = jailIndex;
    player.inJailTurns = 3;

    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0) // die 1 -> 1
      .mockReturnValueOnce(0); // die 2 -> 1

    engine.rollDice(hostId);
    expect(player.inJailTurns).toBe(0);
    expect(player.position).toBe((jailIndex + 2) % engine.state.tiles.length);
  });

  it("sends player to jail when drawing a go-to-jail card", () => {
    const player = engine.state.players.find((p) => p.id === hostId)!;
    const jailIndex = engine.state.tiles.findIndex((t) => t.type === "jail");
    player.position = 0;
    engine.state.deck = [
      { id: "carta-prisao", title: "Carta prisão", description: "Vá para a prisão", effect: { goToJail: true } }
    ];

    vi.spyOn(Math, "random").mockReturnValue(0.2); // 2 + 2 = 4 (event tile)
    engine.rollDice(hostId);

    expect(player.position).toBe(jailIndex);
    expect(player.inJailTurns).toBe(3);
    expect(player.money).toBe(engine.state.settings.startingCash);
  });

  it("forces bail after three failed jail turns", () => {
    const player = engine.state.players.find((p) => p.id === hostId)!;
    const jailIndex = engine.state.tiles.findIndex((t) => t.type === "jail");
    player.position = jailIndex;
    player.inJailTurns = 3;
    const startMoney = player.money;

    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0) // 1
      .mockReturnValueOnce(0.2) // 2 -> total 3, stay
      .mockReturnValueOnce(0.2) // 2
      .mockReturnValueOnce(0.4) // 3 -> total 5, stay
      .mockReturnValueOnce(0.35) // 3
      .mockReturnValueOnce(0.55); // 4 -> total 7, pay bail and move

    engine.rollDice(hostId);
    expect(player.inJailTurns).toBe(2);
    expect(player.position).toBe(jailIndex);
    engine.state.turn.rolled = false;
    engine.state.turn.dice = undefined;

    engine.rollDice(hostId);
    expect(player.inJailTurns).toBe(1);
    expect(player.position).toBe(jailIndex);
    engine.state.turn.rolled = false;
    engine.state.turn.dice = undefined;

    engine.rollDice(hostId);
    expect(player.inJailTurns).toBe(0);
    expect(player.money).toBe(startMoney - 50);
    expect(player.position).toBe((jailIndex + 7) % engine.state.tiles.length);
  });
});
