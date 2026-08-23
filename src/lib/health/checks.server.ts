// Server-side health probes. Only reachable from the /api/public/health
// route handler and never imported into the client bundle (*.server.ts is
// blocked by import protection).
import { rollup, type HealthComponent, type HealthReport } from "./types";

const PROBE_TIMEOUT_MS = 4000;

async function timed<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<{
  ok: true;
  value: T;
  ms: number;
} | { ok: false; error: string; ms: number }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const value = await fn(controller.signal);
    return { ok: true, value, ms: Date.now() - started };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: controller.signal.aborted ? `timeout after ${PROBE_TIMEOUT_MS}ms` : msg,
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

function bybitBase(): { rest: string; venue: string } {
  const venue = (process.env['BYBIT_ENV'] ?? "testnet").toLowerCase() === "mainnet"
    ? "mainnet"
    : "testnet";
  return {
    rest: venue === "mainnet" ? "https://api.bybit.com" : "https://api-testnet.bybit.com",
    venue,
  };
}

/**
 * Streaming venue reachability. The WebSocket itself lives in the browser /
 * runner, so what the server can verify is that the venue this deployment
 * points at is answering and clock-synced. The dashboard card merges this
 * with its own live socket counters.
 */
async function checkStream(): Promise<HealthComponent> {
  const r = await timed(async (signal) => {
    const res = await fetch("https://api.bybit.com/v5/market/time", { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { time?: number; result?: { timeSecond?: string } };
    const serverMs = body.result?.timeSecond
      ? Number(body.result.timeSecond) * 1000
      : (body.time ?? 0);
    return Math.abs(Date.now() - serverMs);
  });
  if (!r.ok) {
    return {
      id: "stream",
      label: "Market data venue",
      state: "down",
      detail: `Bybit public API unreachable — ${r.error}`,
      latencyMs: r.ms,
    };
  }
  const skewMs = r.value;
  const slow = r.ms > 1500;
  const skewed = skewMs > 5000;
  return {
    id: "stream",
    label: "Market data venue",
    state: slow || skewed ? "degraded" : "ok",
    detail: skewed
      ? `Clock skew ${(skewMs / 1000).toFixed(1)}s vs Bybit`
      : slow
        ? `Slow venue response (${r.ms} ms)`
        : `Bybit linear venue reachable, skew ${skewMs} ms`,
    latencyMs: r.ms,
  };
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Order-execution path. Skipped when no venue credentials are configured
 * (paper-only deployment); otherwise a read-only signed wallet call proves
 * the key, the signature and the account type all still work.
 */
async function checkExecution(): Promise<HealthComponent> {
  const key = process.env['BYBIT_TESTNET_API_KEY'] || process.env['BYBIT_API_KEY'];
  const secret = process.env['BYBIT_TESTNET_SECRET'] || process.env['BYBIT_SECRET'];
  const { rest, venue } = bybitBase();
  if (!key || !secret) {
    return {
      id: "execution",
      label: "Order execution",
      state: "skipped",
      detail: "No venue API credentials — paper execution only",
    };
  }
  const r = await timed(async (signal) => {
    const ts = String(Date.now());
    const recv = "5000";
    const query = "accountType=UNIFIED";
    const sign = await hmacHex(secret, ts + key + recv + query);
    const res = await fetch(`${rest}/v5/account/wallet-balance?${query}`, {
      signal,
      headers: {
        "X-BAPI-API-KEY": key,
        "X-BAPI-TIMESTAMP": ts,
        "X-BAPI-RECV-WINDOW": recv,
        "X-BAPI-SIGN": sign,
      },
    });
    const text = await res.text();
    if (!text) throw new Error(`empty response (HTTP ${res.status})`);
    let body: { retCode?: number; retMsg?: string };
    try {
      body = JSON.parse(text) as { retCode?: number; retMsg?: string };
    } catch {
      throw new Error(`non-JSON response (HTTP ${res.status})`);
    }
    if (body.retCode !== 0) throw new Error(`retCode ${body.retCode}: ${body.retMsg}`);
    return true;
  });
  return r.ok
    ? {
        id: "execution",
        label: "Order execution",
        state: r.ms > 2000 ? "degraded" : "ok",
        detail: `${venue} account authenticated`,
        latencyMs: r.ms,
      }
    : {
        id: "execution",
        label: "Order execution",
        state: "down",
        detail: `${venue} signed request failed — ${r.error}`,
        latencyMs: r.ms,
      };
}

/**
 * Redis. Upstash-style REST endpoints can be pinged from the edge runtime;
 * a raw redis:// TCP URL cannot be dialled here, so it is reported as
 * configured-but-unverified rather than faked as healthy.
 */
async function checkRedis(): Promise<HealthComponent> {
  const restUrl = process.env['UPSTASH_REDIS_REST_URL'];
  const restToken = process.env['UPSTASH_REDIS_REST_TOKEN'];
  const raw = process.env['REDIS_URL'];
  if (!restUrl || !restToken) {
    return {
      id: "redis",
      label: "Redis",
      state: "skipped",
      detail: raw
        ? "REDIS_URL set but TCP dialling is unavailable in this runtime — verified by the runner container instead"
        : "Not configured",
    };
  }
  const r = await timed(async (signal) => {
    const res = await fetch(`${restUrl.replace(/\/$/, "")}/ping`, {
      signal,
      headers: { Authorization: `Bearer ${restToken}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { result?: string };
    if (body.result !== "PONG") throw new Error(`unexpected reply ${body.result}`);
    return true;
  });
  return r.ok
    ? {
        id: "redis",
        label: "Redis",
        state: r.ms > 1500 ? "degraded" : "ok",
        detail: `PONG in ${r.ms} ms`,
        latencyMs: r.ms,
      }
    : { id: "redis", label: "Redis", state: "down", detail: r.error, latencyMs: r.ms };
}

/** NATS via its HTTP monitoring port (`/healthz` on :8222 by default). */
async function checkNats(): Promise<HealthComponent> {
  const monitor = process.env['NATS_MONITOR_URL'];
  const nats = process.env['NATS_URL'];
  if (!monitor) {
    return {
      id: "nats",
      label: "NATS",
      state: "skipped",
      detail: nats
        ? "NATS_URL set but NATS_MONITOR_URL missing — set it to the :8222 monitoring endpoint to health-check"
        : "Not configured",
    };
  }
  const r = await timed(async (signal) => {
    const res = await fetch(`${monitor.replace(/\/$/, "")}/healthz`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  });
  return r.ok
    ? {
        id: "nats",
        label: "NATS",
        state: r.ms > 1500 ? "degraded" : "ok",
        detail: `healthz ok in ${r.ms} ms`,
        latencyMs: r.ms,
      }
    : { id: "nats", label: "NATS", state: "down", detail: r.error, latencyMs: r.ms };
}

/** Trade database (the Supabase data plane) plus the Neon auth plane flag. */
async function checkDatabase(): Promise<HealthComponent> {
  const url = process.env['SUPABASE_URL'];
  const key = process.env['SUPABASE_PUBLISHABLE_KEY'];
  const neon = !!process.env['DATABASE_URL'];
  if (!url || !key) {
    return {
      id: "database",
      label: "Trade database",
      state: "down",
      detail: "Backend URL/key not configured — trades cannot persist",
    };
  }
  const r = await timed(async (signal) => {
    const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/`, {
      signal,
      headers: { apikey: key },
    });
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
    return true;
  });
  return r.ok
    ? {
        id: "database",
        label: "Trade database",
        state: r.ms > 2000 ? "degraded" : "ok",
        detail: `Data API reachable · auth plane ${neon ? "Neon" : "local"}`,
        latencyMs: r.ms,
      }
    : {
        id: "database",
        label: "Trade database",
        state: "down",
        detail: `Data API unreachable — ${r.error}`,
        latencyMs: r.ms,
      };
}

/** Fire-and-forget outbound alert when the report is not fully healthy. */
async function notify(report: HealthReport): Promise<void> {
  const hook = process.env['HEALTH_ALERT_WEBHOOK'];
  if (!hook || report.status === "ok") return;
  const failing = report.components.filter((c) => c.state === "down" || c.state === "degraded");
  try {
    await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `Alpha Swarm health ${report.status.toUpperCase()}: ${failing
          .map((c) => `${c.label} (${c.state}) — ${c.detail}`)
          .join(" | ")}`,
        report,
      }),
    });
  } catch {
    // Alerting must never fail the health endpoint itself.
  }
}

export async function runHealthChecks(): Promise<HealthReport> {
  const started = Date.now();
  const components = await Promise.all([
    checkStream(),
    checkExecution(),
    checkRedis(),
    checkNats(),
    checkDatabase(),
  ]);
  const report: HealthReport = {
    status: rollup(components),
    checkedAt: started,
    durationMs: Date.now() - started,
    components,
  };
  await notify(report);
  return report;
}
