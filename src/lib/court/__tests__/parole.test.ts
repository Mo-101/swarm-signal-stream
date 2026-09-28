import { describe, expect, it } from "vitest";
import { type CourtTrade, judgeAll, mulberry32 } from "../court";
import { courtState, parole, restartAfterRetirement, retirementVerdict } from "../parole";

const H = 3600_000;
const rng = mulberry32(21);
const gauss = () => Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng());
const trade = (i: number, netBps: number): CourtTrade => ({
  id: `t${i}`,
  symbol: "X",
  side: "BUY",
  epoch: "v1r",
  sources: [],
  openedAt: i * 7 * H,
  closedAt: i * 7 * H + H,
  notional: 1000,
  grossUsd: (netBps + 10) / 10,
  netUsd: netBps / 10,
});
const all = { id: "h", claim: "c", select: () => true };

describe("courtState", () => {
  it("finds the start of the current conviction run and the last retirement", () => {
    const st = courtState([
      { id: "a", verdict: "NOT PROVEN", at: 1 },
      { id: "a", verdict: "CONVICTED", at: 2 },
      { id: "a", verdict: "CONVICTED", at: 3 },
      { id: "b", verdict: "CONVICTED", at: 1 },
      { id: "b", verdict: "RETIRED", at: 5 },
      { id: "b", verdict: "NOT PROVEN", at: 6 },
    ]);
    expect(st.a).toEqual({ convictedSince: 2 });
    expect(st.b).toEqual({ retiredAt: 5 });
  });
});

describe("parole", () => {
  it("keeps a hypothesis active while it performs as tested", () => {
    const trades = [
      ...Array.from({ length: 200 }, (_, i) => trade(i, 40 + gauss() * 120)),
      ...Array.from({ length: 60 }, (_, i) => trade(200 + i, 40 + gauss() * 120)),
    ];
    const since = trades[200].closedAt;
    const [o] = parole(trades, [all], { h: { convictedSince: since } });
    expect(o.tested).toBe(200);
    expect(o.live).toBe(60);
    expect(o.status).not.toBe("RETIRED");
  });

  it("retires a hypothesis whose edge died after conviction", () => {
    const trades = [
      ...Array.from({ length: 200 }, (_, i) => trade(i, 40 + gauss() * 120)),
      ...Array.from({ length: 150 }, (_, i) => trade(200 + i, -20 + gauss() * 120)),
    ];
    const since = trades[200].closedAt;
    const [o] = parole(trades, [all], { h: { convictedSince: since } });
    expect(o.status).toBe("RETIRED");
    expect(o.retiredAtTrade).toBeGreaterThan(0);
    const [fresh] = judgeAll(trades, [all]);
    const r = retirementVerdict(fresh, o);
    expect(r.verdict).toBe("RETIRED");
    expect(r.diagnosis).toMatch(/decay watch crossed at live trade/);
  });

  it("waits for enough tested trades before watching", () => {
    const trades = Array.from({ length: 20 }, (_, i) => trade(i, 10));
    const [o] = parole(trades, [all], { h: { convictedSince: trades[10].closedAt } });
    expect(o.status).toBe("TOO EARLY");
  });

  it("restarts a retired hypothesis's evidence after its retirement", () => {
    const trades = Array.from({ length: 50 }, (_, i) => trade(i, 5));
    const [h] = restartAfterRetirement([all], { h: { retiredAt: trades[39].closedAt } });
    expect(trades.filter(h.select).length).toBe(10);
    expect(h.id).toBe("h");
  });
});
