import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { GameEngine } from "../src/engine";
import { PropertyTile } from "@banco/shared";

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
    expect(host.money).toBe(hostMoneyBefore + (engine.state.tiles.find((t) => t.id === "p2") as PropertyTile).baseRent);
    expect(guest.money).toBeLessThan(engine.state.settings.startingCash);
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
    player.inJailTurns = 2;
    player.money = 50;
    expect(() => engine.payBail(hostId)).toThrow(/Dinheiro insuficiente/);
    expect(player.inJailTurns).toBe(2);
  });
});
