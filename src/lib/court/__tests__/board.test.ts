import { describe, expect, it } from "vitest";
import type { Verdict } from "../court";
import { buildBoard, groupsFor, leaderboard, type LiveSignal, type StoredVerdict } from "../board";

const v = (
  id: string,
  verdict: string,
  failed: string[] = [],
  extra: Partial<Verdict> = {},
): StoredVerdict =>
  ({
    id,
    claim: id,
    verdict,
    diagnosis: "",
    failed,
    n: 300,
    nEpisodes: 60,
    nDiscovery: 180,
    nHoldout: 120,
    grossBps: 30,
    costBps: 15,
    netBps: 15,
    netCi95: [4, 26],
    mdeBps: 9,
    pPlaceboDiscovery: 0.001,
    pPlaceboHoldout: 0.01,
    netBpsHoldout: 12,
    t: 4,
    t0: 2,
    dsr: 0.97,
    positiveFolds: 5,
    trimmedBps: 10,
    profitFactor: 1.4,
    winRate: 0.44,
    judgedAt: "2026-09-28T10:00:00.000Z",
    ...extra,
  }) as StoredVerdict;

const swarm = (over: Partial<LiveSignal> = {}): LiveSignal => ({
  source: "swarm",
  id: "a",
  symbol: "SOLUSDT",
  side: "BUY",
  confidence: 0.83,
  price: 200,
  stopLoss: null,
  takeProfit: null,
  at: Date.UTC(2026, 8, 28, 11),
  agrees: ["Trend", "Breakout"],
  ...over,
});

describe("signal board", () => {
  it("maps a swarm signal onto every hypothesis it belongs to", () => {
    expect(groupsFor(swarm())).toEqual([
      "signals:all",
      "signals:not-executed",
      "signals:conf:>=0.80",
      "signals:agent:Trend",
      "signals:agent:Breakout",
    ]);
    expect(groupsFor({ ...swarm(), source: "sigmalui", admitted: true })).toEqual([
      "sigmalui:all",
      "sigmalui:admitted",
    ]);
  });

  it("keeps a signal UNPROVEN when none of its groups is convicted", () => {
    const [row] = buildBoard([swarm()], {
      "signals:all": v("signals:all", "NOT PROVEN", ["a:", "b:", "c:"]),
      "signals:agent:Trend": v("signals:agent:Trend", "NOT PROVEN", ["a:"], { dsr: 0.8 }),
    });
    expect(row.standing).toBe("UNPROVEN");
    expect(row.forecast).toBeNull();
    expect(row.closest).toEqual({ hypothesis: "signals:agent:Trend", passed: 7, dsr: 0.8 });
  });

  it("SURFACES a signal with a forecast when one of its groups is convicted", () => {
    const [row] = buildBoard([swarm()], {
      "signals:all": v("signals:all", "NOT PROVEN", ["a:"]),
      "signals:agent:Breakout": v("signals:agent:Breakout", "CONVICTED"),
    });
    expect(row.standing).toBe("SURFACED");
    expect(row.forecast).toMatchObject({
      hypothesis: "signals:agent:Breakout",
      direction: "LONG",
      entryRef: 200,
      expectedNetBps: 15,
      evidenceTrades: 300,
    });
    expect(row.forecast!.stop).toBeCloseTo(196);
    expect(row.forecast!.target).toBeCloseTo(208);
  });

  it("uses the quoted brackets for SigmaLui and ignores retired groups on the leaderboard", () => {
    const s: LiveSignal = {
      ...swarm(),
      source: "sigmalui",
      side: "SELL",
      stopLoss: 205,
      takeProfit: 190,
      admitted: true,
    };
    const [row] = buildBoard([s], { "sigmalui:admitted": v("sigmalui:admitted", "CONVICTED") });
    expect(row.forecast).toMatchObject({ direction: "SHORT", stop: 205, target: 190 });
    const lb = leaderboard({
      a: v("a", "NOT PROVEN", ["x:", "y:"]),
      b: v("b", "CONVICTED"),
      c: v("c", "RETIRED"),
      d: v("d", "NOT PROVEN", ["x:"]),
    });
    expect(lb.map((x) => x.id)).toEqual(["b", "d", "a"]);
  });
});
