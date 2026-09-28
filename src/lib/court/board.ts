// Signal board: live signals with the court's standing attached.
//
// A signal belongs to several hypotheses at once (e.g. all swarm signals, its
// confidence bucket, each agent that voted for it). If ANY of those is
// CONVICTED and not retired, the signal is SURFACED with a forecast built from
// that hypothesis's evidence. Otherwise it is UNPROVEN and shows how close its
// best group is to conviction. Nothing unproven is ever presented as tradeable.
//
// Pure: no I/O.
import { confBucket, type Verdict } from "./court";

export type StoredVerdict = Verdict & { judgedAt: string };

export interface LiveSignal {
  source: "swarm" | "sigmalui";
  id: string;
  symbol: string;
  side: string;
  confidence: number | null;
  price: number | null;
  /** Quoted brackets (SigmaLui); swarm signals use v1r's 2% / 4%. */
  stopLoss: number | null;
  takeProfit: number | null;
  at: number;
  /** Swarm: agents that voted for the direction. SigmaLui: admitted by our ingester. */
  agrees?: string[];
  admitted?: boolean;
}

export interface Forecast {
  hypothesis: string;
  direction: string;
  entryRef: number | null;
  stop: number | null;
  target: number | null;
  expectedNetBps: number;
  ci95: [number, number];
  winRate: number;
  expiresAt: number;
  evidenceTrades: number;
  dsr: number;
  judgedAt: string;
}

export interface BoardRow extends LiveSignal {
  groups: string[];
  standing: "SURFACED" | "UNPROVEN";
  forecast: Forecast | null;
  /** Best unproven group: most charges passed, then highest DSR. */
  closest: { hypothesis: string; passed: number; dsr: number } | null;
}

export const CHARGE_COUNT = 8;
const SWARM_STOP = 0.02;
const SWARM_TARGET = 0.04;
const HOLD_MS = 48 * 3600_000;

/** Every hypothesis a live signal belongs to, in the court's own ids. */
export function groupsFor(s: LiveSignal): string[] {
  if (s.source === "sigmalui")
    return ["sigmalui:all", s.admitted ? "sigmalui:admitted" : "sigmalui:not-admitted"];
  const g = ["signals:all", "signals:not-executed"];
  if (s.confidence !== null) g.push(`signals:conf:${confBucket(s.confidence)}`);
  for (const a of s.agrees ?? []) g.push(`signals:agent:${a}`);
  return g;
}

const passed = (v: Verdict) => CHARGE_COUNT - v.failed.length;

function forecastFrom(s: LiveSignal, v: StoredVerdict): Forecast {
  const dir = s.side === "BUY" ? 1 : -1;
  const px = s.price;
  const stop = s.stopLoss ?? (px !== null ? px * (1 - dir * SWARM_STOP) : null);
  const target = s.takeProfit ?? (px !== null ? px * (1 + dir * SWARM_TARGET) : null);
  return {
    hypothesis: v.id,
    direction: s.side === "BUY" ? "LONG" : "SHORT",
    entryRef: px,
    stop,
    target,
    expectedNetBps: v.netBps,
    ci95: v.netCi95,
    winRate: v.winRate,
    expiresAt: s.at + HOLD_MS,
    evidenceTrades: v.n,
    dsr: v.dsr,
    judgedAt: v.judgedAt,
  };
}

export function buildBoard(
  signals: LiveSignal[],
  latest: Record<string, StoredVerdict>,
): BoardRow[] {
  return [...signals]
    .sort((a, b) => b.at - a.at)
    .map((s) => {
      const groups = groupsFor(s);
      const verdicts = groups.map((g) => latest[g]).filter((v): v is StoredVerdict => Boolean(v));
      // Most specific convicted group wins (later in the list = narrower).
      const convicted = verdicts.filter((v) => v.verdict === "CONVICTED");
      const best = convicted.length
        ? convicted.sort((a, b) => b.dsr - a.dsr || b.n - a.n)[0]
        : null;
      const unproven = verdicts
        .filter((v) => v.verdict !== "CONVICTED")
        .sort((a, b) => passed(b) - passed(a) || b.dsr - a.dsr)[0];
      return {
        ...s,
        groups,
        standing: best ? "SURFACED" : "UNPROVEN",
        forecast: best ? forecastFrom(s, best) : null,
        closest: unproven
          ? { hypothesis: unproven.id, passed: passed(unproven), dsr: unproven.dsr }
          : null,
      } satisfies BoardRow;
    });
}

/** Every judged hypothesis ranked by how close it is to conviction. */
export function leaderboard(latest: Record<string, StoredVerdict>, top = 8): StoredVerdict[] {
  return Object.values(latest)
    .filter((v) => v.verdict !== "RETIRED")
    .sort(
      (a, b) =>
        Number(b.verdict === "CONVICTED") - Number(a.verdict === "CONVICTED") ||
        passed(b) - passed(a) ||
        b.dsr - a.dsr ||
        (b.netCi95[0] ?? -Infinity) - (a.netCi95[0] ?? -Infinity),
    )
    .slice(0, top);
}
