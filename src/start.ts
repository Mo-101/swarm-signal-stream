import { createStart, createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { renderErrorPage } from "./lib/error-page";
import { attachAuth } from "@/lib/auth/auth-attacher";

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }

    // Server-function RPCs must never receive the HTML error page — the client
    // expects a serialized error (guest mode relies on catching "Unauthorized").
    let isServerFn = false;
    try {
      isServerFn = new URL(getRequest().url).pathname.startsWith("/_serverFn");
    } catch {
      isServerFn = false;
    }
    if (isServerFn) {
      const message = error instanceof Error ? error.message : "Server function failed";
      const unauthorized = /unauthor/i.test(message);
      if (!unauthorized) console.error(error);
      return new Response(JSON.stringify({ error: true, message }), {
        status: unauthorized ? 401 : 500,
        headers: { "content-type": "application/json" },
      });
    }

    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});


export const startInstance = createStart(() => ({
  functionMiddleware: [attachAuth],
  requestMiddleware: [errorMiddleware],
}));
