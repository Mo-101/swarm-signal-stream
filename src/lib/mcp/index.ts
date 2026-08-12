import { auth, defineMcp } from "@lovable.dev/mcp-js";
import listPerpetualsTool from "./tools/list-perpetuals";
import marketMoversTool from "./tools/market-movers";
import analyzeSymbolTool from "./tools/analyze-symbol";

const projectRef = import.meta.env['VITE_SUPABASE_PROJECT_ID'] ?? "project-ref-unset";

export default defineMcp({
  name: "alpha-swarm",
  title: "Alpha Swarm",
  version: "0.1.0",
  instructions:
    "Market intelligence for Binance USDT-M perpetual futures, powered by the Alpha Swarm agent ensemble. Use `list_perpetuals` to discover tradable contracts including new listings, `market_movers` to rank contracts by 24h change or volume, and `analyze_symbol` to run the Trend/MeanRev/Breakout/Meme agents over recent candles for a weighted consensus signal. All tools are read-only analysis over public market data — none of them place, modify, or close orders.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [listPerpetualsTool, marketMoversTool, analyzeSymbolTool],
});

