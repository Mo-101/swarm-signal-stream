// Grid control plane, runner side.
//
// Polls futures_grid_state for work and drives the engine toward the desired
// state. The reconciliation invariant is:
//
//   config_version > applied_version  ->  apply configuration
//   config_version = applied_version  ->  do nothing
//
// which makes the loop idempotent: replaying it after a restart, or running it
// twice in the same second, changes nothing. The applied version is tracked in
// memory as well as in the row, because a write can fail after the engine has
// already been configured — taking the max of the two prevents reconfiguring a
// grid that is already live.
import { hostname } from "node:os";
import type { EngineRuntime } from "../src/lib/engine-runtime";
import {
  loadRunnableGridStates,
  persistGridRuntime,
  type PersistedGridState,
} from "../src/lib/db/edge-store.server";

const RUNNER_ID = `${hostname()}:${process.pid}`;
const GRID_SYNC_MS = 2_000;

export class GridRuntimeCoordinator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;
  private readonly applied = new Map<string, number>();

  constructor(
    private readonly engine: EngineRuntime,
    private readonly userId: string,
  ) {}

  async start(): Promise<void> {
    await this.sync();
    this.timer = setInterval(() => void this.sync(), GRID_SYNC_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Guarded against overlap: a slow database must not stack up sync passes. */
  private async sync(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      for (const row of await loadRunnableGridStates(this.userId)) {
        await this.reconcile(row);
      }
    } catch (error) {
      console.error("[grid] sync failed:", error instanceof Error ? error.message : error);
    } finally {
      this.syncing = false;
    }
  }

  private async reconcile(row: PersistedGridState): Promise<void> {
    const effectiveApplied = Math.max(this.applied.get(row.id) ?? 0, row.appliedVersion);

    if (row.desiredState === "stopped") {
      if (row.runtimeStatus !== "idle") {
        await persistGridRuntime({
          id: row.id,
          runtimeStatus: "idle",
          runtimeState: row.runtimeState,
          appliedVersion: row.configVersion,
          claimedBy: RUNNER_ID,
        });
        console.log(`[grid] stopped ${row.symbol}`);
      }
      this.applied.set(row.id, row.configVersion);
      return;
    }

    // Current version already applied — nothing to do.
    //
    // 'halted' counts as settled, not as work: a risk breach must stay latched
    // until the user changes the config (new version) or stops the grid.
    // Re-applying would rebuild the grid and silently clear the halt that the
    // risk model just raised.
    if (
      row.configVersion <= effectiveApplied &&
      (row.runtimeStatus === "running" || row.runtimeStatus === "halted")
    ) {
      return;
    }

    try {
      await persistGridRuntime({
        id: row.id,
        runtimeStatus: "starting",
        runtimeState: row.runtimeState,
        appliedVersion: effectiveApplied,
        claimedBy: RUNNER_ID,
      });

      const markPrice = this.resolveMarkPrice(row.symbol);
      const state = this.engine.configureGrid(row.config, markPrice);

      // Recorded before the write: if the write fails, the engine is still
      // configured, and re-applying would rebuild the grid underneath itself.
      this.applied.set(row.id, row.configVersion);

      await persistGridRuntime({
        id: row.id,
        runtimeStatus: "running",
        runtimeState: state,
        appliedVersion: row.configVersion,
        claimedBy: RUNNER_ID,
      });

      console.log(
        `[grid] configured ${row.symbol} version=${row.configVersion} ` +
          `mark=${markPrice} levels=${state.levels.length} ` +
          `buy=${state.buyOrders} sell=${state.sellOrders}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await persistGridRuntime({
        id: row.id,
        runtimeStatus: "error",
        runtimeState: row.runtimeState,
        appliedVersion: effectiveApplied,
        claimedBy: RUNNER_ID,
        lastError: message,
      }).catch(() => {});
      console.error(`[grid] ${row.symbol} configuration failed: ${message}`);
    }
  }

  /**
   * Uses the engine's own tick feed. A grid on a symbol that has not ticked yet
   * fails loudly rather than being configured against a guessed price — the
   * next sync pass retries once the feed has caught up.
   */
  private resolveMarkPrice(symbol: string): number {
    const price = this.engine.getMarkPrice(symbol);
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      throw new Error(`No mark price yet for ${symbol} — waiting for the tick feed`);
    }
    return price;
  }
}
