// Client-side storage for the Neon-local session. Mirrors the shape the
// server functions return; kept in localStorage alongside (not instead of)
// any Supabase session.
export interface StoredLocalSession {
  userId: string;
  email: string;
  token: string;
  expiresAt: number; // epoch ms
}

const KEY = "alpha_swarm_local_session";

export function getLocalSession(): StoredLocalSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as StoredLocalSession;
    if (!session.token || typeof session.expiresAt !== "number") return null;
    if (session.expiresAt <= Date.now()) {
      localStorage.removeItem(KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export function setLocalSession(session: StoredLocalSession): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEY, JSON.stringify(session));
}

export function clearLocalSession(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(KEY);
}
