import { describe, expect, it } from "vitest";
import { createEngineRuntime } from "@/lib/engine-runtime";
import { deriveEdge, EMPTY_EDGE_REPORT } from "@/lib/edge-model";
import type { OpenTradeInput, CloseTradeInput } from "@/lib/db/types";

/**
 * The defect these guard against is NOT "the broker computes the flag wrong".
 * It is that `makerEntry` / `makerExit` existed in broker memory and never
 * reached the database — a break in the ClosedTrade → CloseTradeInput mapping,
 * which is inline in createEngineRuntime's onOpen/onClose hooks.
 *
 * Testing the broker's own fields cannot catch that: the source of truth stays
 * correct while the trip to persistence silently drops it. These tests capture
 * the payload the persistence layer actually receives.
 */
function harness() {
  const opens: OpenTradeInput[] = [];
  const closes: CloseTradeInput[] = [];
  const runtime = createEngineRuntime({
    symbols: ["TESTUSDT"],
    boot: {
      account: { startingBalance: 10_000, realizedPnl: 0, halted: false },
      open: [],
      closed: [],
    },
    getLearned: () => deriveEdge(EMPTY_EDGE_REPORT),
    persistence: {
      saveOpenTrade: async (d) => {
        opens.push(d);
        return null;
      },
      saveCloseTrade: async (d) => {
        closes.push(d);
        return { report: EMPTY_EDGE_REPORT };
      },
      sendSignals: async () => {},
    },
  });
  return { runtime, opens, closes };
}

function seedPosition(runtime: ReturnType<typeof createEngineRuntime>, makerEntry: boolean) {
  runtime.getBroker().hydrate({
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
        makerEntry,
      },
    ],
    closed: [],
    realizedPnl: 0,
    halted: false,
  });
}

describe("liquidity flags survive the trip to persistence", () => {
  it("passes makerExit into the close payload on a maker take-profit", async () => {
    const { runtime, closes } = harness();
    // v1r takes its targets; force the posted-target path this test is about.
    runtime.getBroker().configure({ takeProfitAsLimit: true });
    seedPosition(runtime, true);
    runtime.getBroker().markPrice("TESTUSDT", 105, 2_000);
    await Promise.resolve();

    expect(closes).toHaveLength(1);
    expect(closes[0].reason).toBe("TP");
    // The field must be PRESENT, not merely falsy-by-omission: a dropped
    // mapping and a genuine taker exit are indistinguishable downstream if
    // undefined is allowed through.
    expect(closes[0]).toHaveProperty("makerExit");
    expect(closes[0].makerExit).toBe(true);
  });

  it("passes makerExit=false into the close payload on a stop-out", async () => {
    const { runtime, closes } = harness();
    seedPosition(runtime, false);
    runtime.getBroker().markPrice("TESTUSDT", 97, 2_000);
    await Promise.resolve();

    expect(closes).toHaveLength(1);
    expect(closes[0].reason).toBe("SL");
    expect(closes[0]).toHaveProperty("makerExit");
    expect(closes[0].makerExit).toBe(false);
  });

  it("keeps the rest of the cost breakdown in the close payload", async () => {
    const { runtime, closes } = harness();
    seedPosition(runtime, true);
    runtime.getBroker().markPrice("TESTUSDT", 105, 2_000);
    await Promise.resolve();

    // These travel the same mapping and are what the net identity is rebuilt
    // from on the read side, so a silent drop here reopens the residual bug.
    for (const key of ["grossPnl", "fees", "funding", "slipCostUsd", "triggerPrice"]) {
      expect(closes[0]).toHaveProperty(key);
    }
  });
});
