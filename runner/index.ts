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
import {
  createRunnerSupabaseClient,
  signInBotUser,
  loadBootState,
  createSupabasePersistence,
  upsertHeartbeat,
} from "./db";
import { startHealthServer, type HealthStatus } from "./health";

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

async function main() {
  requireEnv("DATABASE_URL"); // read directly by src/lib/db/neon.ts
  const RUNNER_EMAIL = requireEnv("RUNNER_EMAIL");
  const RUNNER_PASSWORD = requireEnv("RUNNER_PASSWORD");

  const supabase = createRunnerSupabaseClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_PUBLISHABLE_KEY,
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

  const runtime = createEngineRuntime({
    symbols,
    boot,
    getLearned: () => learned,
    persistence,
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
      onOpen: (p) => console.log(`[runner] OPEN  ${p.side} ${p.symbol} @ ${p.entryPrice}`),
      onClose: (t) =>
        console.log(
          `[runner] CLOSE ${t.side} ${t.symbol} @ ${t.exitPrice} pnl=$${t.pnl.toFixed(2)} (${t.reason})`,
        ),
      onTick: () => {
        health.lastTickAt = Date.now();
      },
      onSnapshot: (s) => {
        lastTickRate = s.tickRate;
        if (health.status !== "halted") health.status = "running";
        health.equity = DEFAULT_PAPER_CONFIG.startingBalance + s.realizedPnl;
        health.openPositions = s.positions.length;
        health.closedTrades = s.closed.length;
      },
    },
  });
  runtime.getBroker().setMinConfidence(learned.minConfidence);
  runtime.start();
  console.log("[runner] engine started");

  const heartbeat = setInterval(() => {
    const broker = runtime.getBroker();
    const equity = DEFAULT_PAPER_CONFIG.startingBalance + broker.getRealizedPnl();
    void upsertHeartbeat(supabase, userId, startedAt, {
      status: "running",
      equity,
      closedTrades: broker.getClosed().length,
      ticksPerSec: lastTickRate,
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

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[runner] received ${signal}, shutting down...`);
    health.status = "stopped";
    clearInterval(heartbeat);
    clearInterval(statusLog);
    runtime.stop();
    await upsertHeartbeat(supabase, userId, startedAt, {
      status: "stopped",
      equity: DEFAULT_PAPER_CONFIG.startingBalance + runtime.getBroker().getRealizedPnl(),
      closedTrades: runtime.getBroker().getClosed().length,
      ticksPerSec: 0,
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
