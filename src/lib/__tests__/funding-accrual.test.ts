import { describe, expect, it } from "vitest";
import {
  PaperBroker,
  DEFAULT_PAPER_CONFIG,
  type MarketAccess,
  type PaperConfig,
} from "@/lib/paper-broker";
import { netPnlResidual, reconciles } from "@/lib/math/perp";
import type { InstrumentFilter } from "@/lib/microstructure";

const H = 3_600_000;
const T = (h: number) => Date.UTC(2026, 0, 1, h);

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

/** One open position, opened at 00:00 UTC, 1 unit at 100. */
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
        openedAt: T(0),
        confidence: 0.8,
        regime: "vol:normal",
        agents: {},
        lastFundingAt: T(0),
        ...over,
      },
    ],
    closed: [],
    realizedPnl: 0,
    halted: false,
  });
}

const marks = new Map([["TESTUSDT", 100]]);

describe("funding accrual is driven by the exchange clock", () => {
  it("charges |q| x mark x rate, signed so a long PAYS a positive rate", () => {
    const b = brokerWith();
    seed(b);
    b.applyFundingTicker({
      symbol: "TESTUSDT",
      fundingRate: "0.0001",
      nextFundingTime: T(8),
    });
    b.accrueFunding(T(8), marks);

    const stats = b.getFundingStats(marks);
    expect(stats.accruals).toBe(1);
    // 1 x 100 x 0.0001 = 0.01, paid by the long.
    expect(stats.recent[0].amount).toBeCloseTo(0.01, 10);
    expect(stats.totalFunding).toBeCloseTo(0.01, 10);
    expect(b.getRealizedPnl()).toBeCloseTo(-0.01, 10);
  });

  it("pays a short when the rate is positive", () => {
    const b = brokerWith();
    seed(b, { side: "SELL", id: "s1" });
    b.applyFundingTicker({ symbol: "TESTUSDT", fundingRate: 0.0001, nextFundingTime: T(8) });
    b.accrueFunding(T(8), marks);
    expect(b.getFundingStats(marks).recent[0].amount).toBeCloseTo(-0.01, 10);
    expect(b.getRealizedPnl()).toBeCloseTo(0.01, 10);
  });

  it("settles a 1h contract eight times where the old 8h grid settled once", () => {
    const b = brokerWith();
    seed(b);
    b.setFundingIntervalMinutes("TESTUSDT", 60);
    b.applyFundingTicker({ symbol: "TESTUSDT", fundingRate: 0.0001, nextFundingTime: T(8) });
    b.accrueFunding(T(8), marks);

    const stats = b.getFundingStats(marks);
    expect(stats.accruals).toBe(8);
    expect(stats.totalFunding).toBeCloseTo(0.08, 10);
    // Each is its own settlement, not one lumped multi-interval charge.
    expect(new Set(stats.recent.map((e) => e.at)).size).toBe(8);
  });

  it("never charges the same settlement twice, however often it is asked", () => {
    const b = brokerWith();
    seed(b);
    b.applyFundingTicker({ symbol: "TESTUSDT", fundingRate: 0.0001, nextFundingTime: T(8) });

    b.accrueFunding(T(8), marks);
    b.accrueFunding(T(8), marks);
    b.accrueFunding(T(8) + 1, marks);
    b.accrueFunding(T(8) + 60_000, marks);

    expect(b.getFundingStats(marks).accruals).toBe(1);
    expect(b.getRealizedPnl()).toBeCloseTo(-0.01, 10);
  });

  it("skips settlements a previous process already charged", () => {
    const b = brokerWith();
    seed(b);
    b.applyFundingTicker({ symbol: "TESTUSDT", fundingRate: 0.0001, nextFundingTime: T(8) });
    // The durable record says 08:00 already hit the ledger before the restart.
    b.restoreFundingEvents([{ symbol: "TESTUSDT", side: "BUY", at: T(8) }]);

    b.accrueFunding(T(8), marks);
    expect(b.getFundingStats(marks).accruals).toBe(0);
    expect(b.getRealizedPnl()).toBe(0);
  });

  it("charges on the quantity held at settlement, not the opening size", () => {
    const b = brokerWith();
    seed(b, { size: 2, notional: 200 });
    b.applyFundingTicker({ symbol: "TESTUSDT", fundingRate: 0.0001, nextFundingTime: T(8) });
    b.accrueFunding(T(8), marks);
    const e = b.getFundingStats(marks).recent[0];
    expect(e.quantity).toBe(2);
    expect(e.notional).toBeCloseTo(200, 10);
    expect(e.amount).toBeCloseTo(0.02, 10);
  });

  it("uses the mark price at settlement, not the entry price", () => {
    const b = brokerWith();
    seed(b);
    b.applyFundingTicker({ symbol: "TESTUSDT", fundingRate: 0.0001, nextFundingTime: T(8) });
    // Mark has moved to 150 by the settlement instant.
    b.accrueFunding(T(8), new Map([["TESTUSDT", 150]]));
    const e = b.getFundingStats(marks).recent[0];
    expect(e.markPrice).toBe(150);
    expect(e.amount).toBeCloseTo(0.015, 10);
  });

  it("does not charge a position for a settlement that predates it", () => {
    const b = brokerWith();
    seed(b, { openedAt: T(9), lastFundingAt: T(9) });
    b.applyFundingTicker({ symbol: "TESTUSDT", fundingRate: 0.0001, nextFundingTime: T(16) });
    // 08:00 is before this position existed.
    expect(b.replaySettledFunding("TESTUSDT", T(8), 0.0001)).toBeNull();
    expect(b.getFundingStats(marks).accruals).toBe(0);
  });
});

describe("provisional charges are reconciled against the settled rate", () => {
  it("marks a live-rate charge provisional and books the correction once", () => {
    const b = brokerWith();
    seed(b);
    b.applyFundingTicker({ symbol: "TESTUSDT", fundingRate: 0.0001, nextFundingTime: T(8) });
    b.accrueFunding(T(8), marks);

    expect(b.getFundingStats(marks).provisional).toBe(1);
    expect(b.getProvisionalFundings()).toHaveLength(1);

    // Bybit publishes the real settled rate: 0.00015, not the predicted 0.0001.
    const delta = b.reconcileSettledFunding("TESTUSDT", "BUY", T(8), 0.00015);
    expect(delta).toBeCloseTo(0.005, 10);

    const stats = b.getFundingStats(marks);
    expect(stats.provisional).toBe(0);
    expect(stats.totalFunding).toBeCloseTo(0.015, 10);
    expect(stats.recent[0].rateSource).toBe("settled");
    expect(b.getRealizedPnl()).toBeCloseTo(-0.015, 10);

    // Confirming again changes nothing.
    expect(b.reconcileSettledFunding("TESTUSDT", "BUY", T(8), 0.00015)).toBeNull();
    expect(b.getFundingStats(marks).totalFunding).toBeCloseTo(0.015, 10);
  });

  it("replays a missed settlement at its settled rate, not today's", () => {
    const b = brokerWith();
    seed(b);
    // The process was down over 08:00; the ticker now predicts a different rate.
    b.applyFundingTicker({ symbol: "TESTUSDT", fundingRate: 0.001, nextFundingTime: T(16) });
    const fee = b.replaySettledFunding("TESTUSDT", T(8), 0.0001, 100);

    expect(fee).toBeCloseTo(0.01, 10);
    const e = b.getFundingStats(marks).recent[0];
    expect(e.rateSource).toBe("settled");
    expect(e.rate).toBe(0.0001);
    // Nothing provisional: it was charged at the confirmed rate outright.
    expect(b.getFundingStats(marks).provisional).toBe(0);
  });
});

describe("net PnL identity", () => {
  it("holds for a closed trade: net = gross - fees - funding", () => {
    const b = brokerWith();
    seed(b);
    b.applyFundingTicker({ symbol: "TESTUSDT", fundingRate: 0.0001, nextFundingTime: T(8) });
    b.accrueFunding(T(8), marks);
    b.closeAll(new Map([["TESTUSDT", 104]]), T(9));

    const t = b.getClosed()[0];
    expect(reconciles({ ...t, netPnl: t.pnl })).toBe(true);
    expect(netPnlResidual({ ...t, netPnl: t.pnl })).toBeCloseTo(0, 8);
  });

  it("still holds after a funding correction lands on an already-closed trade", () => {
    const b = brokerWith();
    seed(b);
    b.applyFundingTicker({ symbol: "TESTUSDT", fundingRate: 0.0001, nextFundingTime: T(8) });
    b.accrueFunding(T(8), marks);
    b.closeAll(new Map([["TESTUSDT", 104]]), T(9));

    const before = b.getClosed()[0].pnl;
    b.reconcileSettledFunding("TESTUSDT", "BUY", T(8), 0.00015);

    const t = b.getClosed()[0];
    expect(t.pnl).toBeCloseTo(before - 0.005, 10);
    expect(t.funding).toBeCloseTo(0.015, 10);
    expect(reconciles({ ...t, netPnl: t.pnl })).toBe(true);
  });

  it("does not treat slippage as a deduction from gross", () => {
    const b = brokerWith();
    seed(b, { signalPrice: 99 });
    b.closeAll(new Map([["TESTUSDT", 104]]), T(9));
    const t = b.getClosed()[0];
    // The trade carries a slippage attribution, but it is already inside gross:
    // subtracting it as well would break the identity.
    expect(t.slipCostUsd).toBeGreaterThan(0);
    expect(reconciles({ ...t, netPnl: t.pnl })).toBe(true);
    expect(
      reconciles({
        grossPnl: t.grossPnl,
        fees: t.fees + t.slipCostUsd,
        funding: t.funding,
        netPnl: t.pnl,
      }),
    ).toBe(false);
  });
});
