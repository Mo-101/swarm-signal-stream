import { defineTool, ToolError } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { listPerpetuals } from "../market";

export default defineTool({
  name: "list_perpetuals",
  title: "List USDT-M perpetuals",
  description:
    "List every USDT-M perpetual futures contract currently trading on Binance, including altcoins, memecoins, and new listings. Optionally filter by a substring and sort newest-listed first.",
  inputSchema: {
    filter: z
      .string()
      .optional()
      .describe("Case-insensitive substring to match against the symbol, e.g. 'DOGE'."),
    newestFirst: z
      .boolean()
      .optional()
      .describe("Sort by listing date, newest contracts first. Defaults to alphabetical."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("Maximum number of symbols to return. Defaults to 100."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async ({ filter, newestFirst, limit }) => {
    let rows;
    try {
      rows = await listPerpetuals();
    } catch (e) {
      throw new ToolError(
        `Could not reach Binance market data: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const total = rows.length;
    if (filter) {
      const needle = filter.toUpperCase();
      rows = rows.filter((r) => r.symbol.includes(needle));
    }
    rows = newestFirst
      ? [...rows].sort((a, b) => b.onboardDate - a.onboardDate)
      : [...rows].sort((a, b) => a.symbol.localeCompare(b.symbol));
    const capped = rows.slice(0, limit ?? 100);
    const items = capped.map((r) => ({
      symbol: r.symbol,
      baseAsset: r.baseAsset,
      listedOn: new Date(r.onboardDate).toISOString().slice(0, 10),
    }));

    const text = items.length
      ? `${items.length} of ${rows.length} matching contracts (${total} trading in total):\n` +
        items.map((i) => `${i.symbol} — listed ${i.listedOn}`).join("\n")
      : `No trading USDT-M perpetuals matched "${filter ?? ""}".`;

    return {
      content: [{ type: "text", text }],
      structuredContent: { total, matched: rows.length, items },
    };
  },
});
