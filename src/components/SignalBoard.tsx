// Signal board: the live signals, with the court's standing on each.
// SURFACED only when a group the signal belongs to is CONVICTED; otherwise it
// is shown as UNPROVEN with how close its best group is. Read-only.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { getSignalBoard, type SignalBoard as Board } from "@/lib/court.functions";
import type { BoardRow } from "@/lib/court/board";

const CHARGES = 8;
const n1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "—");
const px = (x: number | null) =>
  x === null || !Number.isFinite(x)
    ? "—"
    : x >= 100
      ? x.toFixed(2)
      : x >= 1
        ? x.toFixed(4)
        : x.toPrecision(4);
const ago = (ms: number) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return `${Math.max(0, Math.round(s))}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
};

function Progress({ passed }: { passed: number }) {
  return (
    <span
      className="inline-flex gap-0.5 align-middle"
      aria-label={`${passed} of ${CHARGES} charges answered`}
    >
      {Array.from({ length: CHARGES }, (_, i) => (
        <span
          key={i}
          className={`h-2 w-1.5 rounded-sm ${i < passed ? "bg-bull/70" : "bg-muted-foreground/25"}`}
        />
      ))}
    </span>
  );
}

function Row({ r }: { r: BoardRow }) {
  const f = r.forecast;
  return (
    <tr className="border-b border-border/50 align-top last:border-0">
      <td className="px-2 py-1.5 tabular-nums text-muted-foreground">{ago(r.at)}</td>
      <td className="px-2 py-1.5 text-muted-foreground">
        {r.source === "swarm" ? "swarm" : "SigmaLui"}
      </td>
      <td className="px-2 py-1.5 font-mono">{r.symbol}</td>
      <td className={`px-2 py-1.5 ${r.side === "BUY" ? "text-bull" : "text-bear"}`}>{r.side}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">
        {r.confidence === null ? "—" : r.confidence.toFixed(2)}
      </td>
      <td className="px-2 py-1.5">
        {r.standing === "SURFACED" ? (
          <span className="rounded bg-bull/15 px-1.5 py-0.5 text-[10px] font-semibold text-bull">
            SURFACED
          </span>
        ) : (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
            UNPROVEN
          </span>
        )}
      </td>
      <td className="px-2 py-1.5 text-[11px]">
        {f ? (
          <div className="space-y-0.5">
            <p className="text-foreground">
              {f.direction} · ref {px(f.entryRef)} · stop {px(f.stop)} · target {px(f.target)} ·
              expires {new Date(f.expiresAt).toLocaleString([], { hour12: false })}
            </p>
            <p className="text-muted-foreground">
              expected {n1(f.expectedNetBps)} bps net (95% {n1(f.ci95[0])}…{n1(f.ci95[1])}) · win{" "}
              {Math.round(f.winRate * 100)}% · {f.evidenceTrades} trades · DSR {f.dsr.toFixed(2)} ·
              by <span className="font-mono">{f.hypothesis}</span>
            </p>
          </div>
        ) : r.closest ? (
          <span className="text-muted-foreground">
            closest: <span className="font-mono">{r.closest.hypothesis}</span>{" "}
            <Progress passed={r.closest.passed} /> {r.closest.passed}/{CHARGES}
          </span>
        ) : (
          <span className="text-muted-foreground">no verdict yet for its groups</span>
        )}
      </td>
    </tr>
  );
}

export function SignalBoard() {
  const fetchBoard = useServerFn(getSignalBoard);
  const [b, setB] = useState<Board | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setB(await fetchBoard());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [fetchBoard]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  return <SignalBoardView board={b} error={err ?? b?.error ?? null} />;
}

export function SignalBoardView({ board, error }: { board: Board | null; error: string | null }) {
  if (!board && !error)
    return <p className="text-xs text-muted-foreground">Loading live signals…</p>;
  const rows = board?.rows ?? [];
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Signal board · {rows.length} live signals (6h) ·{" "}
          <span className={board?.surfaced ? "text-bull" : ""}>
            {board?.surfaced ?? 0} surfaced
          </span>
        </h3>
        <p className="text-[11px] text-muted-foreground">
          A signal is surfaced only when a group it belongs to is convicted. Unproven signals are
          shown, never recommended.
        </p>
      </div>
      {error && (
        <p className="rounded-md border border-bear/40 bg-bear/10 p-2 text-xs text-bear">{error}</p>
      )}
      {board && !board.judgedAny && (
        <p className="text-[11px] text-amber-400">
          No court session has run yet, so every signal is unproven. The runner judges every 6 hours
          (first session 2 minutes after start).
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-[11px]">
          <thead className="text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-2 py-1.5 font-medium">age</th>
              <th className="px-2 py-1.5 font-medium">source</th>
              <th className="px-2 py-1.5 font-medium">symbol</th>
              <th className="px-2 py-1.5 font-medium">side</th>
              <th className="px-2 py-1.5 text-right font-medium">conf</th>
              <th className="px-2 py-1.5 font-medium">standing</th>
              <th className="px-2 py-1.5 font-medium">forecast / evidence</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row key={`${r.source}-${r.id}`} r={r} />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-2 py-3 text-center text-muted-foreground">
                  No signals in the last 6 hours.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {board && board.leaderboard.length > 0 && (
        <div className="rounded-lg border border-border p-2">
          <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            Closest to conviction
          </p>
          <ol className="space-y-1 text-[11px]">
            {board.leaderboard.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-2">
                <Progress passed={CHARGES - v.failed.length} />
                <span className="font-mono text-foreground">{v.id}</span>
                <span className={v.verdict === "CONVICTED" ? "text-bull" : "text-muted-foreground"}>
                  {v.verdict}
                </span>
                <span className="text-muted-foreground">
                  net {n1(v.netBps)} bps · DSR {v.dsr.toFixed(2)} · {v.n} trades
                  {v.failed.length ? ` · next: ${v.failed[0].split(":")[0]}` : ""}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
