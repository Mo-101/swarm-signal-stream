import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { candleSource, candlesFromTrades, type FetchLike } from "../candles.server";

const M = 60_000;
const DAY = 86_400_000;
const D0 = Date.UTC(2026, 8, 1); // 2026-09-01

/** Fake Bybit: serves newest-first minute candles for the requested window. */
function fakeBybit(opts: { failFirst?: number; status?: number; retCode?: number } = {}) {
  let calls = 0;
  const impl: FetchLike = async (url) => {
    calls++;
    if (calls <= (opts.failFirst ?? 0)) {
      if (opts.status) return { ok: false, status: opts.status, json: async () => ({}) };
      throw new Error("ECONNRESET");
    }
    if (opts.retCode)
      return {
        ok: true,
        status: 200,
        json: async () => ({ retCode: opts.retCode, retMsg: "nope" }),
      };
    const q = new URL(url).searchParams;
    const start = Number(q.get("start"));
    const end = Number(q.get("end"));
    const list: string[][] = [];
    for (let t = Math.ceil(start / M) * M; t <= end; t += M)
      list.push([String(t), "100", "101", "99", "100.5"]);
    list.reverse();
    return {
      ok: true,
      status: 200,
      json: async () => ({ retCode: 0, retMsg: "OK", result: { list } }),
    };
  };
  return { impl, calls: () => calls };
}

const noSleep = async () => {};

describe("candleSource", () => {
  it("assembles whole days and trims to the requested range", async () => {
    const f = fakeBybit();
    const src = candleSource({
      cacheDir: null,
      fetchImpl: f.impl,
      sleep: noSleep,
      now: () => D0 + 10 * DAY,
    });
    const ks = await src.get("SOLUSDT", D0 + 30 * M, D0 + DAY + 90 * M);
    expect(ks[0].t).toBe(D0 + 30 * M);
    expect(ks[ks.length - 1].t).toBe(D0 + DAY + 89 * M);
    expect(ks.length).toBe(1440 - 30 + 90);
    expect(f.calls()).toBe(4); // two days, two pages each
  });

  it("retries transient failures", async () => {
    const f = fakeBybit({ failFirst: 2 });
    const src = candleSource({
      cacheDir: null,
      fetchImpl: f.impl,
      sleep: noSleep,
      now: () => D0 + 10 * DAY,
    });
    const ks = await src.get("SOLUSDT", D0, D0 + 60 * M);
    expect(ks.length).toBe(60);
  });

  it("retries HTTP 429 and 5xx", async () => {
    const f = fakeBybit({ failFirst: 3, status: 429 });
    const src = candleSource({
      cacheDir: null,
      fetchImpl: f.impl,
      sleep: noSleep,
      now: () => D0 + 10 * DAY,
    });
    expect((await src.get("SOLUSDT", D0, D0 + 10 * M)).length).toBe(10);
  });

  it("fails fast on a permanent error", async () => {
    const f = fakeBybit({ retCode: 10001 });
    const src = candleSource({ cacheDir: null, fetchImpl: f.impl, sleep: noSleep });
    await expect(src.get("NOPEUSDT", D0, D0 + M)).rejects.toThrow(/code 10001/);
    expect(f.calls()).toBe(1);
  });

  it("caches closed days only, and serves them without the network", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "court-candles-"));
    const now = D0 + DAY + 3 * 3600_000; // day 0 closed, day 1 still open
    const f1 = fakeBybit();
    const a = candleSource({ cacheDir: dir, fetchImpl: f1.impl, sleep: noSleep, now: () => now });
    await a.get("SOLUSDT", D0, D0 + DAY + 60 * M);
    expect(await readdir(path.join(dir, "SOLUSDT"))).toEqual(["2026-09-01.json"]);

    const f2 = fakeBybit();
    const b = candleSource({ cacheDir: dir, fetchImpl: f2.impl, sleep: noSleep, now: () => now });
    const ks = await b.get("SOLUSDT", D0, D0 + DAY);
    expect(ks.length).toBe(1440);
    expect(f2.calls()).toBe(0);
    expect(b.stats.cachedDays).toBe(1);
  });
});

describe("archive mode", () => {
  const day0 = Date.UTC(2026, 8, 20);
  const csv = [
    "timestamp,symbol,side,size,price,tickDirection,trdMatchID,grossValue,homeNotional,foreignNotional,RPI",
    `${day0 / 1000 + 1.5},SOLUSDT,Buy,1,100.0,x,a,0,1,100,0`,
    `${day0 / 1000 + 20},SOLUSDT,Sell,1,99.5,x,b,0,1,99.5,0`,
    `${day0 / 1000 + 40},SOLUSDT,Buy,1,101.0,x,c,0,1,101,0`,
    `${day0 / 1000 + 59.9},SOLUSDT,Buy,1,100.5,x,d,0,1,100.5,0`,
    `${day0 / 1000 + 61},SOLUSDT,Buy,1,100.7,x,e,0,1,100.7,0`,
  ].join("\n");

  it("aggregates ticks into 1m OHLC", () => {
    expect(candlesFromTrades(csv, day0)).toEqual([
      { t: day0, o: 100, h: 101, l: 99.5, c: 100.5 },
      { t: day0 + 60_000, o: 100.7, h: 100.7, l: 100.7, c: 100.7 },
    ]);
  });

  it("reads gzipped archive days and treats an all-404 symbol as unavailable", async () => {
    const gz = gzipSync(csv);
    const urls: string[] = [];
    const src = candleSource({
      cacheDir: null,
      mode: "archive",
      now: () => day0 + 3 * 86_400_000,
      archiveFetch: async (u) => {
        urls.push(u);
        return u.includes("SOLUSDT2026-09-20") ? new Uint8Array(gz) : null;
      },
    });
    const ks = await src.get("SOLUSDT", day0, day0 + 86_400_000);
    expect(ks).toHaveLength(2);
    expect(urls[0]).toBe("https://public.bybit.com/trading/SOLUSDT/SOLUSDT2026-09-20.csv.gz");
    await expect(src.get("NOPEUSDT", day0, day0 + 86_400_000)).rejects.toThrow(
      /no archived trades/,
    );
  });
});
