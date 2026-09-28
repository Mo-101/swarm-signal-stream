import { describe, expect, it } from "vitest";
import type { Candle } from "../replay";
import { mirrorGrossBps } from "../shadow-mirror";

const M = 60_000;
const H = 3600_000;
const path = (f: (i: number) => number, n = 300): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const o = f(i);
    const c = f(i + 1);
    return { t: i * M, o, h: Math.max(o, c), l: Math.min(o, c), c };
  });

describe("mirrorGrossBps", () => {
  const long = {
    shadowId: "s",
    symbol: "X",
    side: "BUY",
    entry: 100,
    stop: 98,
    target: 104,
    openedAt: 30_000,
  };

  it("replays the opposite trade from the real entry price", () => {
    // price falls steadily: the real long stops out; its mirror (a short, stop 102, target 96) hits target
    const ks = path((i) => 100 - i * 0.02); // -0.02 per minute: 96 reached at minute 200
    expect(mirrorGrossBps(long, ks, 5 * H)).toBeCloseTo(400); // short target +4%
  });

  it("stops the mirror out when price rises", () => {
    const ks = path((i) => 100 + i * 0.02);
    expect(mirrorGrossBps(long, ks, 5 * H)).toBeCloseTo(-200); // short stop at 102
  });

  it("exits on the time limit", () => {
    const ks = path(() => 100.5);
    const bps = mirrorGrossBps(long, ks, 2 * H);
    expect(bps).toBeCloseTo(-50); // short from 100 marked at 100.5
  });

  it("returns null when candles do not cover the holding window", () => {
    expect(
      mirrorGrossBps(
        long,
        path(() => 100, 30),
        2 * H,
      ),
    ).toBeNull();
    expect(
      mirrorGrossBps(
        { ...long, stop: 0 },
        path(() => 100),
        2 * H,
      ),
    ).toBeNull();
  });
});
