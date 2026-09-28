// Runs the court's REAL SQL (loaders, verdict store, SigmaLui evidence store)
// against an in-process Postgres (PGlite) loaded with src/lib/db/schema.sql,
// by routing the Neon client's tagged queries into it.
//
// PGlite is not a project dependency (keeps package.json and the Lovable
// lockfiles untouched). To run these tests:
//   npm i --no-save @electric-sql/pglite && npx vitest run src/lib/court
// Without it, this suite is skipped.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

type Db = {
  exec: (q: string) => Promise<unknown>;
  query: (q: string, v?: unknown[]) => Promise<{ rows: unknown[] }>;
};
let db: Db | null = null;
try {
  const mod = "@electric-sql/pglite";
  const { PGlite } = (await import(/* @vite-ignore */ mod)) as { PGlite: new () => Db };
  db = new PGlite();
} catch {
  db = null;
}
const tag = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
  const text = strings.reduce((a, s, i) => a + s + (i < vals.length ? `$${i + 1}` : ""), "");
  return (await db!.query(text, vals)).rows;
};
vi.mock("@/lib/db/neon", () => ({
  getNeonSql: () => tag,
  getNeonSqlOrNoop: () => tag,
  neonDataEnabled: () => true,
}));

const U = "11111111-1111-1111-1111-111111111111";
const H = 3600_000;
const now = Date.UTC(2026, 8, 28, 9, 0);

beforeAll(async () => {
  if (!db) return;
  await db.exec(readFileSync("src/lib/db/schema.sql", "utf8"));
  // signals: repeats every 5 minutes; 3 symbols, both sides, agents jsonb
  const rows: string[] = [];
  for (let k = 0; k < 600; k++) {
    const t = new Date(now - 3 * 86_400_000 + k * 5 * 60_000).toISOString();
    const sym = ["SOLUSDT", "LINKUSDT", "DOGEUSDT"][k % 3];
    const side = k % 7 < 4 ? "BUY" : "SELL";
    const agents = JSON.stringify({
      Trend: { direction: side, confidence: 0.7 },
      MeanRev: { direction: side === "BUY" ? "SELL" : "BUY", confidence: 0.4 },
    });
    rows.push(
      `('${U}','${sym}','${side}',100,${0.5 + (k % 5) / 10},'b','trend',1,'${agents}'::jsonb,${k % 50 === 0},'${t}')`,
    );
  }
  await db.exec(
    `INSERT INTO signals (user_id,symbol,side,price,confidence,conf_bucket,regime,hour_utc,agents,executed,created_at) VALUES ${rows.join(",")}`,
  );
  // shadow trades
  for (let k = 0; k < 40; k++) {
    const o = new Date(now - 2 * 86_400_000 + k * H).toISOString();
    const c = new Date(now - 2 * 86_400_000 + k * H + H).toISOString();
    await db!.query(
      `INSERT INTO shadow_trades (user_id, shadow_id, symbol, side, reason, confidence, notional, entry_price, stop_loss, take_profit,
         status, last_price, last_marked_at, gross_bps, net_bps, net_usd, opened_at, closed_at)
       VALUES ($1,$2,'SOLUSDT','BUY',$3,$4,1000,100,98,104,'closed',101,$5,$6,$7,$8,$9,$5)`,
      [
        U,
        `sh${k}`,
        k % 2 ? "blocked" : "confidence",
        0.55 + (k % 4) * 0.1,
        c,
        20 - (k % 5) * 10,
        8 - (k % 5) * 10,
        (8 - (k % 5) * 10) / 10,
        o,
      ],
    );
  }
  // paper trades
  for (let k = 0; k < 10; k++) {
    await db!.query(
      `INSERT INTO paper_trades (user_id, client_id, symbol, side, entry_price, exit_price, size, notional, stop_loss, take_profit,
         confidence, conf_bucket, agents, status, pnl, gross_pnl, fees, funding, opened_at, closed_at, strategy_epoch)
       VALUES ($1,$2,'SOLUSDT','BUY',100,101,10,1000,98,104,0.7,'b','{"Trend":{"direction":"BUY","confidence":0.7}}'::jsonb,'closed',$3,$4,1.1,0.1,$5,$6,'v1r')`,
      [
        U,
        `c${k}`,
        5 - k,
        6.2 - k,
        new Date(now - (20 - k) * H).toISOString(),
        new Date(now - (19 - k) * H).toISOString(),
      ],
    );
  }
});

describe.skipIf(!db)("court SQL against the real schema", () => {
  it("loads signal events per day with DISTINCT ON and agents", async () => {
    const { loadSignalEvents } = await import("../store.server");
    const ev = await loadSignalEvents(U, 5, now);
    // 600 rows every 5 min over 50h = 3 symbols x 2 sides x ~25 blocks at most
    expect(ev.length).toBeGreaterThan(30);
    expect(ev.length).toBeLessThan(160);
    const keys = new Set(
      ev.map((e) => `${e.symbol}|${e.side}|${Math.floor(e.createdAt / (2 * H))}`),
    );
    expect(keys.size).toBe(ev.length); // one per (symbol, side, block)
    expect(ev.every((e) => e.agrees?.includes("Trend") && !e.agrees.includes("MeanRev"))).toBe(
      true,
    );
    expect(ev.some((e) => e.executed)).toBe(true);
  });

  it("loads shadow and paper trades and judges them in one session", async () => {
    const { judgeTrades } = await import("../store.server");
    const t = await judgeTrades(U);
    expect(t.paperCount).toBe(10);
    expect(t.shadowCount).toBe(40);
    const ids = t.docket.map((h) => h.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "epoch:v1r",
        "all",
        "shadow:all",
        "shadow:reason:blocked",
        "shadow:reason:confidence",
      ]),
    );
  });

  it("records verdicts, refuses changed rules, and reads history + latest back", async () => {
    const { judgeTrades, recordVerdicts, loadVerdictHistory, loadLatestVerdicts } =
      await import("../store.server");
    const { DEFAULT_RULES } = await import("../court");
    const t = await judgeTrades(U);
    const r1 = await recordVerdicts(t.verdicts, t.docket);
    expect(r1.written).toBe(t.verdicts.length);
    const r2 = await recordVerdicts(t.verdicts, t.docket, { ...DEFAULT_RULES, minDsr: 0.9 });
    expect(r2.written).toBe(0);
    expect(r2.refused.length).toBe(t.verdicts.length);
    const hist = await loadVerdictHistory(60);
    expect(hist["shadow:all"]).toHaveLength(1);
    expect(hist["shadow:all"][0].mde).not.toBeNull();
    const latest = await loadLatestVerdicts();
    expect(latest["shadow:all"].n).toBe(40);
  });

  it("stores and reloads SigmaLui evidence", async () => {
    const { persistSigmaLuiSignal } = await import("@/lib/db/sigmalui-store.server");
    const { loadSigmaLuiSignals } = await import("../store.server");
    const base = {
      symbol: "LINKUSDT",
      side: "BUY" as const,
      score: 0.95,
      entry: 10,
      stopLoss: 9.8,
      takeProfit: 10.4,
      feedTime: null,
      admitted: true,
      rejectReason: null,
      raw: { asset: "LINK" },
    };
    await persistSigmaLuiSignal({ ...base, signalId: "x1", firstSeenAt: now - H });
    await persistSigmaLuiSignal({ ...base, signalId: "x1", firstSeenAt: now }); // duplicate ignored
    await persistSigmaLuiSignal({
      ...base,
      signalId: "x2",
      firstSeenAt: now,
      admitted: false,
      rejectReason: "score 0.9 < 0.94",
    });
    const s = await loadSigmaLuiSignals();
    expect(s.map((x) => x.signalId)).toEqual(["x1", "x2"]);
    expect(s[0].firstSeenAt).toBe(now - H);
    expect(s[1].admitted).toBe(false);
  });
});
