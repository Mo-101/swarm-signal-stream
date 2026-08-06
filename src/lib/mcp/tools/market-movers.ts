import { defineTool, ToolError } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { tickers24h } from "../market";

export default defineTool({
  name: "market_movers",
  title: "Market movers",
  description:
    "Rank Binance USDT-M perpetuals by 24h price change or traded volume to see what is running right now. Returns last price, 24h change %, high/low, and quote volume for each contract.",
  inputSchema: {
    rankBy: z
      .enum(["gainers", "losers", "volume"])
      .optional()
      .describe("Ranking to apply. Defaults to 'gainers'."),
    minQuoteVolume: z
      .number()
      .min(0)
      .optional()
      .describe(
        "Ignore contracts below this 24h quote volume in USDT, to filter out illiquid noise. Defaults to 1,000,000.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Number of contracts to return. Defaults to 15."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async ({ rankBy, minQuoteVolume, limit }) => {
    let rows;
    try {
      rows = await tickers24h();
    } catch (e) {
      throw new ToolError(
        `Could not reach Binance market data: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const mode = rankBy ?? "gainers";
    const floor = minQuoteVolume ?? 1_000_000;
    const n = limit ?? 15;

    const filtered = rows.filter(
      (r) => r.symbol.endsWith("USDT") && r.quoteVolume >= floor,
    );
    const sorted =
      mode === "volume"
        ? [...filtered].sort((a, b) => b.quoteVolume - a.quoteVolume)
        : mode === "losers"
          ? [...filtered].sort((a, b) => a.priceChangePct - b.priceChangePct)
          : [...filtered].sort((a, b) => b.priceChangePct - a.priceChangePct);

    const items = sorted.slice(0, n).map((r) => ({
      symbol: r.symbol,
      lastPrice: r.lastPrice,
      change24hPct: Number(r.priceChangePct.toFixed(2)),
      high24h: r.highPrice,
      low24h: r.lowPrice,
      quoteVolume24h: Math.round(r.quoteVolume),
    }));

    if (items.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No USDT-M perpetuals had at least ${floor.toLocaleString()} USDT of 24h volume.`,
          },
        ],
        structuredContent: { rankBy: mode, items: [] },
      };
    }

    const text =
      `Top ${items.length} by ${mode} (24h volume ≥ ${floor.toLocaleString()} USDT):\n` +
      items
        .map(
          (i) =>
            `${i.symbol}  ${i.lastPrice}  ${i.change24hPct >= 0 ? "+" : ""}${i.change24hPct}%  vol ${i.quoteVolume24h.toLocaleString()} USDT`,
        )
        .join("\n");

    return {
      content: [{ type: "text", text }],
      structuredContent: { rankBy: mode, minQuoteVolume: floor, items },
    };
  },
});
