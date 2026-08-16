import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getLocalSession } from "@/lib/auth/local-session";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    // Neon-local session is canonical.
    const local = getLocalSession();
    if (local) {
      return {
        user: {
          id: local.userId,
          email: local.email,
          user_metadata: { role: "local_operator" },
        },
      };
    }

    if (typeof window !== "undefined") {
      const isGuest = localStorage.getItem("alpha_swarm_guest") === "true";
      if (isGuest) {
        return {
          user: {
            id: "guest-operator",
            email: "guest.operator@alphaswarm.internal",
            user_metadata: { role: "guest_operator" },
          },
        };
      }
    }

    throw redirect({ to: "/auth" });
  },
  component: () => <Outlet />,
});
