#!/usr/bin/env node
// Phase A of the Neon -> local Postgres signals archive migration.
//
// Freezes a (created_at, id) watermark on Neon's public.signals, streams every
// row at or before it into the local `mostar` database's archive.signals
// table (idempotent via an ON CONFLICT (signal_id) upsert that only rewrites
// a row when its payload/received_at actually differ from what Neon has now
// — safe to rerun, and self-heals rows archived by an earlier, less precise
// version of this script), records the run in archive.signal_archive_batches,
// and verifies exact identity coverage before marking the batch VERIFIED.
// Never issues a DELETE against Neon — that is Phase B, a separate,
// explicitly gated step this script does not perform.
//
// Usage:
//   node scripts/archive-signals-to-local-postgres.mjs
//   node scripts/archive-signals-to-local-postgres.mjs --finish <batch_id>
//     Skips freeze/stream and re-runs verification only, against an existing
//     manifest row whose data was already fully streamed (e.g. recovering
//     from a run that streamed everything correctly but crashed/hung before
//     reaching verification).

import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";

const BATCH_SIZE = 25000;
const SOURCE_RELATION = "neon.public.signals";
const SOURCE_TAG = "neon:public.signals";

function loadEnvVar(name) {
  const raw = readFileSync(new URL("../.env", import.meta.url), "utf8");
  const lines = raw.split(/\r?\n/);
  let val;
  for (const line of lines) {
    const m = line.match(new RegExp(`^${name}=(.*)$`));
    if (!m) continue;
    let v = m[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    val = v;
  }
  if (!val) throw new Error(`${name} not found in .env`);
  return val;
}

function csvField(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(fields) {
  return fields.map(csvField).join(",") + "\n";
}

// Single-quote-escape a value for safe embedding as a SQL string literal in
// psql script text (defense in depth alongside the structural safety of
// these particular fields — timestamps/uuids/counts we generate ourselves).
function sqlLit(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// neon() returns timestamptz columns as JS Date objects (millisecond
// precision only) unless the query casts to text itself. Every query in this
// file that produces a value used for pagination cursors, watermark bounds,
// or digests casts created_at to text in SQL so full Postgres precision
// (microseconds) survives the round trip; toIso() is then a no-op for those
// and only matters for any stray Date that slips through.
function toIso(v) {
  return v instanceof Date ? v.toISOString() : v;
}

function safeIdPart(s) {
  return String(s).replace(/[^a-zA-Z0-9]+/g, "-");
}

function runPsql(archiveUrl, script) {
  const res = spawnSync(
    "psql",
    [archiveUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-f", "-"],
    { input: script, encoding: "utf8", maxBuffer: 1024 * 1024 * 64 },
  );
  if (res.status !== 0) {
    throw new Error(`psql failed (exit ${res.status}):\n${res.stderr}\n--- script head ---\n${script.slice(0, 2000)}`);
  }
  return res.stdout;
}

// Epoch-ms digest line for one row. Both sides of the digest (Neon source,
// local archive) compute this with the SAME SQL expression
// (round(extract(epoch from ts) * 1000)) so rounding is bit-for-bit
// consistent — a client-side Date.parse truncates sub-millisecond digits
// instead of rounding them, which silently disagreed with the SQL side on
// roughly half of all rows and would have made verification spuriously fail.
function digestOfPairs(text) {
  const sorted = text
    .split("\n")
    .filter(Boolean)
    .sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

async function fetchSourceDigestAndCount(sql, watermarkCreatedAt, watermarkId) {
  let cursorCreatedAt = null;
  let cursorId = null;
  let count = 0;
  const parts = [];
  for (;;) {
    const rows = cursorCreatedAt === null
      ? await sql`
          SELECT id, created_at::text AS created_at,
                 round(extract(epoch FROM created_at) * 1000)::bigint AS epoch_ms
          FROM signals
          WHERE (created_at, id) <= (${watermarkCreatedAt}::timestamptz, ${watermarkId}::uuid)
          ORDER BY created_at, id
          LIMIT ${BATCH_SIZE}
        `
      : await sql`
          SELECT id, created_at::text AS created_at,
                 round(extract(epoch FROM created_at) * 1000)::bigint AS epoch_ms
          FROM signals
          WHERE (created_at, id) > (${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)
            AND (created_at, id) <= (${watermarkCreatedAt}::timestamptz, ${watermarkId}::uuid)
          ORDER BY created_at, id
          LIMIT ${BATCH_SIZE}
        `;
    if (rows.length === 0) break;
    for (const r of rows) parts.push(`${r.id}|${r.epoch_ms}`);
    count += rows.length;
    const last = rows[rows.length - 1];
    cursorCreatedAt = last.created_at;
    cursorId = last.id;
  }
  return { digest: digestOfPairs(parts.join("\n")), count };
}

function fetchArchiveDigestCountAndBounds(archiveUrl, watermarkCreatedAt) {
  const out = runPsql(
    archiveUrl,
    `
SELECT count(*) FROM archive.signals WHERE source = ${sqlLit(SOURCE_TAG)} AND received_at <= ${sqlLit(watermarkCreatedAt)}::timestamptz;
SELECT round(extract(epoch FROM min(received_at)) * 1000)::bigint, round(extract(epoch FROM max(received_at)) * 1000)::bigint
FROM archive.signals WHERE source = ${sqlLit(SOURCE_TAG)} AND received_at <= ${sqlLit(watermarkCreatedAt)}::timestamptz;
SELECT count(*) - count(DISTINCT signal_id) FROM archive.signals WHERE source = ${sqlLit(SOURCE_TAG)} AND received_at <= ${sqlLit(watermarkCreatedAt)}::timestamptz;
SELECT string_agg(signal_id || '|' || round(extract(epoch FROM received_at) * 1000)::text, chr(10) ORDER BY signal_id)
FROM archive.signals WHERE source = ${sqlLit(SOURCE_TAG)} AND received_at <= ${sqlLit(watermarkCreatedAt)}::timestamptz;
`,
  );
  const lines = out.split("\n");
  const archivedCount = parseInt(lines[0], 10);
  const [minEpoch, maxEpoch] = lines[1].split("|").map((v) => parseInt(v, 10));
  const dupInArchive = parseInt(lines[2], 10);
  const digest = digestOfPairs(lines.slice(3).join("\n"));
  return { archivedCount, minEpoch, maxEpoch, dupInArchive, digest };
}

async function verifyAndFinalize({
  sql, archiveUrl, batchId, watermarkCreatedAt, watermarkId, sourceCount,
  sourceMin, sourceMax, sourceMinEpoch, sourceMaxEpoch, stagedTotal,
}) {
  console.log("[phase-a] computing source digest from Neon (id+epoch pairs only, light query)...");
  const source = await fetchSourceDigestAndCount(sql, watermarkCreatedAt, watermarkId);

  console.log("[phase-a] computing archive digest/bounds from local Postgres...");
  const archive = fetchArchiveDigestCountAndBounds(archiveUrl, watermarkCreatedAt);

  const missingCount = sourceCount - archive.archivedCount;
  // sourceMinEpoch/sourceMaxEpoch arrive pre-computed via SQL round(extract(epoch...)*1000)
  // from the caller — never derived via JS Date.parse, which truncates instead of
  // rounding sub-millisecond digits and would spuriously disagree with the SQL
  // side on any boundary row whose microsecond remainder is >= 500.
  const timeBoundsMatch = archive.minEpoch === sourceMinEpoch && archive.maxEpoch === sourceMaxEpoch;
  const archiveMinIso = new Date(archive.minEpoch).toISOString();
  const archiveMaxIso = new Date(archive.maxEpoch).toISOString();
  const sourceRecountMatches = source.count === sourceCount;
  const stagedMatches = stagedTotal === null || stagedTotal === sourceCount;
  const countsMatch = sourceRecountMatches && stagedMatches && archive.archivedCount === sourceCount;
  const digestsMatch = source.digest === archive.digest;
  const verified = countsMatch && missingCount === 0 && archive.dupInArchive === 0 && timeBoundsMatch && digestsMatch;

  runPsql(
    archiveUrl,
    `
UPDATE archive.signal_archive_batches
SET archived_count = ${archive.archivedCount},
    missing_count = ${missingCount},
    duplicate_count = ${archive.dupInArchive},
    source_digest_sha256 = ${sqlLit(source.digest)},
    archive_digest_sha256 = ${sqlLit(archive.digest)},
    verification_status = ${sqlLit(verified ? "VERIFIED" : "FAILED")},
    verified_at = now()
WHERE batch_id = ${sqlLit(batchId)};
`,
  );

  console.log("");
  console.log("=== Phase A report ===");
  console.log(`batch_id                 ${batchId}`);
  console.log(`source_snapshot_count    ${sourceCount}`);
  console.log(`source_recount           ${source.count} (matches: ${sourceRecountMatches})`);
  if (stagedTotal !== null) console.log(`staged_total (read)      ${stagedTotal}`);
  console.log(`archived_count (total)   ${archive.archivedCount}`);
  console.log(`missing_count            ${missingCount}`);
  console.log(`duplicate_count_in_archive ${archive.dupInArchive}`);
  console.log(`source time bounds       ${sourceMin} .. ${sourceMax}`);
  console.log(`archive time bounds      ${archiveMinIso} .. ${archiveMaxIso}`);
  console.log(`time bounds match        ${timeBoundsMatch}`);
  console.log(`source digest            ${source.digest}`);
  console.log(`archive digest           ${archive.digest}`);
  console.log(`digests match            ${digestsMatch}`);
  console.log(`verification_status      ${verified ? "VERIFIED" : "FAILED"}`);
  console.log("");

  if (!verified) {
    console.error("[phase-a] VERIFICATION FAILED — do not proceed to backup or purge.");
    process.exitCode = 1;
  } else {
    console.log(`[phase-a] VERIFIED. batch_id=${batchId}`);
  }
}

async function main() {
  const neonUrl = loadEnvVar("DATABASE_URL");
  const archiveUrl = loadEnvVar("MOSTAR_ARCHIVE_DATABASE_URL");
  const sql = neon(neonUrl);

  const finishIdx = process.argv.indexOf("--finish");
  if (finishIdx !== -1) {
    const batchId = process.argv[finishIdx + 1];
    if (!batchId) throw new Error("--finish requires a batch_id argument");
    console.log(`[phase-a] finish mode: re-verifying existing batch ${batchId} (no re-streaming)`);
    const row = runPsql(
      archiveUrl,
      `SELECT watermark_created_at::text, watermark_id, source_snapshot_count,
              source_min_created_at::text, source_max_created_at::text,
              round(extract(epoch FROM source_min_created_at) * 1000)::bigint,
              round(extract(epoch FROM source_max_created_at) * 1000)::bigint
       FROM archive.signal_archive_batches WHERE batch_id = ${sqlLit(batchId)};`,
    ).trim();
    if (!row) throw new Error(`No manifest row found for batch_id ${batchId}`);
    const [watermarkCreatedAt, watermarkId, sourceCountStr, sourceMin, sourceMax, sourceMinEpochStr, sourceMaxEpochStr] = row.split("|");
    await verifyAndFinalize({
      sql,
      archiveUrl,
      batchId,
      watermarkCreatedAt,
      watermarkId,
      sourceCount: parseInt(sourceCountStr, 10),
      sourceMin,
      sourceMax,
      sourceMinEpoch: parseInt(sourceMinEpochStr, 10),
      sourceMaxEpoch: parseInt(sourceMaxEpochStr, 10),
      stagedTotal: null,
    });
    return;
  }

  console.log("[phase-a] freezing watermark on Neon public.signals...");
  const [wm] = await sql`SELECT id, created_at::text AS created_at FROM signals ORDER BY created_at DESC, id DESC LIMIT 1`;
  if (!wm) {
    console.log("[phase-a] signals table is empty on Neon — nothing to archive.");
    return;
  }
  const watermarkId = wm.id;
  const watermarkCreatedAt = toIso(wm.created_at);

  const [stats] = await sql`
    SELECT count(*)::bigint AS cnt, min(created_at)::text AS min_ts, max(created_at)::text AS max_ts,
           round(extract(epoch FROM min(created_at)) * 1000)::bigint AS min_epoch,
           round(extract(epoch FROM max(created_at)) * 1000)::bigint AS max_epoch
    FROM signals
    WHERE (created_at, id) <= (${watermarkCreatedAt}::timestamptz, ${watermarkId}::uuid)
  `;
  const sourceCount = Number(stats.cnt);
  const sourceMin = toIso(stats.min_ts);
  const sourceMax = toIso(stats.max_ts);
  const sourceMinEpoch = Number(stats.min_epoch);
  const sourceMaxEpoch = Number(stats.max_epoch);

  console.log(`[phase-a] watermark: created_at<=${watermarkCreatedAt} id<=${watermarkId}`);
  console.log(`[phase-a] frozen source count: ${sourceCount} (min ${sourceMin}, max ${sourceMax})`);

  const batchId = `signals-${safeIdPart(watermarkCreatedAt)}-${randomUUID().slice(0, 8)}`;

  runPsql(
    archiveUrl,
    `
INSERT INTO archive.signal_archive_batches
  (batch_id, source_relation, destination_relation, snapshot_started_at,
   watermark_created_at, watermark_id, source_snapshot_count,
   source_min_created_at, source_max_created_at, verification_status, started_at)
VALUES
  (${sqlLit(batchId)}, ${sqlLit(SOURCE_RELATION)}, 'archive.signals', now(),
   ${sqlLit(watermarkCreatedAt)}::timestamptz, ${sqlLit(watermarkId)}, ${sourceCount},
   ${sqlLit(sourceMin)}::timestamptz, ${sqlLit(sourceMax)}::timestamptz, 'ARCHIVING', now());
`,
  );
  console.log(`[phase-a] manifest batch ${batchId} recorded (status=ARCHIVING)`);

  let cursorCreatedAt = null;
  let cursorId = null;
  let stagedTotal = 0;
  let insertedTotal = 0;
  let updatedTotal = 0;

  // created_at is selected as created_at::text everywhere in this loop
  // (cursor, CSV, payload) — see toIso()'s doc comment above for why: the
  // driver's native Date deserialization only carries millisecond precision,
  // which previously made the ">" pagination bound non-monotonic (and the
  // loop non-terminating) whenever multiple rows shared a millisecond.
  for (;;) {
    const rows = cursorCreatedAt === null
      ? await sql`
          SELECT id, user_id, symbol, side, price, confidence, conf_bucket, agents, regime, hour_utc, executed,
                 created_at::text AS created_at
          FROM signals
          WHERE (created_at, id) <= (${watermarkCreatedAt}::timestamptz, ${watermarkId}::uuid)
          ORDER BY created_at, id
          LIMIT ${BATCH_SIZE}
        `
      : await sql`
          SELECT id, user_id, symbol, side, price, confidence, conf_bucket, agents, regime, hour_utc, executed,
                 created_at::text AS created_at
          FROM signals
          WHERE (created_at, id) > (${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)
            AND (created_at, id) <= (${watermarkCreatedAt}::timestamptz, ${watermarkId}::uuid)
          ORDER BY created_at, id
          LIMIT ${BATCH_SIZE}
        `;

    if (rows.length === 0) break;

    let csv = "";
    for (const r of rows) {
      const payload = {
        id: r.id,
        user_id: r.user_id,
        symbol: r.symbol,
        side: r.side,
        price: r.price,
        confidence: r.confidence,
        conf_bucket: r.conf_bucket,
        agents: r.agents,
        regime: r.regime,
        hour_utc: r.hour_utc,
        executed: r.executed,
        created_at: r.created_at,
      };
      const metadata = { symbol: r.symbol, side: r.side, user_id: r.user_id, executed: r.executed };
      csv += csvRow([r.id, SOURCE_TAG, JSON.stringify(payload), r.created_at, JSON.stringify(metadata)]);
    }

    const script = `
BEGIN;
CREATE TEMP TABLE _batch_staging (
  signal_id text, source text, payload jsonb, received_at timestamptz, metadata jsonb
) ON COMMIT DROP;
\\copy _batch_staging (signal_id, source, payload, received_at, metadata) FROM STDIN WITH (FORMAT csv)
${csv}\\.
WITH ins AS (
  INSERT INTO archive.signals (signal_id, source, payload, received_at, archived_at, metadata)
  SELECT signal_id, source, payload, received_at, now(), metadata FROM _batch_staging
  ON CONFLICT (signal_id) DO UPDATE
    SET payload = EXCLUDED.payload, received_at = EXCLUDED.received_at, metadata = EXCLUDED.metadata
    WHERE archive.signals.received_at IS DISTINCT FROM EXCLUDED.received_at
       OR archive.signals.payload IS DISTINCT FROM EXCLUDED.payload
  RETURNING (xmax = 0) AS was_insert
)
SELECT count(*) FILTER (WHERE was_insert), count(*) FILTER (WHERE NOT was_insert) FROM ins;
COMMIT;
`;
    const out = runPsql(archiveUrl, script);
    const lastLine = out.trim().split("\n").filter(Boolean).pop();
    const [insertedThisBatch, updatedThisBatch] = lastLine.split("|").map((v) => parseInt(v, 10));
    stagedTotal += rows.length;
    insertedTotal += insertedThisBatch;
    updatedTotal += updatedThisBatch;

    const last = rows[rows.length - 1];
    cursorCreatedAt = last.created_at;
    cursorId = last.id;

    console.log(
      `[phase-a] batch: +${rows.length} read, +${insertedThisBatch} inserted, +${updatedThisBatch} updated ` +
      `(running ${stagedTotal}/${sourceCount}, ${insertedTotal} inserted, ${updatedTotal} updated)`,
    );

    if (stagedTotal > sourceCount + BATCH_SIZE) {
      throw new Error(
        `Pagination read ${stagedTotal} rows against a frozen count of ${sourceCount} — aborting instead of looping ` +
        `(this guards against exactly the non-terminating-cursor bug fixed in this script).`,
      );
    }
  }

  console.log("[phase-a] streaming complete, verifying...");
  await verifyAndFinalize({
    sql,
    archiveUrl,
    batchId,
    watermarkCreatedAt,
    watermarkId,
    sourceCount,
    sourceMin,
    sourceMax,
    sourceMinEpoch,
    sourceMaxEpoch,
    stagedTotal,
  });
}

main().catch((err) => {
  console.error("[phase-a] fatal:", err);
  process.exitCode = 1;
});
