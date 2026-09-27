import { describe, expect, it } from "vitest";
import {
  buildDocket,
  clusteredBootstrap,
  type CourtTrade,
  deflatedT,
  judgeAll,
  mulberry32,
  normCdf,
  normInv,
} from "../court";
import { DecayWatch } from "../decay";

const H = 3600_000;

/** Synthetic trades: `edgeBps` net edge per trade, market moves shared per episode. */
function makeTrades(opts: {
  n: number;
  edgeBps: number;
  costBps?: number;
  noiseBps?: number;
  perEpisode?: number;
  epoch?: string;
  sources?: string[];
  seed?: number;
  startMs?: number;
}): CourtTrade[] {
  const rng = mulberry32(opts.seed ?? 1);
  const gauss = () => Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng());
  const cost = opts.costBps ?? 8;
  const noise = opts.noiseBps ?? 60;
  const per = opts.perEpisode ?? 1;
  const out: CourtTrade[] = [];
  let market = 0;
  for (let i = 0; i < opts.n; i++) {
    if (i % per === 0) market = gauss() * noise; // shared move for this episode
    const side = rng() < 0.5 ? 1 : -1;
    const grossBps =
      opts.edgeBps +
      cost +
      side * market * 0 +
      gauss() * noise * (per > 1 ? 0.3 : 1) +
      (per > 1 ? market : 0);
    const notional = 1000;
    const t0 = (opts.startMs ?? 0) + Math.floor(i / per) * 7 * H + (i % per) * 60_000;
    out.push({
      id: `${opts.epoch ?? "x"}-${i}`,
      symbol: "BTCUSDT",
      side: side > 0 ? "BUY" : "SELL",
      epoch: opts.epoch ?? "x",
      sources: opts.sources ?? ["Trend"],
      openedAt: t0,
      closedAt: t0 + H,
      notional,
      grossUsd: (grossBps / 1e4) * notional,
      netUsd: ((grossBps - cost) / 1e4) * notional,
    });
  }
  return out;
}

describe("normal helpers", () => {
  it("normCdf and normInv are inverses", () => {
    for (const p of [0.01, 0.1, 0.5, 0.9, 0.99]) expect(normCdf(normInv(p))).toBeCloseTo(p, 4);
    expect(normInv(0.975)).toBeCloseTo(1.96, 2);
  });
});

describe("judgeAll", () => {
  it("convicts a large, steady edge", () => {
    const trades = makeTrades({ n: 300, edgeBps: 25, noiseBps: 50, seed: 3 });
    const [v] = judgeAll(trades, [{ id: "h", claim: "c", select: () => true }]);
    expect(v.verdict).toBe("CONVICTED");
    expect(v.netCi95[0]).toBeGreaterThan(0);
  });

  it("does not convict noise, and reports the detectable effect size", () => {
    const trades = makeTrades({ n: 300, edgeBps: 0, noiseBps: 60, seed: 4 });
    const [v] = judgeAll(trades, [{ id: "h", claim: "c", select: () => true }]);
    expect(v.verdict).toBe("NOT PROVEN");
    expect(v.mdeBps).toBeGreaterThan(0);
  });

  it("diagnoses a gross edge eaten by costs", () => {
    const trades = makeTrades({ n: 300, edgeBps: -6, costBps: 10, noiseBps: 20, seed: 5 });
    const [v] = judgeAll(trades, [{ id: "h", claim: "c", select: () => true }]);
    expect(v.verdict).toBe("NOT PROVEN");
    expect(v.grossBps).toBeGreaterThan(0);
    expect(v.diagnosis).toMatch(/eaten by/);
  });

  it("refuses to judge too few trades", () => {
    const [v] = judgeAll(makeTrades({ n: 12, edgeBps: 50, seed: 6 }), [
      { id: "h", claim: "c", select: () => true },
    ]);
    expect(v.failed.some((f) => f.startsWith("evidence"))).toBe(true);
  });
});

describe("episode clustering", () => {
  it("widens the interval when trades share market moves", () => {
    const iid = makeTrades({ n: 240, edgeBps: 5, perEpisode: 1, seed: 7 }).map((t, i) => ({
      net: (t.netUsd / t.notional) * 1e4,
      episode: i,
    }));
    const clustered = makeTrades({ n: 240, edgeBps: 5, perEpisode: 8, seed: 7 }).map((t) => ({
      net: (t.netUsd / t.notional) * 1e4,
      episode: Math.floor(t.openedAt / (6 * H)),
    }));
    // Treating clustered trades as independent understates uncertainty.
    const naive = clustered.map((r, i) => ({ ...r, episode: i }));
    const w = (b: number[]) => b[Math.floor(b.length * 0.975)] - b[Math.floor(b.length * 0.025)];
    expect(w(clusteredBootstrap(clustered, 2000, mulberry32(1)))).toBeGreaterThan(
      w(clusteredBootstrap(naive, 2000, mulberry32(1))) * 1.5,
    );
    expect(iid.length).toBe(240);
  });
});

describe("deflation", () => {
  it("raises the bar as hypotheses are added", () => {
    const x = Array.from({ length: 100 }, (_, i) => (i % 2 ? 30 : -10));
    const a = deflatedT(3, 0.3, x, 1, 1);
    const b = deflatedT(3, 0.3, x, 40, 1);
    expect(a.t0).toBe(0);
    expect(b.t0).toBeGreaterThan(2);
    expect(b.dsr).toBeLessThan(a.dsr);
  });
});

describe("docket", () => {
  it("is declared from epochs and sources, not outcomes", () => {
    const trades = [
      ...makeTrades({ n: 40, edgeBps: 0, epoch: "v1r", seed: 8 }),
      ...makeTrades({ n: 40, edgeBps: 0, epoch: "v3", sources: ["sigmalui"], seed: 9 }),
    ];
    expect(buildDocket(trades).map((h) => h.id)).toEqual([
      "epoch:v1r",
      "epoch:v3",
      "source:sigmalui",
      "source:internal",
      "all",
    ]);
  });
});

describe("DecayWatch", () => {
  const rng = mulberry32(11);
  const gauss = () => Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng());
  const tested = Array.from({ length: 250 }, () => 30 + gauss() * 150);

  it("rarely retires a signal performing as tested", () => {
    const w0 = DecayWatch.calibrated(tested, 100, 0.05, 4000, 3);
    const r = mulberry32(99);
    let alarms = 0;
    for (let s = 0; s < 300; s++) {
      const w = new DecayWatch(w0.testedMean, w0.testedSd, w0.h);
      for (let j = 0; j < 100; j++) w.update(tested[Math.floor(r() * tested.length)]);
      if (w.status === "RETIRED") alarms++;
    }
    expect(alarms / 300).toBeLessThan(0.1);
  });

  it("retires a signal whose edge died", () => {
    const w = DecayWatch.calibrated(tested);
    for (let j = 0; j < 200; j++) w.update(-10 + gauss() * 150);
    expect(w.status).toBe("RETIRED");
  });
});
