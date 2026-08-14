import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
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

    try {
      const { data, error } = await supabase.auth.getUser();
      if (!error && data?.user) {
        return { user: data.user };
      }
    } catch {
      // Ignore network / storage parse errors
    }

    throw redirect({ to: "/auth" });
  },
  component: () => <Outlet />,
});

