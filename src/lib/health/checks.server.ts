// Server-side health probes. Only reachable from the /api/public/health
// route handler and never imported into the client bundle (*.server.ts is
// blocked by import protection).
import { failures, rollup, type HealthComponent, type HealthReport } from "./types";


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
  const testnetKey = process.env['BYBIT_TESTNET_API_KEY'];
  const key = testnetKey || process.env['BYBIT_API_KEY'];
  const secret = process.env['BYBIT_TESTNET_SECRET'] || process.env['BYBIT_SECRET'];
  const keySource = testnetKey ? "BYBIT_TESTNET_API_KEY" : "BYBIT_API_KEY";
  const { rest, venue } = bybitBase();
  const target = `${rest}/v5/account/wallet-balance`;
  if (!key || !secret) {
    return {
      id: "execution",
      label: "Order execution",
      state: "skipped",
      detail: "No venue API credentials — paper execution only",
      target,
      hint: "Set BYBIT_TESTNET_API_KEY / BYBIT_TESTNET_SECRET to enable live order routing.",
    };
  }
  let httpStatus: number | undefined;
  let retCode: number | undefined;
  const r = await timed(async (signal) => {
    const ts = String(Date.now());
    const recv = "5000";
    const query = "accountType=UNIFIED";
    const sign = await hmacHex(secret, ts + key + recv + query);
    const res = await fetch(`${target}?${query}`, {
      signal,
      headers: {
        "X-BAPI-API-KEY": key,
        "X-BAPI-TIMESTAMP": ts,
        "X-BAPI-RECV-WINDOW": recv,
        "X-BAPI-SIGN": sign,
      },
    });
    httpStatus = res.status;
    const text = await res.text();
    if (!text) throw new Error(`empty response (HTTP ${res.status})`);
    let body: { retCode?: number; retMsg?: string };
    try {
      body = JSON.parse(text) as { retCode?: number; retMsg?: string };
    } catch {
      throw new Error(`non-JSON response (HTTP ${res.status})`);
    }
    retCode = body.retCode;
    if (body.retCode !== 0) throw new Error(`retCode ${body.retCode}: ${body.retMsg}`);
    return true;
  });
  if (r.ok) {
    return {
      id: "execution",
      label: "Order execution",
      state: r.ms > 2000 ? "degraded" : "ok",
      detail: `${venue} account authenticated via ${keySource}`,
      latencyMs: r.ms,
      target,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(r.ms > 2000 ? { hint: `Venue responded slowly (${r.ms} ms) — orders may miss the touch.` } : {}),
    };
  }
  const credentialProblem = httpStatus === 401 || httpStatus === 403 || retCode !== undefined;
  const hint = credentialProblem
    ? `${keySource} is rejected by ${venue}${retCode !== undefined ? ` (retCode ${retCode})` : ""}${
        httpStatus !== undefined ? ` / HTTP ${httpStatus}` : ""
      } — regenerate the key on Bybit ${venue}, grant Unified Trading (read + trade) permission, and update ${keySource} / ${
        keySource === "BYBIT_TESTNET_API_KEY" ? "BYBIT_TESTNET_SECRET" : "BYBIT_SECRET"
      }. Paper trading is unaffected.`
    : `Cannot reach ${venue} at ${rest} — check outbound network / venue status. Paper trading is unaffected.`;
  return {
    id: "execution",
    label: "Order execution",
    // Rejected credentials only block LIVE orders — paper execution keeps
    // running — so that is a degradation, not a full outage. A network
    // failure to the venue is a real outage.
    state: credentialProblem ? "degraded" : "down",
    detail: `${venue} signed request failed — ${r.error}`,
    latencyMs: r.ms,
    target,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    hint,
  };
}

/**
 * Auth plane. Neon-local auth (`app_users` + LOCAL_AUTH_SECRET) is canonical;
 * the Supabase JWT path is a fallback. Reports which planes can actually
 * authenticate a sign-in right now, without touching any credential values.
 */
async function checkAuth(): Promise<HealthComponent> {
  const { neonEnabled } = await import("@/lib/db/neon");
  const neon = neonEnabled();
  const explicitSecret = Boolean(process.env['LOCAL_AUTH_SECRET']?.trim());
  const supabaseUrl = process.env['SUPABASE_URL'];
  const supabaseKey = process.env['SUPABASE_PUBLISHABLE_KEY'];
  const supabaseConfigured = Boolean(supabaseUrl && supabaseKey);

  if (!neon) {
    return {
      id: "auth",
      label: "Auth plane",
      state: supabaseConfigured ? "degraded" : "down",
      detail: supabaseConfigured
        ? "Neon auth store unavailable — Supabase JWT fallback only"
        : "No auth plane configured — sign-in is impossible",
      hint: "Set DATABASE_URL so local auth (app_users) can verify sign-ins.",
    };
  }

  const r = await timed(async () => {
    const { getNeonSql } = await import("@/lib/db/neon");
    const sql = getNeonSql();
    const rows = (await sql`select count(*)::int as n from app_users`) as { n: number }[];
    return rows[0]?.n ?? 0;
  });
  if (!r.ok) {
    return {
      id: "auth",
      label: "Auth plane",
      state: "down",
      detail: `Neon auth store unreachable — ${r.error}`,
      latencyMs: r.ms,
      hint: "Verify DATABASE_URL and that the app_users table exists (src/lib/db/schema.sql).",
    };
  }
  const tokens = explicitSecret ? "LOCAL_AUTH_SECRET" : "derived from DATABASE_URL";
  // Supabase fallback is optional: absent is fine, misconfigured is worth flagging.
  const supabaseNote = supabaseConfigured ? "Supabase fallback on" : "Supabase fallback off";
  return {
    id: "auth",
    label: "Auth plane",
    state: r.ms > 2000 ? "degraded" : "ok",
    detail: `Neon local auth · ${r.value} user${r.value === 1 ? "" : "s"} · tokens ${tokens} · ${supabaseNote}`,
    latencyMs: r.ms,
    ...(r.ms > 2000 ? { hint: `Auth store responded slowly (${r.ms} ms).` } : {}),
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
    checkAuth(),
    checkRedis(),
    checkNats(),
    checkDatabase(),
  ]);
  const failing = failures(components);
  const report: HealthReport = {
    status: rollup(components),
    checkedAt: started,
    durationMs: Date.now() - started,
    components,
    failing,
    summary: failing.length
      ? failing.map((f) => `${f.id} ${f.state}: ${f.detail}`).join(" | ")
      : "all checks passing",
  };
  await notify(report);
  return report;
}

