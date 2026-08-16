// Tiny in-container supervisor: runs the dashboard and the headless runner
// as sibling processes inside ONE container. If either dies the whole
// container exits non-zero so `restart: always` brings both back together —
// no orchestration surprises where one half is silently down.
import { spawn } from "node:child_process";

const APP_PORT = process.env.PORT ?? "8080";
const children = new Map();
let stopping = false;

function start(name, cmd, args, env) {
  const child = spawn(cmd, args, {
    stdio: "inherit",
    env: env ? { ...process.env, ...env } : process.env,
  });
  children.set(name, child);
  console.log(`[supervisor] started ${name} (pid ${child.pid})`);
  child.on("exit", (code, signal) => {
    children.delete(name);
    if (stopping) return;
    console.error(`[supervisor] ${name} exited (${code ?? signal}) — stopping container`);
    shutdown(typeof code === "number" && code !== 0 ? code : 1);
  });
}

function shutdown(exitCode) {
  if (stopping) return;
  stopping = true;
  for (const [name, child] of children) {
    console.log(`[supervisor] stopping ${name}...`);
    child.kill("SIGTERM");
  }
  const deadline = setTimeout(() => {
    for (const child of children.values()) child.kill("SIGKILL");
    process.exit(exitCode);
  }, 10_000);
  deadline.unref();
  const check = setInterval(() => {
    if (children.size === 0) {
      clearInterval(check);
      clearTimeout(deadline);
      process.exit(exitCode);
    }
  }, 200);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

// Built output, not `vite dev`. The dev server resolves modules on demand from
// /src/**, so running it behind a public proxy served the entire application
// source to anyone who asked for it. It also ties server-function ids to live
// module-graph state, which stranded browser sessions on every deploy.
start("dashboard", "node", [".output/server/index.mjs"], {
  PORT: APP_PORT,
  HOST: "0.0.0.0",
});
start("runner", "npx", ["tsx", "runner/index.ts"]);
