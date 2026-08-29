#!/usr/bin/env -S npx tsx
// Standalone, browser-free process that keeps the swarm trading around the
// clock. Drives the exact same src/lib/engine-runtime.ts the dashboard uses,
// so the VPS can never silently diverge from what the preview does — the
// only thing that differs is where persistence and the heartbeat go.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { fetchPerpetualSymbols, setAgentWeights } from "../src/lib/swarm";
import { deriveEdge, type LearnedEdge } from "../src/lib/edge-model";
import { DEFAULT_PAPER_CONFIG } from "../src/lib/paper-broker";
import { createEngineRuntime } from "../src/lib/engine-runtime";
import { EMPTY_SHADOW_STATS, type ShadowStats } from "../src/lib/shadow-book";
import {
  createRunnerSupabaseClient,
  signInBotUser,
  loadBootState,
  createSupabasePersistence,
  loadShadowBoot,
  loadGridBoot,
  upsertHeartbeat,
} from "./db";
import { getGridExecutionMode, canPlaceGridOrders } from "./bybit-grid";
import { GridRuntimeCoordinator } from "./grid-runtime";
import { startHealthServer, type HealthStatus } from "./health";
import { BinanceDemoCoordinator } from "./binance-runtime";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Minimal .env loader — no extra dependency, and works the same whether run
// via `npm run runner`, `tsx runner/index.ts`, or inside the runner container.
function loadDotEnv(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv(join(__dirname, ".env"));

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  const value = v.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith("`") && value.endsWith("`"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

const HEARTBEAT_INTERVAL_MS = 15_000;
const STATUS_LOG_INTERVAL_MS = 60_000;
const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? 8090);
/**
 * Exit if the engine goes this long without a single tick. Across ~700 perps
 * even a dead-quiet market ticks many times a second, so silence this long
 * means the price feed is gone, not that nothing traded.
 *
 * A failing HEALTHCHECK does not restart anything on its own — Docker's
 * `restart: always` acts on process exit, not on health status. Without this
 * the container sits "unhealthy" indefinitely with its timers still running
 * and its status log still printing, which is exactly how the swarm stalled
 * for hours while looking alive. The feed watchdogs should recover first;
 * this is the backstop for when they cannot.
 */
const TICK_STALL_EXIT_MS = Number(process.env.TICK_STALL_EXIT_MS ?? 5 * 60_000);

async function main() {
  // Neon (DATABASE_URL) is the canonical login and trade-data store.
  // Supabase variables are accepted only for explicit legacy mirroring and
  // are never required for the VPS runner.
  const dataStore = (process.env.DATA_STORE ?? "neon").toLowerCase();
  if (!process.env.DATABASE_URL) {
    throw new Error("Missing DATABASE_URL — Neon is required by the VPS runner.");
  } else {
    console.log("[runner] Neon login enabled.");
  }
  console.log(`[runner] trade data store: ${dataStore === "neon" ? "neon" : "supabase"}`);
  const RUNNER_EMAIL = requireEnv("RUNNER_EMAIL");
  const RUNNER_PASSWORD = requireEnv("RUNNER_PASSWORD");

  const supabase = createRunnerSupabaseClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_PUBLISHABLE_KEY,
  );
  const c = DEFAULT_PAPER_CONFIG;
  console.log(
    `[paper-broker] riskPerTrade: ${c.riskPerTrade}, leverage: ${c.leverage}, ` +
      `maxPositions: ${c.maxPositions}, slPct: ${c.slPct}, ` +
      `startingBalance: ${c.startingBalance}, maxMarginUsage: ${c.maxMarginUsage}`,
  );

  console.log("[runner] signing in...");
  const userId = await signInBotUser(supabase, RUNNER_EMAIL, RUNNER_PASSWORD);
  console.log(`[runner] signed in as ${RUNNER_EMAIL} (${userId})`);

  console.log("[runner] loading persisted account, trades and edge report...");
  const { boot, report } = await loadBootState(supabase, userId);
  console.log(
    `[runner] resumed: ${boot.open.length} open, ${boot.closed.length} closed (of last 200), ` +
      `realized pnl $${boot.account.realizedPnl.toFixed(2)}`,
  );

  // Best-effort: a shadow book that fails to load costs history, not trading.
  let shadowBoot;
  try {
    shadowBoot = await loadShadowBoot(userId);
    console.log(
      `[runner] shadow book resumed: ${shadowBoot.open.length} open, ` +
        `${shadowBoot.closed.length} closed`,
    );
  } catch (e) {
    console.error("[runner] shadow book load failed, starting empty:", e);
  }

  // Grid engine ships present but gated: only FUTURES_GRID_MODE=testnet can
  // reach the exchange, so a paper-mode image cannot place an order at all.
  const gridMode = getGridExecutionMode();
  console.log(
    `[grid] execution mode=${gridMode} ` +
      `(orders ${canPlaceGridOrders(gridMode) ? "ENABLED" : "suppressed"})`,
  );

  let gridBoot;
  try {
    gridBoot = await loadGridBoot(userId);
    console.log(
      gridBoot.length > 0
        ? `[grid] state restored: ${gridBoot.map((g) => g.config.symbol).join(", ")}`
        : "[grid] no persisted grids",
    );
  } catch (e) {
    console.error("[grid] state load failed, starting with no grids:", e);
  }

  console.log("[runner] discovering Bybit USDT perpetual symbols...");
  const symbols = await fetchPerpetualSymbols();
  console.log(`[runner] tracking ${symbols.length} symbols`);

  let learned: LearnedEdge = deriveEdge(report, DEFAULT_PAPER_CONFIG.minConfidence);
  setAgentWeights(learned.agentWeights);

  const startedAt = new Date();
  let stopping = false;

  const persistence = createSupabasePersistence(supabase, userId, (message) =>
    console.error(`[runner] persist error: ${message}`),
  );

  let lastTickRate = 0;
  let lastShadow: ShadowStats = EMPTY_SHADOW_STATS;
  const health: HealthStatus = {
    status: "starting",
    startedAt: startedAt.getTime(),
    lastTickAt: null,
    equity: DEFAULT_PAPER_CONFIG.startingBalance + boot.account.realizedPnl,
    openPositions: boot.open.length,
    closedTrades: boot.closed.length,
  };
  startHealthServer(HEALTH_PORT, () => health);
  console.log(`[runner] health endpoint on :${HEALTH_PORT}/health`);

  // Binance demo (testnet) execution plane. Constructed after the engine, but
  // referenced from the hooks below, so it starts as null and is assigned once
  // the runtime exists — an open before start() simply stays paper-only.
  let binanceDemo: BinanceDemoCoordinator | null = null;

  const runtime = createEngineRuntime({
    symbols,
    boot,
    getLearned: () => learned,
    persistence,
    shadowBoot,
    gridBoot,
    hooks: {
      onReportUpdate: (report) => {
        learned = deriveEdge(report, DEFAULT_PAPER_CONFIG.minConfidence);
        setAgentWeights(learned.agentWeights);
        runtime.getBroker().setMinConfidence(learned.minConfidence);
      },
      onHalt: (reason) => {
        health.status = "halted";
        console.warn(`[runner] HALTED: ${reason}`);
      },
      onOpen: (p) => {
        console.log(`[runner] OPEN  ${p.side} ${p.symbol} @ ${p.entryPrice}`);
        binanceDemo?.onPaperOpen(p);
      },
      onClose: (t) => {
        console.log(
          `[runner] CLOSE ${t.side} ${t.symbol} @ ${t.exitPrice} pnl=$${t.pnl.toFixed(2)} (${t.reason})`,
        );
        binanceDemo?.onPaperClose(t);
      },
      onTick: (t) => {
        health.lastTickAt = Date.now();

        // Mark any grid on this symbol. In paper mode no orders exist, so the
        // position fields are genuinely zero and liquidation genuinely unknown
        // — reported as null rather than 0, which would read as "at the mark".
        const grid = runtime.getGridState(t.symbol);
        if (grid) {
          const result = runtime.updateGridRiskState(t.symbol, {
            markPrice: t.price,
            positionQty: grid.positionQty,
            positionNotionalUsd: grid.positionNotionalUsd,
            liquidationPrice: grid.liquidationPrice,
            marginUtilizationPct: grid.marginUtilizationPct,
            freeMarginPct: grid.freeMarginPct,
            unrealizedPnlUsd: grid.unrealizedPnlUsd,
            fundingUsd: grid.fundingUsd,
            now: t.time,
          });
          if (result && !result.risk.ok) {
            console.warn(`[grid] risk halt ${t.symbol}: ${result.risk.reasons.join(", ")}`);
          }
        }
      },
      onSnapshot: (s) => {
        lastTickRate = s.tickRate;
        lastShadow = s.shadow;
        if (health.status !== "halted") health.status = "running";
        health.equity = DEFAULT_PAPER_CONFIG.startingBalance + s.realizedPnl;
        health.openPositions = s.positions.length;
        health.closedTrades = s.closed.length;
        if (binanceDemo) {
          const b = binanceDemo.getStatus();
          health.binanceDemo = {
            configured: b.configured,
            enabled: b.enabled,
            armed: b.armed,
            ready: b.ready,
            equity: b.equity,
            openExchangePositions: b.openExchangePositions,
            mirroredTrades: b.mirroredTrades,
            submitFailures: b.submitFailures,
            avgSlippageBps: b.avgSlippageBps,
            keySource: b.keySource,
            lastError: b.lastError,
            lastHint: b.lastHint,
          };
        }
      },
    },
  });
  runtime.getBroker().setMinConfidence(learned.minConfidence);
  runtime.start();
  console.log("[runner] engine started");

  // The runner owns grid execution. The dashboard only writes intent.
  binanceDemo = new BinanceDemoCoordinator(runtime, supabase, userId);
  await binanceDemo.start();

  const gridCoordinator = new GridRuntimeCoordinator(runtime, userId);
  await gridCoordinator.start();
  console.log(`[grid] coordinator started (poll 2s, runner owns execution)`);

  const heartbeat = setInterval(() => {
    const broker = runtime.getBroker();
    const equity = DEFAULT_PAPER_CONFIG.startingBalance + broker.getRealizedPnl();
    void upsertHeartbeat(supabase, userId, startedAt, {
      status: "running",
      equity,
      closedTrades: broker.getClosed().length,
      ticksPerSec: lastTickRate,
      shadow: lastShadow,
    }).catch((e) => console.error("[runner] heartbeat failed:", e));
  }, HEARTBEAT_INTERVAL_MS);

  const statusLog = setInterval(() => {
    const broker = runtime.getBroker();
    const equity = DEFAULT_PAPER_CONFIG.startingBalance + broker.getRealizedPnl();
    const uptimeMin = Math.floor((Date.now() - startedAt.getTime()) / 60000);
    console.log(
      `[runner] uptime=${uptimeMin}m equity=$${equity.toFixed(2)} open=${broker.getPositions().length} closed=${broker.getClosed().length}`,
    );
  }, STATUS_LOG_INTERVAL_MS);

  // Backstop for a price feed the in-process watchdogs could not rebuild.
  // Exiting non-zero takes the whole container down so `restart: always`
  // brings back a clean process, rather than leaving a live-but-blind runner
  // holding open positions it can no longer mark.
  const stallWatch = setInterval(() => {
    if (stopping || health.status === "halted") return;
    const last = health.lastTickAt;
    const since = last === null ? Date.now() - startedAt.getTime() : Date.now() - last;
    if (since <= TICK_STALL_EXIT_MS) return;
    clearInterval(stallWatch);
    console.error(
      `[runner] no tick for ${Math.round(since / 1000)}s (limit ${Math.round(
        TICK_STALL_EXIT_MS / 1000,
      )}s) — price feed is dead, exiting so the supervisor restarts us`,
    );
    health.status = "stopped";
    process.exit(1);
  }, 30_000);

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[runner] received ${signal}, shutting down...`);
    health.status = "stopped";
    clearInterval(heartbeat);
    clearInterval(statusLog);
    clearInterval(stallWatch);
    gridCoordinator.stop();
    binanceDemo?.stop();
    runtime.stop();
    await upsertHeartbeat(supabase, userId, startedAt, {
      status: "stopped",
      equity: DEFAULT_PAPER_CONFIG.startingBalance + runtime.getBroker().getRealizedPnl(),
      closedTrades: runtime.getBroker().getClosed().length,
      ticksPerSec: 0,
      shadow: lastShadow,
    }).catch(() => {});
    // Zero ticksPerSec on stop is intentional — the runner is no longer ticking.
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("[runner] fatal:", e);
  process.exit(1);
});
