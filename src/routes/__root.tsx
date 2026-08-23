import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import { Toaster } from "@/components/ui/sonner";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="max-w-md text-center border border-border bg-card/80 p-8 rounded-xl shadow-xl backdrop-blur-sm">
        <img
          src="/alpha-sword-logo.png"
          alt="Alpha Swarm"
          className="mx-auto h-28 w-28 rounded-2xl object-cover border border-primary/30 p-1.5 bg-black/40 shadow-xl"
        />
        <h1 className="mt-4 text-6xl font-black tracking-tight text-foreground">404</h1>
        <h2 className="mt-2 text-lg font-semibold text-foreground">Route Not Found</h2>
        <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
          The requested page or endpoint doesn&apos;t exist. Jump back into the Swarm Terminal or head to the home dashboard.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            to="/dashboard"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition hover:opacity-90 shadow"
          >
            Open Terminal
          </Link>
          <Link
            to="/auth"
            className="inline-flex items-center justify-center rounded-md border border-border bg-secondary px-4 py-2 text-xs font-medium text-secondary-foreground transition hover:bg-muted"
          >
            Sign In / Demo
          </Link>
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md border border-border px-4 py-2 text-xs font-medium text-foreground transition hover:bg-muted"
          >
            Home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Alpha Swarm — Live USDT-M Perp Terminal" },
      {
        name: "description",
        content:
          "Autonomous AI trading swarm streaming every Bybit USDT-M perpetual future with paper execution and real-time edge calibration.",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "icon", href: "/alpha-sword-logo.png", type: "image/png" },
      { rel: "shortcut icon", href: "/alpha-sword-logo.png", type: "image/png" },
      { rel: "apple-touch-icon", href: "/alpha-sword-logo.png" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <Outlet />
      <Toaster position="bottom-right" closeButton richColors />
    </QueryClientProvider>
  );
}
