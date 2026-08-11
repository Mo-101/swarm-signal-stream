import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Alpha Swarm — Persistent Edge-Finding Paper Trading Engine" },
      {
        name: "description",
        content:
          "A paper trading swarm that streams every USDT perpetual, stores every signal and fill, and learns which agents, symbols and regimes actually carry edge.",
      },
      {
        property: "og:title",
        content: "Alpha Swarm — Persistent Edge-Finding Paper Trading Engine",
      },
      {
        property: "og:description",
        content:
          "Ingest, store and compound edge: per-agent, per-symbol, per-regime and confidence-calibrated paper trading.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

const FEATURES = [
  {
    title: "Every signal is stored",
    body: "Consensus proposals stream into your private database with agent votes, price, regime and confidence bucket — nothing is lost on refresh.",
  },
  {
    title: "Every fill is an experiment",
    body: "Paper trades persist with entry, stop, target and realized outcome, so equity and history survive reloads and redeploys.",
  },
  {
    title: "Edge is measured, not assumed",
    body: "Win rate and expectancy are scored per agent, per symbol, per volatility regime and per confidence bucket.",
  },
  {
    title: "The engine reweights itself",
    body: "Profitable agents get amplified, losing symbols get suppressed, and the entry threshold recalibrates toward buckets that actually pay.",
  },
];

function Landing() {
  return (
    <main className="min-h-screen bg-background px-6 py-16">
      <div className="mx-auto max-w-3xl">
        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
          Alpha Swarm
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          A paper trading engine whose product is edge, not trades.
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          The swarm streams every Bybit USDT-M perpetual, runs four agents on every tick, and
          writes each signal and simulated fill to your private store. Realized outcomes feed
          straight back into agent weights, symbol filters and confidence calibration.
        </p>

        <div className="mt-8 flex gap-3">
          <Link
            to="/auth"
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Sign in to your engine
          </Link>
          <Link
            to="/dashboard"
            className="rounded border border-border px-4 py-2 text-sm text-foreground hover:bg-muted"
          >
            Open terminal
          </Link>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2">
          {FEATURES.map((f) => (
            <section key={f.title} className="rounded-lg border border-border bg-card p-4">
              <h2 className="text-sm font-medium text-foreground">{f.title}</h2>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{f.body}</p>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
