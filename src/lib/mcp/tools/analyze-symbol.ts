import { defineTool, ToolError } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { candles } from "../market";
import { ALL_AGENTS, AGENT_WEIGHTS, combine } from "@/lib/swarm";

export default defineTool({
  name: "analyze_symbol",
  title: "Run the swarm on a symbol",
  description:
    "Run Alpha Swarm's four trading agents (Trend, MeanRev, Breakout, Meme) over recent Binance candles for one USDT-M perpetual and return each agent's vote plus the weighted consensus BUY/SELL/NEUTRAL signal and confidence. Analysis only — this places no orders.",
  inputSchema: {
    symbol: z
      .string()
      .describe("USDT-M perpetual symbol, e.g. 'BTCUSDT' or 'DOGEUSDT'."),
    interval: z
      .enum(["1m", "3m", "5m", "15m", "1h", "4h"])
      .optional()
      .describe("Candle interval to analyze. Defaults to '1m'."),
    threshold: z
      .number()
      .min(0)
      .max(3)
      .optional()
      .describe(
        "Weighted net score needed to emit a directional signal. Lower is more sensitive. Defaults to 0.6.",
      ),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async ({ symbol, interval, threshold }) => {
    const sym = symbol.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,20}$/.test(sym)) {
      throw new ToolError(`"${symbol}" is not a valid symbol. Use a form like BTCUSDT.`);
    }

    let data;
    try {
      data = await candles(sym, interval ?? "1m", 60);
    } catch (e) {
      throw new ToolError(
        `Could not load candles for ${sym}: ${e instanceof Error ? e.message : String(e)}. Use list_perpetuals to check the symbol exists.`,
      );
    }

    const price = data.closes[data.closes.length - 1];
    const proposal = combine(
      sym,
      price,
      data.closeTime,
      data.closes,
      data.quoteVolumes,
      ALL_AGENTS,
      threshold ?? 0.6,
    );

    // Recompute per-agent votes so the caller sees the breakdown even when the
    // consensus lands below threshold and combine() returns null.
    const agents = ALL_AGENTS.map((a) => {
      const sig = a.evaluate(data.closes, data.quoteVolumes);
      return {
        agent: a.name,
        direction: sig.direction,
        confidence: Number(sig.confidence.toFixed(3)),
        weight: AGENT_WEIGHTS[a.name] ?? 1,
      };
    });
    const net = agents.reduce(
      (sum, a) =>
        sum +
        (a.direction === "BUY"
          ? a.confidence * a.weight
          : a.direction === "SELL"
            ? -a.confidence * a.weight
            : 0),
      0,
    );

    const consensus = proposal
      ? { direction: proposal.direction, confidence: Number(proposal.confidence.toFixed(3)) }
      : { direction: "NEUTRAL" as const, confidence: 0 };

    const text = [
      `${sym} @ ${price} (${interval ?? "1m"} candles)`,
      `Consensus: ${consensus.direction}${consensus.direction === "NEUTRAL" ? " — no agreement above threshold" : ` (confidence ${consensus.confidence})`}`,
      `Weighted net score: ${net.toFixed(3)} vs threshold ${threshold ?? 0.6}`,
      "",
      ...agents.map(
        (a) => `  ${a.agent.padEnd(9)} ${a.direction.padEnd(8)} conf ${a.confidence}  (weight ${a.weight})`,
      ),
    ].join("\n");

    return {
      content: [{ type: "text", text }],
      structuredContent: {
        symbol: sym,
        price,
        interval: interval ?? "1m",
        netScore: Number(net.toFixed(3)),
        consensus,
        agents,
      },
    };
  },
});
