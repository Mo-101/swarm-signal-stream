// Neon-backed local auth — the canonical sign-in path. Supabase auth still
// works and is mirrored here automatically (same user id, so all data stays
// attached), but when the Supabase project is unreachable this module keeps
// the app and the runner fully operational against Neon alone.
//
// Server-only (node:crypto + Neon client). Dynamically import from server
// handlers, same convention as db/edge-store.server.ts.
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { getDatabaseUrl, getNeonSql } from "@/lib/db/neon";

const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const TOKEN_ISSUER = "alpha-swarm-local";

export interface LocalSession {
  userId: string;
  email: string;
  token: string;
  expiresAt: number; // epoch ms
}

// ── Secret & password hashing ────────────────────────────────────────────

function authSecret(): string {
  // Prefer an explicit secret; otherwise derive one deterministically from
  // DATABASE_URL (already a secret) so tokens survive restarts with no
  // extra configuration.
  const explicit = process.env.LOCAL_AUTH_SECRET;
  if (explicit) return explicit;
  const dbUrl = getDatabaseUrl();
  return createHash("sha256").update(`alpha-swarm-local-auth:${dbUrl}`).digest("hex");
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// ── Minimal HS256 JWT (no extra dependency) ──────────────────────────────

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

function signToken(userId: string, email: string): { token: string; expiresAt: number } {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + TOKEN_TTL_SECONDS;
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ sub: userId, email, iat: now, exp, iss: TOKEN_ISSUER }));
  const sig = createHmac("sha256", authSecret()).update(`${header}.${payload}`).digest("base64url");
  return { token: `${header}.${payload}.${sig}`, expiresAt: exp * 1000 };
}

/** Verify a locally-issued token. Returns null (never throws) if it isn't one of ours or is expired. */
export function verifyLocalToken(token: string): { userId: string; email: string } | null {
  try {
    const [header, payload, sig] = token.split(".");
    if (!header || !payload || !sig) return null;
    const expected = createHmac("sha256", authSecret())
      .update(`${header}.${payload}`)
      .digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (claims.iss !== TOKEN_ISSUER || typeof claims.sub !== "string") return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return null;
    return { userId: claims.sub, email: typeof claims.email === "string" ? claims.email : "" };
  } catch {
    return null;
  }
}

// ── User store (Neon) ────────────────────────────────────────────────────

let tableEnsured = false;
async function ensureUsersTable() {
  if (tableEnsured) return;
  const sql = getNeonSql();
  await sql`CREATE TABLE IF NOT EXISTS app_users (
    id uuid PRIMARY KEY,
    email text UNIQUE NOT NULL,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`;
  tableEnsured = true;
}

/**
 * When the bot's env credentials sign in for the first time with no
 * app_users record, adopt the user id that already owns the existing data
 * (runner_state / paper_accounts) instead of minting a new one — this is
 * what maps the historical Supabase user id onto local auth automatically.
 */
async function adoptExistingOwnerId(): Promise<string> {
  const sql = getNeonSql();
  const rows = await sql`
    SELECT user_id FROM runner_state
    UNION SELECT user_id FROM paper_accounts`;
  if (rows.length === 1) return rows[0].user_id as string;
  return (rows[0]?.user_id as string | undefined) ?? randomUUID();
}

export async function signInLocal(email: string, password: string): Promise<LocalSession> {
  await ensureUsersTable();
  const sql = getNeonSql();
  const normalized = email.trim().toLowerCase();
  type UserRow = { id: string; email: string; password_hash: string };
  const rows =
    await sql`SELECT id, email, password_hash FROM app_users WHERE email = ${normalized}`;
  let user = rows[0] as UserRow | undefined;

  if (!user) {
    // First-run bootstrap: only the env-configured bot credentials may claim
    // the pre-existing data owner id. Anything else must sign up explicitly.
    const envEmail = process.env.RUNNER_EMAIL?.trim().toLowerCase();
    const envPassword = process.env.RUNNER_PASSWORD;
    if (envEmail && envPassword && normalized === envEmail && password === envPassword) {
      const id = await adoptExistingOwnerId();
      const inserted = await sql`
        INSERT INTO app_users (id, email, password_hash)
        VALUES (${id}, ${normalized}, ${hashPassword(password)})
        ON CONFLICT (email) DO UPDATE SET updated_at = now()
        RETURNING id, email, password_hash`;
      user = inserted[0] as UserRow;
      console.log(`[local-auth] bootstrapped bot user ${normalized} as ${user!.id}`);
    } else {
      throw new Error("Invalid email or password (local auth).");
    }
  } else if (!verifyPassword(password, user.password_hash)) {
    throw new Error("Invalid email or password (local auth).");
  }

  const { token, expiresAt } = signToken(user!.id, user!.email);
  return { userId: user!.id, email: user!.email, token, expiresAt };
}

export async function signUpLocal(email: string, password: string): Promise<LocalSession> {
  await ensureUsersTable();
  if (password.length < 6) throw new Error("Password must be at least 6 characters.");
  const sql = getNeonSql();
  const normalized = email.trim().toLowerCase();
  const rows = await sql`
    INSERT INTO app_users (id, email, password_hash)
    VALUES (${randomUUID()}, ${normalized}, ${hashPassword(password)})
    ON CONFLICT (email) DO NOTHING
    RETURNING id, email`;
  if (!rows[0]) throw new Error("An account with this email already exists.");
  const user = rows[0] as { id: string; email: string };
  const { token, expiresAt } = signToken(user.id, user.email);
  return { userId: user.id, email: user.email, token, expiresAt };
}

/**
 * Mirror a successful Supabase sign-in into app_users — same user id — so the
 * account keeps working if Supabase later becomes unreachable. Never throws.
 */
export async function mirrorSupabaseUser(
  userId: string,
  email: string,
  password: string,
): Promise<void> {
  try {
    await ensureUsersTable();
    const sql = getNeonSql();
    const normalized = email.trim().toLowerCase();
    await sql`
      INSERT INTO app_users (id, email, password_hash)
      VALUES (${userId}, ${normalized}, ${hashPassword(password)})
      ON CONFLICT (email) DO UPDATE SET
        password_hash = EXCLUDED.password_hash, updated_at = now()`;
  } catch (e) {
    console.error("[local-auth] mirrorSupabaseUser failed:", e instanceof Error ? e.message : e);
  }
}
