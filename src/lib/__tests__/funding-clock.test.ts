import { describe, expect, it } from "vitest";
import { FundingClock, formatInterval } from "@/lib/funding-clock";
import { DEFAULT_FUNDING_INTERVAL_MS } from "@/lib/math/perp";

const H = 3_600_000;
/** 2026-01-01T08:00:00Z — a point on the classic 8h UTC grid. */
const T8 = Date.UTC(2026, 0, 1, 8);

describe("FundingClock — schedule comes from the exchange", () => {
  it("falls back to the 8h UTC grid for an unknown symbol", () => {
    const c = new FundingClock();
    expect(c.intervalMs("NEWUSDT")).toBe(DEFAULT_FUNDING_INTERVAL_MS);
    const b = c.boundariesBetween("NEWUSDT", Date.UTC(2026, 0, 1, 7), Date.UTC(2026, 0, 1, 9));
    expect(b).toEqual([T8]);
  });

  it("takes the interval from instruments-info, in minutes", () => {
    const c = new FundingClock();
    c.setIntervalMinutes("ETHUSDT", 240);
    expect(c.intervalMs("ETHUSDT")).toBe(4 * H);
    c.setIntervalMinutes("MEMEUSDT", 60);
    expect(c.intervalMs("MEMEUSDT")).toBe(1 * H);
  });

  it("rejects an implausible interval rather than adopting it", () => {
    const c = new FundingClock();
    c.setIntervalMinutes("BADUSDT", 0);
    c.setIntervalMinutes("BADUSDT", 60 * 48);
    c.setIntervalMinutes("BADUSDT", Number.NaN);
    expect(c.intervalMs("BADUSDT")).toBe(DEFAULT_FUNDING_INTERVAL_MS);
  });

  it("anchors boundaries on nextFundingTime, not on a floor(t/8h) grid", () => {
    const c = new FundingClock();
    c.setIntervalMinutes("ODDUSDT", 480);
    // A contract settling at 01:00 / 09:00 / 17:00 UTC — invisible to a grid.
    const next = Date.UTC(2026, 0, 1, 17);
    c.applyTicker({ symbol: "ODDUSDT", nextFundingTime: next, fundingRate: "0.0001" });

    const b = c.boundariesBetween("ODDUSDT", Date.UTC(2026, 0, 1, 0), Date.UTC(2026, 0, 1, 12));
    expect(b).toEqual([Date.UTC(2026, 0, 1, 1), Date.UTC(2026, 0, 1, 9)]);
    // The 8h grid points 00:00 and 08:00 are NOT settlements for this contract.
    expect(b).not.toContain(T8);
  });

  it("produces one boundary per settlement on a 1h contract", () => {
    const c = new FundingClock();
    c.setIntervalMinutes("FASTUSDT", 60);
    c.applyTicker({ symbol: "FASTUSDT", nextFundingTime: Date.UTC(2026, 0, 1, 12) });
    const b = c.boundariesBetween("FASTUSDT", Date.UTC(2026, 0, 1, 8), Date.UTC(2026, 0, 1, 12));
    // 09:00, 10:00, 11:00, 12:00 — four, where a fixed 8h grid would find zero.
    expect(b).toHaveLength(4);
    expect(b[0]).toBe(Date.UTC(2026, 0, 1, 9));
    expect(b[3]).toBe(Date.UTC(2026, 0, 1, 12));
  });

  it("follows a schedule change without a restart", () => {
    const c = new FundingClock();
    c.setIntervalMinutes("SHIFTUSDT", 480);
    c.applyTicker({ symbol: "SHIFTUSDT", nextFundingTime: Date.UTC(2026, 0, 1, 16) });
    expect(c.getScheduleChanges()).toBe(0);

    // Bybit re-cuts the contract to 1h: next settlement is now 13:00.
    c.setIntervalMinutes("SHIFTUSDT", 60);
    const moved = c.applyTicker({
      symbol: "SHIFTUSDT",
      nextFundingTime: Date.UTC(2026, 0, 1, 13),
    });
    expect(c.intervalMs("SHIFTUSDT")).toBe(1 * H);
    expect(c.nextFundingAt("SHIFTUSDT", Date.UTC(2026, 0, 1, 12))).toBe(Date.UTC(2026, 0, 1, 13));
    // Moving the next time BACKWARDS is a re-cut, not a step, so it is not
    // counted as a forward schedule jump.
    expect(moved).toBe(false);
  });

  it("flags a forward jump that is not one interval as a schedule change", () => {
    const c = new FundingClock();
    c.setIntervalMinutes("JUMPUSDT", 480);
    c.applyTicker({ symbol: "JUMPUSDT", nextFundingTime: Date.UTC(2026, 0, 1, 8) });
    const moved = c.applyTicker({
      symbol: "JUMPUSDT",
      nextFundingTime: Date.UTC(2026, 0, 1, 20),
    });
    expect(moved).toBe(true);
    expect(c.getScheduleChanges()).toBe(1);
  });

  it("projects forward from a stale anchor instead of returning the past", () => {
    const c = new FundingClock();
    c.setIntervalMinutes("STALEUSDT", 480);
    c.applyTicker({ symbol: "STALEUSDT", nextFundingTime: T8 });
    // Feed died; 20h later the anchor is well in the past.
    const now = T8 + 20 * H;
    const next = c.nextFundingAt("STALEUSDT", now);
    expect(next).toBeGreaterThan(now);
    expect((next - T8) % (8 * H)).toBe(0);
  });

  it("prefers a settled rate over the predicted one", () => {
    const c = new FundingClock();
    c.applyTicker({ symbol: "BTCUSDT", fundingRate: "0.0001" });
    expect(c.rateAt("BTCUSDT", T8, 0.00005)).toEqual({ rate: 0.0001, source: "live" });

    c.setSettledRate("BTCUSDT", T8, 0.000123);
    expect(c.rateAt("BTCUSDT", T8, 0.00005)).toEqual({ rate: 0.000123, source: "settled" });
    // A different boundary is unaffected — settled rates are per settlement.
    expect(c.rateAt("BTCUSDT", T8 + 8 * H, 0.00005).source).toBe("live");
  });

  it("falls back to the configured default when the exchange gives nothing", () => {
    const c = new FundingClock();
    expect(c.rateAt("UNKNOWNUSDT", T8, 0.0001)).toEqual({ rate: 0.0001, source: "default" });
  });

  it("bounds the boundary list so a corrupt anchor cannot spin", () => {
    const c = new FundingClock();
    c.setIntervalMinutes("FASTUSDT", 60);
    c.applyTicker({ symbol: "FASTUSDT", nextFundingTime: T8 });
    const b = c.boundariesBetween("FASTUSDT", T8 - 400 * H, T8, 32);
    expect(b).toHaveLength(32);
  });

  it("labels intervals without hard-coding a period", () => {
    expect(formatInterval(8 * H)).toBe("8h");
    expect(formatInterval(4 * H)).toBe("4h");
    expect(formatInterval(1 * H)).toBe("1h");
    expect(formatInterval(30 * 60_000)).toBe("30m");
  });

  it("summarises the mixed schedules of an open book", () => {
    const c = new FundingClock();
    c.setIntervalMinutes("A", 480);
    c.setIntervalMinutes("B", 480);
    c.setIntervalMinutes("C", 240);
    expect(c.intervalMix(["A", "B", "C"])).toEqual({ "8h": 2, "4h": 1 });
  });
});
