import { describe, it, expect } from "vitest";
import {
  PaperBroker,
  DEFAULT_PAPER_CONFIG,
  type MarketAccess,
  type PaperConfig,
} from "@/lib/paper-broker";
import type { InstrumentFilter } from "@/lib/microstructure";

const FILTER: InstrumentFilter = {
  symbol: "TESTUSDT",
  tickSize: 0.01,
  qtyStep: 0.001,
  minOrderQty: 0.001,
  maxOrderQty: 1_000_000,
  minNotional: 1,
  maxLeverage: 25,
};

const MARKET: MarketAccess = {
  book: () => null,
  mark: () => null,
  filter: () => FILTER,
};

function brokerWith(cfg: Partial<PaperConfig> = {}) {
  const b = new PaperBroker({ ...DEFAULT_PAPER_CONFIG, ...cfg });
  b.setMarket(MARKET);
  return b;
}

/** Open a long at 100 with a 2% stop (1R = 2.00) and a 4% target. */
function seedLong(b: PaperBroker, over: Record<string, unknown> = {}) {
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

describe("breakeven + trailing stop", () => {
  it("leaves the stop alone below the breakeven trigger", () => {
    const b = brokerWith();
    seedLong(b);
    b.markPrice("TESTUSDT", 101, 2_000); // +0.5R
    expect(b.getPositions()[0].stopLoss).toBe(98);
    expect(b.getPositions()[0].stopMoved).toBe(false);
  });

  it("holds the stop at +1R — the ratchet waits for 1.5R", () => {
    const b = brokerWith();
    seedLong(b);
    b.markPrice("TESTUSDT", 102, 2_000); // +1R
    expect(b.getPositions()[0].stopLoss).toBe(98);
    expect(b.getPositions()[0].stopMoved).toBe(false);
  });

  it("pulls the stop above entry (fee cushion) at +1.5R", () => {
    const b = brokerWith();
    seedLong(b);
    b.markPrice("TESTUSDT", 103, 2_000); // +1.5R
    const p = b.getPositions()[0];
    expect(p.stopMoved).toBe(true);
    // entry + 2 × taker fee, rounded to the 0.01 tick.
    expect(p.stopLoss).toBeGreaterThan(100);
    expect(p.stopLoss).toBeLessThan(100.5);
  });

  it("trails 1R behind the best price past +2.5R and never retreats", () => {
    const b = brokerWith();
    seedLong(b);
    b.markPrice("TESTUSDT", 105.4, 2_000); // +2.7R → trail to 105.4 - 2
    expect(b.getPositions()[0].stopLoss).toBeCloseTo(103.4, 6);
    b.markPrice("TESTUSDT", 104, 3_000); // pullback must not lower the stop
    expect(b.getPositions()[0].stopLoss).toBeCloseTo(103.4, 6);
  });

  it("books a trailed exit as TRAIL, not SL", () => {
    const b = brokerWith();
    seedLong(b);
    b.markPrice("TESTUSDT", 105.4, 2_000);
    b.markPrice("TESTUSDT", 103, 3_000); // through the trailed stop
    const closed = b.getClosed();
    expect(closed).toHaveLength(1);
    expect(closed[0].reason).toBe("TRAIL");
    expect(closed[0].pnl).toBeGreaterThan(0);
  });
});

describe("maker take-profit", () => {
  it("fills at the target with zero slippage and the maker fee", () => {
    const b = brokerWith({ takeProfitAsLimit: true });
    seedLong(b);
    b.markPrice("TESTUSDT", 104.2, 2_000);
    const t = b.getClosed()[0];
    expect(t.reason).toBe("TP");
    expect(t.exitPrice).toBe(104);
    expect(t.exitSlipBps).toBe(0);
    // entry taker fee + exit maker fee
    const expected = 100 * DEFAULT_PAPER_CONFIG.takerFeeRate + 104 * DEFAULT_PAPER_CONFIG.makerFeeRate;
    expect(t.fees).toBeCloseTo(expected, 10);
  });

  it("costs strictly more when the target is taken instead of posted", () => {
    const maker = brokerWith({ takeProfitAsLimit: true });
    seedLong(maker);
    maker.markPrice("TESTUSDT", 104.2, 2_000);

    const taker = brokerWith({ takeProfitAsLimit: false });
    seedLong(taker);
    taker.markPrice("TESTUSDT", 104.2, 2_000);

    expect(taker.getClosed()[0].fees).toBeGreaterThan(maker.getClosed()[0].fees);
    expect(maker.getClosed()[0].pnl).toBeGreaterThan(taker.getClosed()[0].pnl);
  });
});

describe("time and carry exits", () => {
  it("closes a stale position with reason TIME", () => {
    const b = brokerWith({ maxHoldMs: 60_000 });
    seedLong(b, { openedAt: 0 });
    b.manageOpen(120_000, new Map([["TESTUSDT", 101]]));
    expect(b.getClosed()[0].reason).toBe("TIME");
  });

  it("closes when funding has eaten the configured share of the reward", () => {
    const b = brokerWith({ maxFundingShareOfReward: 0.35 });
    // reward = |104 - 100| × 1 = $4 → threshold $1.40
    seedLong(b, { fundingPaid: 1.5 });
    b.manageOpen(2_000, new Map([["TESTUSDT", 101]]));
    expect(b.getClosed()[0].reason).toBe("CARRY");
  });

  it("holds a position that is inside both limits", () => {
    const b = brokerWith();
    seedLong(b, { openedAt: 1_000, fundingPaid: 0.1 });
    b.manageOpen(2_000, new Map([["TESTUSDT", 101]]));
    expect(b.getPositions()).toHaveLength(1);
  });
});
