// Server functions for Neon-local auth. localSignIn/localSignUp are the
// canonical credential path; mirrorCredentials copies a successful Supabase
// login into Neon (same user id) so the account survives Supabase outages.
import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "./auth-middleware";

interface Credentials {
  email: string;
  password: string;
}

function validateCredentials(input: Credentials): Credentials {
  if (!input || typeof input.email !== "string" || typeof input.password !== "string") {
    throw new Error("Email and password are required.");
  }
  if (!input.email.includes("@")) throw new Error("Invalid email address.");
  return { email: input.email, password: input.password };
}

export const localSignIn = createServerFn({ method: "POST" })
  .inputValidator(validateCredentials)
  .handler(async ({ data }) => {
    const { neonEnabled } = await import("@/lib/db/neon");
    if (!neonEnabled()) {
      const { signInFallback } = await import("./fallback-auth.server");
      return signInFallback(data.email, data.password);
    }
    const { signInLocal } = await import("./local-auth.server");
    return signInLocal(data.email, data.password);
  });

export const localSignUp = createServerFn({ method: "POST" })
  .inputValidator(validateCredentials)
  .handler(async ({ data }) => {
    const { neonEnabled } = await import("@/lib/db/neon");
    if (!neonEnabled()) {
      const { signUpFallback } = await import("./fallback-auth.server");
      return signUpFallback(data.email, data.password);
    }
    const { signUpLocal } = await import("./local-auth.server");
    return signUpLocal(data.email, data.password);
  });


// Requires a valid (Supabase) session — the mirrored id comes from the
// verified token, never from client input.
export const mirrorCredentials = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(validateCredentials)
  .handler(async ({ data, context }) => {
    const { mirrorSupabaseUser } = await import("./local-auth.server");
    await mirrorSupabaseUser(context.userId, data.email, data.password);
    return { ok: true };
  });
