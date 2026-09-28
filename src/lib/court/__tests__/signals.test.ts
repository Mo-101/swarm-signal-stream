import { describe, expect, it } from "vitest";
import { buildDocket, confBucket, type CourtTrade, judgeAll, SHADOW_EPOCH } from "../court";
import { type Candle, DEFAULT_REPLAY } from "../replay";
import { runReplay } from "../replay-run.server";
import { buildSignalDocket, signalEvents, type SignalRow, toReplaySignals } from "../signals";

const M = 60_000;
const H = 3600_000;

describe("signalEvents", () => {
  it("keeps the first signal per symbol/side per 2h block", () => {
    const rows: SignalRow[] = [
      {
        id: "a",
        symbol: "SOLUSDT",
        side: "BUY",
        confidence: 0.7,
        executed: false,
        createdAt: 10 * M,
      },
      {
        id: "b",
        symbol: "SOLUSDT",
        side: "BUY",
        confidence: 0.9,
        executed: false,
        createdAt: 20 * M,
      },
      {
        id: "c",
        symbol: "SOLUSDT",
        side: "SELL",
        confidence: 0.6,
        executed: false,
        createdAt: 30 * M,
      },
      {
        id: "d",
        symbol: "SOLUSDT",
        side: "BUY",
        confidence: 0.8,
        executed: true,
        createdAt: 2 * H + M,
      },
      {
        id: "e",
        symbol: "BTCUSDT",
        side: "BUY",
        confidence: 0.8,
        executed: false,
        createdAt: 15 * M,
      },
    ];
    expect(signalEvents(rows).map((r) => r.id)).toEqual(["a", "e", "c", "d"]);
  });
});

describe("signal replay end to end", () => {
  it("replays under v1r brackets and judges with the signal docket", async () => {
    // A market that rises steadily: BUY signals should win, SELL should lose.
    const candles: Candle[] = Array.from({ length: 6000 }, (_, i) => {
      const p = 100 * (1 + i * 0.00002);
      return { t: i * M, o: p, h: p * 1.0005, l: p * 0.9995, c: p };
    });
    const rows: SignalRow[] = Array.from({ length: 40 }, (_, i) => ({
      id: `s${i}`,
      symbol: "SOLUSDT",
      side: i % 4 === 0 ? "SELL" : "BUY",
      confidence: 0.55 + (i % 5) * 0.1,
      executed: i % 7 === 0,
      createdAt: i * 30 * M + 1,
    }));
    const signals = toReplaySignals(signalEvents(rows));
    expect(signals.every((s) => s.entry === null && s.epoch === "signals")).toBe(true);
    const run = await runReplay(
      signals,
      async () => candles,
      6000 * M,
      { ...DEFAULT_REPLAY, maxHoldMs: 48 * H },
      buildSignalDocket(
        signals.map((s) => ({
          id: s.signalId,
          symbol: s.symbol,
          side: s.side,
          epoch: "signals",
          sources: s.sources ?? [],
          openedAt: 0,
          closedAt: 0,
          notional: 1,
          grossUsd: 0,
          netUsd: 0,
        })),
      ),
    );
    expect(run.replayed).toBeGreaterThan(0);
    expect(run.verdicts.map((v) => v.id)).toContain("signals:all");
    expect(run.verdicts.map((v) => v.id)).toContain("signals:not-executed");
    const buys = run.trades.filter((t) => t.side === "BUY");
    const sells = run.trades.filter((t) => t.side === "SELL");
    expect(buys.every((t) => t.grossUsd > 0)).toBe(true);
    expect(sells.every((t) => t.grossUsd < 0)).toBe(true);
    // the exact mirror of a winning long is a losing short
    expect(buys.every((t) => (t.flippedNetUsd ?? 0) < t.netUsd)).toBe(true);
  });
});

describe("shadow docket", () => {
  const mk = (i: number, epoch: string, sources: string[]): CourtTrade => ({
    id: `${epoch}${i}`,
    symbol: "X",
    side: "BUY",
    epoch,
    sources,
    openedAt: i * 7 * H,
    closedAt: i * 7 * H + H,
    notional: 1000,
    grossUsd: 1,
    netUsd: 0.5,
  });
  it("keeps paper and shadow hypotheses apart in one docket", () => {
    const trades = [
      ...Array.from({ length: 5 }, (_, i) => mk(i, "v1r", ["Trend"])),
      ...Array.from({ length: 6 }, (_, i) =>
        mk(i, SHADOW_EPOCH, [
          `reason:${i % 2 ? "blocked" : "confidence"}`,
          `conf:${confBucket(0.55 + i * 0.07)}`,
        ]),
      ),
    ];
    const d = buildDocket(trades);
    const ids = d.map((h) => h.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "epoch:v1r",
        "all",
        "shadow:all",
        "shadow:reason:blocked",
        "shadow:reason:confidence",
      ]),
    );
    expect(ids).not.toContain("epoch:shadow");
    const all = d.find((h) => h.id === "all")!;
    expect(trades.filter(all.select).length).toBe(5); // paper only
    const v = judgeAll(trades, d);
    expect(v.find((x) => x.id === "shadow:all")!.n).toBe(6);
  });
});
