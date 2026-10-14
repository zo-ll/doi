// Generated pages are untrusted, and any website the user opens can send requests to
// 127.0.0.1. These checks keep both away from the API.

/** doi listens only on the loopback interface. */
export const HOSTNAME = "127.0.0.1";

/**
 * The Content-Security-Policy of design pages. A page loads its own files from the doi
 * server, styles and fonts from Google Fonts, and nothing else: no fetch, no frames, no forms.
 */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** Headers for every file of a design page. */
export const PAGE_HEADERS = { "content-security-policy": PAGE_CSP, "x-content-type-options": "nosniff" } as const;

const fail = (status: number, message: string) => Response.json({ error: message }, { status });

/**
 * Checks a request before a route sees it. Returns an error response, or null.
 * - The Host must be the loopback address and the port of this server. Another name that
 *   points to 127.0.0.1 (DNS rebinding) gets 403.
 * - A request that changes data must come from the app itself: a browser sends `Origin`, and
 *   another site or a sandboxed page ("null") gets 403. Tools without `Origin` (curl) pass.
 * - A body must be JSON. A cross-site form or a "simple" fetch cannot send that without a
 *   preflight, which doi does not answer.
 */
export function checkRequest(req: Request, port: number): Response | null {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(req.headers.get("host") ?? "")) return fail(403, "This host name is not allowed.");

  const url = new URL(req.url);
  // /mcp is the MCP endpoint (#54): the checks apply to every method, so no web page can call its
  // tools or hold a stream open. Other paths: only requests that change data.
  const mcp = url.pathname === "/mcp";
  const changes = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (!mcp && (!url.pathname.startsWith("/api/") || !changes)) return null;

  const origin = req.headers.get("origin");
  if (origin !== null && !hosts.some((h) => origin === `http://${h}`)) return fail(403, "Requests from other sites are not allowed.");

  // A body counts unless its length is given as 0.
  const length = req.headers.get("content-length");
  const hasBody = length !== null ? Number(length) > 0 : req.body !== null;
  const type = req.headers.get("content-type") ?? "";
  if (hasBody && !/^application\/json\b/i.test(type)) return fail(415, "The body must be application/json.");
  return null;
}
