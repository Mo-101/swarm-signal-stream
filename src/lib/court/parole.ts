// Parole: what happens to a hypothesis after the court convicts it.
//
// - Watch: trades closed since conviction are compared with the trades the
//   conviction rested on, using the calibrated CUSUM decay watch. If it
//   crosses its threshold, the hypothesis is RETIRED.
// - Restart: a retired hypothesis's evidence starts again from zero. Only
//   trades closed after retirement can convict it again, so it cannot flip
//   back to CONVICTED on the same stale history that just failed.
//
// Pure: no I/O. State comes from the court_verdicts history.
import type { CourtTrade, Hypothesis, Verdict } from "./court";
import { DecayWatch } from "./decay";

export interface HistoryRow {
  id: string;
  verdict: string;
  at: number;
}

export interface CourtState {
  /** Start of the current unbroken run of CONVICTED verdicts, if the latest is CONVICTED. */
  convictedSince?: number;
  /** Most recent retirement. */
  retiredAt?: number;
}

export function courtState(rows: HistoryRow[]): Record<string, CourtState> {
  const byId = new Map<string, HistoryRow[]>();
  for (const r of rows) {
    const l = byId.get(r.id);
    if (l) l.push(r);
    else byId.set(r.id, [r]);
  }
  const out: Record<string, CourtState> = {};
  for (const [id, list] of byId) {
    list.sort((a, b) => a.at - b.at);
    const st: CourtState = {};
    const retired = list.filter((r) => r.verdict === "RETIRED");
    if (retired.length) st.retiredAt = retired[retired.length - 1].at;
    if (list[list.length - 1].verdict === "CONVICTED") {
      let i = list.length - 1;
      while (i > 0 && list[i - 1].verdict === "CONVICTED") i--;
      st.convictedSince = list[i].at;
    }
    out[id] = st;
  }
  return out;
}

/** The docket with each retired hypothesis restricted to trades after its retirement. */
export function restartAfterRetirement(
  docket: Hypothesis[],
  state: Record<string, CourtState>,
): Hypothesis[] {
  return docket.map((h) => {
    const r = state[h.id]?.retiredAt;
    if (r === undefined) return h;
    return {
      ...h,
      claim: h.claim, // same claim and rules: the registry digest is unchanged
      select: (t: CourtTrade) => h.select(t) && t.closedAt > r,
    };
  });
}

export interface ParoleOutcome {
  id: string;
  tested: number;
  live: number;
  status: "ACTIVE" | "WATCH" | "RETIRED" | "TOO EARLY";
  retiredAtTrade: number;
  testedMeanBps: number;
  liveMeanBps: number;
}

const bps = (t: CourtTrade) => (t.netUsd / t.notional) * 1e4;
const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);

/** Run the decay watch for every hypothesis currently on parole. */
export function parole(
  trades: CourtTrade[],
  docket: Hypothesis[],
  state: Record<string, CourtState>,
  minTested = 30,
): ParoleOutcome[] {
  const out: ParoleOutcome[] = [];
  for (const h of docket) {
    const since = state[h.id]?.convictedSince;
    if (since === undefined) continue;
    const mine = trades.filter(h.select).sort((a, b) => a.closedAt - b.closedAt);
    const tested = mine.filter((t) => t.closedAt < since).map(bps);
    const live = mine.filter((t) => t.closedAt >= since).map(bps);
    const o: ParoleOutcome = {
      id: h.id,
      tested: tested.length,
      live: live.length,
      status: "TOO EARLY",
      retiredAtTrade: -1,
      testedMeanBps: mean(tested),
      liveMeanBps: mean(live),
    };
    if (tested.length >= minTested) {
      const w = DecayWatch.calibrated(tested);
      for (const x of live) w.update(x);
      o.status = live.length ? w.status : "ACTIVE";
      o.retiredAtTrade = w.retiredAt;
    }
    out.push(o);
  }
  return out;
}

/** The verdict row that records a retirement. */
export function retirementVerdict(fresh: Verdict, o: ParoleOutcome): Verdict {
  return {
    ...fresh,
    verdict: "RETIRED",
    diagnosis:
      `edge decayed after conviction: decay watch crossed at live trade ${o.retiredAtTrade} of ${o.live} ` +
      `(tested ${o.testedMeanBps.toFixed(1)} bps/trade, live ${o.liveMeanBps.toFixed(1)} bps/trade)`,
    failed: [...fresh.failed, `parole: edge decayed after conviction`],
  };
}
