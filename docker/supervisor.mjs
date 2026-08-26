// Tiny in-container supervisor: runs the dashboard and the headless runner
// as sibling processes inside ONE container.
//
// Restart policy:
//   * Each child is restarted individually with exponential backoff (1s → 30s)
//     so a transient crash (feed drop, OOM in one half) never takes the whole
//     container down and never loses the other half's state.
//   * If a child crash-loops (>= MAX_RESTARTS inside RESTART_WINDOW_MS) the
//     supervisor gives up and exits non-zero so Docker's `restart: always`
//     recreates the container from scratch.
//
// Logs:
//   * Everything still goes to stdout/stderr (so `docker compose logs -f`
//     works unchanged) AND is appended to /app/logs/<name>.log, which is
//     bind-mounted to ./logs on the host so logs survive container replacement.
//   * Each file is rotated at MAX_LOG_BYTES into <name>.log.1 (single
//     generation — enough for a post-mortem, bounded on disk).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const APP_PORT = process.env.PORT ?? "8080";
const LOG_DIR = process.env.LOG_DIR ?? "/app/logs";
const MAX_LOG_BYTES = Number(process.env.MAX_LOG_BYTES ?? 20 * 1024 * 1024);
const MAX_RESTARTS = Number(process.env.MAX_RESTARTS ?? 10);
const RESTART_WINDOW_MS = 10 * 60_000;

const children = new Map();
const restarts = new Map(); // name -> timestamps[]
const streams = new Map();
let stopping = false;

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (err) {
  console.error(`[supervisor] cannot create ${LOG_DIR}: ${err?.message ?? err}`);
}

function logFile(name) {
  return path.join(LOG_DIR, `${name}.log`);
}

function openStream(name) {
  try {
    return fs.createWriteStream(logFile(name), { flags: "a" });
  } catch {
    return null;
  }
}

function rotateIfNeeded(name) {
  const file = logFile(name);
  try {
    if (fs.statSync(file).size < MAX_LOG_BYTES) return;
    streams.get(name)?.end();
    fs.renameSync(file, `${file}.1`);
    streams.set(name, openStream(name));
  } catch {
    /* file missing or fs read-only — keep logging to stdout only */
  }
}

function write(name, chunk, isError) {
  const text = chunk.toString();
  (isError ? process.stderr : process.stdout).write(text);
  const stream = streams.get(name);
  if (!stream) return;
  const stamped = text
    .split(/(?<=\n)/)
    .filter(Boolean)
    .map((line) => `${new Date().toISOString()} ${line}`)
    .join("");
  stream.write(stamped);
  rotateIfNeeded(name);
}

function crashLooping(name) {
  const now = Date.now();
  const hits = (restarts.get(name) ?? []).filter((t) => now - t < RESTART_WINDOW_MS);
  hits.push(now);
  restarts.set(name, hits);
  return hits.length > MAX_RESTARTS;
}

function start(name, cmd, args, attempt = 0) {
  if (stopping) return;
  if (!streams.has(name)) streams.set(name, openStream(name));

  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  children.set(name, child);
  child.stdout.on("data", (c) => write(name, c, false));
  child.stderr.on("data", (c) => write(name, c, true));
  write(name, `[supervisor] started ${name} (pid ${child.pid})\n`, false);

  child.on("exit", (code, signal) => {
    children.delete(name);
    if (stopping) return;
    write(name, `[supervisor] ${name} exited (${code ?? signal})\n`, true);

    if (crashLooping(name)) {
      write(
        name,
        `[supervisor] ${name} crash-looping (> ${MAX_RESTARTS} restarts in 10m) — exiting container\n`,
        true,
      );
      shutdown(1);
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** attempt);
    write(name, `[supervisor] restarting ${name} in ${Math.round(delay / 1000)}s\n`, false);
    setTimeout(() => start(name, cmd, args, attempt + 1), delay).unref?.();
  });

  // A child that stays up for 2 minutes is considered healthy: reset backoff.
  setTimeout(() => {
    if (children.get(name) === child) attempt = 0;
  }, 120_000).unref?.();
}

function shutdown(exitCode) {
  if (stopping) return;
  stopping = true;
  for (const [name, child] of children) {
    console.log(`[supervisor] stopping ${name}...`);
    child.kill("SIGTERM");
  }
  const finish = () => {
    for (const stream of streams.values()) stream?.end();
    process.exit(exitCode);
  };
  const deadline = setTimeout(() => {
    for (const child of children.values()) child.kill("SIGKILL");
    finish();
  }, 10_000);
  deadline.unref();
  const check = setInterval(() => {
    if (children.size === 0) {
      clearInterval(check);
      clearTimeout(deadline);
      finish();
    }
  }, 200);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

start("dashboard", "npx", ["vite", "--host", "0.0.0.0", "--port", APP_PORT]);
start("runner", "npx", ["tsx", "runner/index.ts"]);
