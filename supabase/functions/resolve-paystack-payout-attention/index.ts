import { isServiceRoleRequest, optionsResponse } from "../_shared/auth.ts";

// Retired legacy operator path. Manual payout recovery must go through the
// authenticated platform-admin endpoint, which persists an immutable audit.
Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({
    error: "This legacy recovery endpoint is retired. Use the authenticated Admin Console payout reconciliation workflow.",
  }), {
    status: 410,
    headers: { "content-type": "application/json" },
  });
});
