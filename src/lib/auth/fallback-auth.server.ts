// Cloud-auth fallback for environments where Neon (DATABASE_URL) is not
// configured — e.g. the Lovable preview sandbox. Neon-local auth stays
// canonical whenever DATABASE_URL is present; this path only keeps the sign-in
// form usable instead of failing with "Missing DATABASE_URL".
import { createClient } from "@supabase/supabase-js";
import type { LocalSession } from "./local-auth.server";

function client() {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key) {
    throw new Error(
      "Sign-in is unavailable here: neither Neon (DATABASE_URL) nor the cloud backend is configured.",
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function toSession(data: {
  user: { id: string; email?: string | null } | null;
  session: { access_token: string; expires_at?: number } | null;
}): LocalSession {
  if (!data.session || !data.user) {
    throw new Error("Check your email to confirm this account, then sign in.");
  }
  return {
    userId: data.user.id,
    email: data.user.email ?? "",
    token: data.session.access_token,
    expiresAt: (data.session.expires_at ?? Math.floor(Date.now() / 1000) + 3600) * 1000,
  };
}

export async function signInFallback(email: string, password: string): Promise<LocalSession> {
  const { data, error } = await client().auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return toSession(data);
}

export async function signUpFallback(email: string, password: string): Promise<LocalSession> {
  const { data, error } = await client().auth.signUp({ email, password });
  if (error) throw new Error(error.message);
  return toSession(data);
}
