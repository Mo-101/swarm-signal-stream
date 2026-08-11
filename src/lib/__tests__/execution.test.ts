import { describe, expect, it } from "vitest";
import { PaperBroker, DEFAULT_PAPER_CONFIG, type MarketAccess } from "@/lib/paper-broker";
import type { BookSnapshot, InstrumentFilter } from "@/lib/microstructure";
import type { TradeProposal } from "@/lib/swarm";

function book(mid: number, spreadBps = 2, depth = 500_000): BookSnapshot {
  const half = (mid * spreadBps) / 20_000;
  const bid = mid - half;
  const ask = mid + half;
  const levels = (start: number, dir: 1 | -1) =>
    Array.from({ length: 20 }, (_, i) => [
      start + dir * i * (mid * 0.0001),
      depth / 20 / mid,
    ]) as [number, number][];
  return {
    symbol: "TESTUSDT",
    bids: levels(bid, -1),
    asks: levels(ask, 1),
    bid,
    ask,
    mid,
    spread: ask - bid,
    spreadBps,
    bidDepthUsd: depth,
    askDepthUsd: depth,
    updatedAt: Date.now(),
  };
}

const filter: InstrumentFilter = {
  symbol: "TESTUSDT",
  tickSize: 0.01,
  qtyStep: 0.001,
  minQty: 0.001,
  minNotional: 5,
  maxLeverage: 50,
};

function market(state: { book: BookSnapshot | null; mark: number }): MarketAccess {
  return {
    book: () => state.book,
    mark: () => state.mark,
    filter: () => filter,
  };
}

const proposal: TradeProposal = {
  id: "p1",
  symbol: "TESTUSDT",
  direction: "BUY",
  price: 100,
  confidence: 0.8,
  time: Date.now(),
  contributions: { Trend: { direction: "BUY", confidence: 0.8 } },
} as TradeProposal;

describe("execution realism", () => {
  it("fills through the book, paying the spread", () => {
    const state = { book: book(100), mark: 100 };
    const broker = new PaperBroker(DEFAULT_PAPER_CONFIG);
    broker.setMarket(market(state));
    broker.onProposal(proposal, { regime: "vol:normal" });
    expect(broker.getPending()).toHaveLength(1);

    broker.processPending(Date.now() + 5_000);
    const [pos] = broker.getPositions();
    expect(pos).toBeDefined();
    expect(pos.entryPrice).toBeGreaterThan(100); // crossed the ask
    expect(pos.entrySlipBps).toBeGreaterThan(0);
    expect(pos.bookPriced).toBe(true);
    expect(pos.size % filter.qtyStep).toBeLessThan(1e-9);
  });

  it("rejects when there is no live depth", () => {
    const state = { book: null as BookSnapshot | null, mark: 100 };
    const broker = new PaperBroker(DEFAULT_PAPER_CONFIG);
    broker.setMarket(market(state));
    broker.onProposal(proposal, { regime: "vol:normal" });
    broker.processPending(Date.now() + 5_000);
    expect(broker.getPositions()).toHaveLength(0);
    expect(broker.getExecutionStats().rejected).toBe(1);
  });

  it("rejects when the market ran away during flight", () => {
    const state = { book: book(100), mark: 100 };
    const broker = new PaperBroker(DEFAULT_PAPER_CONFIG);
    broker.setMarket(market(state));
    broker.onProposal(proposal, { regime: "vol:normal" });
    state.book = book(103); // +300 bps against a BUY
    broker.processPending(Date.now() + 5_000);
    expect(broker.getPositions()).toHaveLength(0);
    expect(broker.getExecutionStats().rejectsByReason["signal-stale"]).toBe(1);
  });

  it("rejects a spread wider than the cap", () => {
    const state = { book: book(100, 200), mark: 100 };
    const broker = new PaperBroker(DEFAULT_PAPER_CONFIG);
    broker.setMarket(market(state));
    broker.onProposal(proposal, { regime: "vol:normal" });
    broker.processPending(Date.now() + 5_000);
    expect(broker.getPositions()).toHaveLength(0);
    expect(broker.getExecutionStats().rejectsByReason["thin-book"]).toBe(1);
  });

  it("exits on take-profit with exit slippage recorded", () => {
    const state = { book: book(100), mark: 100 };
    const broker = new PaperBroker(DEFAULT_PAPER_CONFIG);
    broker.setMarket(market(state));
    broker.onProposal(proposal, { regime: "vol:normal" });
    broker.processPending(Date.now() + 5_000);
    const [pos] = broker.getPositions();

    const tp = pos.takeProfit * 1.001;
    state.book = book(tp);
    state.mark = tp;
    broker.markPrice("TESTUSDT", tp, Date.now());

    const [trade] = broker.getClosed();
    expect(trade).toBeDefined();
    expect(trade.reason).toBe("TP");
    expect(trade.exitSlipBps).toBeGreaterThan(0);
    expect(trade.slipCostUsd).toBeGreaterThan(0);
    expect(trade.pnl).toBeLessThan(trade.grossPnl); // costs bite
  });

  it("liquidates on mark price, not last price", () => {
    const state = { book: book(100), mark: 100 };
    const broker = new PaperBroker(DEFAULT_PAPER_CONFIG);
    broker.setMarket(market(state));
    broker.onProposal(proposal, { regime: "vol:normal" });
    broker.processPending(Date.now() + 5_000);
    const [pos] = broker.getPositions();

    // Last price wicks below liquidation but the mark stays healthy.
    state.mark = pos.entryPrice;
    broker.markPrice("TESTUSDT", pos.liquidationPrice * 0.99, Date.now());
    expect(broker.getClosed().some((t) => t.reason === "LIQ")).toBe(false);

    // Now the mark itself crosses.
    const liq = pos.liquidationPrice * 0.995;
    state.mark = liq;
    state.book = book(liq);
    broker.markPrice("TESTUSDT", liq, Date.now());
    const liqTrade = broker.getClosed().find((t) => t.reason === "LIQ");
    expect(liqTrade).toBeDefined();
    expect(liqTrade!.pnl).toBeLessThan(0);
    expect(Math.abs(liqTrade!.pnl)).toBeLessThanOrEqual(liqTrade!.initialMargin + 1e-6);
  });
});
