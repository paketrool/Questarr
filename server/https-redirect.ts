import { isIP } from "node:net";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Returns `hostname` when it is safe to put in a redirect URL: a plain DNS
 * name or IPv4 address, or a bracketed IPv6 literal (as Express reports it,
 * brackets kept). Anything else falls back to "localhost", so a crafted Host
 * header can never turn the redirect into an open redirect.
 */
export function safeRedirectHostname(hostname: string): string {
  if (/^[a-zA-Z0-9.-]+$/.test(hostname)) return hostname;
  const bracketed = /^\[([^\]]+)\]$/.exec(hostname);
  if (bracketed?.[1] && isIP(bracketed[1]) === 6) return hostname;
  return "localhost";
}

/**
 * Redirects plain-HTTP requests to the HTTPS listener once one is running.
 *
 * The HTTPS server only starts after its certificates are validated, well after
 * every route (and the SPA catch-all) is registered, so this middleware has to
 * be installed up front and switched on later: `getHttpsPort` returns the port
 * to redirect to, or null while redirection is off.
 */
export function createHttpsRedirect(getHttpsPort: () => number | null): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const httpsPort = getHttpsPort();
    if (httpsPort === null || req.secure || req.path === "/api/health") {
      return next();
    }
    const safeHostname = safeRedirectHostname(req.hostname);
    // originalUrl keeps the base path (QUESTARR_BASE_PATH) and the query string.
    return res.redirect(`https://${safeHostname}:${httpsPort}${req.originalUrl}`);
  };
}
