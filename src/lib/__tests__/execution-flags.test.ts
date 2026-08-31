import { describe, expect, it } from "vitest";
import {
  PaperBroker,
  DEFAULT_PAPER_CONFIG,
  type MarketAccess,
  type PaperConfig,
} from "@/lib/paper-broker";
import type { InstrumentFilter } from "@/lib/microstructure";

/**
 * Liquidity flags must survive the trip from the fill onto the ClosedTrade,
 * because that is what the persistence layer writes to maker_entry /
 * maker_exit — and those columns are what let a strategy's fee floor be
 * MEASURED instead of inferred from a blended rate.
 *
 * v3 was retired on a 3.47 bps deficit between its signal edge and its fee
 * floor, where the floor had to be reconstructed from fees/notional because
 * these flags were never persisted. A silent break here would put the
 * successor epoch back in exactly that position.
 */
const FILTER: InstrumentFilter = {
  symbol: "TESTUSDT",
  tickSize: 0.01,
  qtyStep: 0.001,
  minOrderQty: 0.001,
  maxOrderQty: 1_000_000,
  minNotional: 1,
  maxLeverage: 25,
};
const MARKET: MarketAccess = { book: () => null, mark: () => null, filter: () => FILTER };

function brokerWith(cfg: Partial<PaperConfig> = {}) {
  const b = new PaperBroker({ ...DEFAULT_PAPER_CONFIG, ...cfg });
  b.setMarket(MARKET);
  return b;
}

function seed(b: PaperBroker, over: Record<string, unknown> = {}) {
  b.hydrate({
    positions: [
      {
        id: "t1",
        symbol: "TESTUSDT",
        side: "BUY",
        entryPrice: 100,
        size: 1,
        notional: 100,
        stopLoss: 98,
        takeProfit: 104,
        openedAt: 1_000,
        confidence: 0.8,
        regime: "vol:normal",
        agents: {},
        ...over,
      },
    ],
    closed: [],
    realizedPnl: 0,
    halted: false,
  });
}

describe("liquidity flags reach the closed trade", () => {
  it("carries a maker entry through to the trade record", () => {
    const b = brokerWith();
    seed(b, { makerEntry: true });
    b.closeAll(new Map([["TESTUSDT", 104]]), 2_000);
    expect(b.getClosed()[0].makerEntry).toBe(true);
  });

  it("marks a taker entry as such rather than leaving it undefined", () => {
    const b = brokerWith();
    seed(b, { makerEntry: false });
    b.closeAll(new Map([["TESTUSDT", 104]]), 2_000);
    const t = b.getClosed()[0];
    expect(t.makerEntry).toBe(false);
    expect(t.makerEntry).not.toBeUndefined();
  });

  it("flags a take-profit exit as maker when TPs rest as limits", () => {
    const b = brokerWith({ takeProfitAsLimit: true });
    seed(b);
    // Price through the target triggers the TP path.
    b.markPrice("TESTUSDT", 105, 2_000);
    const t = b.getClosed()[0];
    expect(t?.reason).toBe("TP");
    expect(t?.makerExit).toBe(true);
  });

  it("never flags a stop-out as maker — stops must cross", () => {
    const b = brokerWith({ takeProfitAsLimit: true });
    seed(b);
    b.markPrice("TESTUSDT", 97, 2_000);
    const t = b.getClosed()[0];
    expect(t?.reason).toBe("SL");
    expect(t?.makerExit).toBe(false);
  });

  it("does not flag a TP as maker when TPs are configured to cross", () => {
    const b = brokerWith({ takeProfitAsLimit: false });
    seed(b);
    b.markPrice("TESTUSDT", 105, 2_000);
    const t = b.getClosed()[0];
    expect(t?.reason).toBe("TP");
    expect(t?.makerExit).toBe(false);
  });
});
