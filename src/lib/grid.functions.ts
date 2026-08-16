// Grid control plane, web side.
//
// These handlers never call engine.configureGrid(). The web process writes
// *intent* to the database and returns; the runner owns execution. That split
// is not stylistic — the web app and the runner are separate containers with
// separate engine instances, so a grid configured in a request handler would
// place no orders and vanish when the request ended.
//
// Validation still happens here so bad geometry is rejected at the door rather
// than becoming a runner error the user has to go looking for.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/auth-middleware";
import {
  assertGridEconomics,
  validateGridConfig,
  type FuturesGridConfig,
} from "@/lib/futures-grid";

const economicsSchema = z.object({
  makerFeeRate: z.number().min(0),
  takerFeeRate: z.number().min(0),
  estimatedSlippageBps: z.number().min(0),
  expectedFundingRate: z.number().min(0),
  minimumNetEdgeBps: z.number().min(0),
});

const riskSchema = z.object({
  maxLeverage: z.number().positive(),
  minLiquidationDistancePct: z.number().min(0).max(1),
  maxMarginUtilizationPct: z.number().min(0).max(1),
  minFreeMarginPct: z.number().min(0).max(1),
  maxOpenGridOrders: z.number().int().positive(),
  maxPositionNotionalUsd: z.number().positive(),
});

const gridConfigSchema = z.object({
  symbol: z.string().trim().min(1).max(30),
  direction: z.enum(["long", "short", "neutral"]),
  lowerPrice: z.number().positive(),
  upperPrice: z.number().positive(),
  gridCount: z.number().int().min(2).max(200),
  gridType: z.enum(["arithmetic", "geometric"]),
  leverage: z.number().positive(),
  investmentUsd: z.number().positive(),
  qtyPerGrid: z.number().positive(),
  economics: economicsSchema,
  risk: riskSchema,
});

export const configureGrid = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input: unknown) => gridConfigSchema.parse(input))
  .handler(async ({ data, context }) => {
    const config = data as FuturesGridConfig;

    const validation = validateGridConfig(config);
    if (!validation.ok) {
      throw new Error(validation.errors.join("; "));
    }

    // Throws when a step cannot clear fees + funding + slippage. Rejecting a
    // knowingly unprofitable grid before it is stored keeps the runner from
    // having to reject it later, when the user is no longer watching.
    assertGridEconomics(config);

    const { upsertGridConfig } = await import("@/lib/db/edge-store.server");
    return upsertGridConfig({ userId: context.userId, config, desiredState: "running" });
  });

export const stopGrid = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input: { symbol: string }) =>
    z.object({ symbol: z.string().trim().min(1) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { loadGridStatesForUser, upsertGridConfig } = await import("@/lib/db/edge-store.server");

    const existing = (await loadGridStatesForUser(context.userId)).find(
      (grid) => grid.symbol === data.symbol,
    );
    if (!existing) throw new Error(`No grid configured for ${data.symbol}`);

    // Reuses the stored config so stopping cannot silently alter geometry.
    return upsertGridConfig({
      userId: context.userId,
      config: existing.config,
      desiredState: "stopped",
    });
  });

export const loadGridStates = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { loadGridStatesForUser } = await import("@/lib/db/edge-store.server");
    return loadGridStatesForUser(context.userId);
  });
