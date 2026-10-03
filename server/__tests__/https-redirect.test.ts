import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createHttpsRedirect, safeRedirectHostname } from "../https-redirect.js";

function buildApp(getPort: () => number | null) {
  const app = express();
  app.use(createHttpsRedirect(getPort));
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/games", (_req, res) => res.json([]));
  // Stands in for the SPA fallback, which used to swallow requests before the
  // redirect (registered last) could see them.
  app.use((_req, res) => res.status(200).send("<html>spa</html>"));
  return app;
}

describe("createHttpsRedirect", () => {
  it("does nothing while no HTTPS port is set", async () => {
    const res = await request(buildApp(() => null)).get("/library");
    expect(res.status).toBe(200);
    expect(res.text).toContain("spa");
  });

  it("redirects plain HTTP to the HTTPS port, keeping the path and query", async () => {
    const res = await request(buildApp(() => 5443))
      .get("/library?sort=title")
      .set("Host", "questarr.lan:5000");
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("https://questarr.lan:5443/library?sort=title");
  });

  it("redirects API calls too, but not the health check", async () => {
    const app = buildApp(() => 5443);
    expect((await request(app).get("/api/games")).status).toBe(302);
    const health = await request(app).get("/api/health");
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: "ok" });
  });

  it("falls back to localhost for a Host header that isn't a plain hostname", async () => {
    const res = await request(buildApp(() => 5443))
      .get("/")
      .set("Host", "evil.example/@attacker");
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toMatch(/^https:\/\/localhost:5443\//);
  });

  it("keeps a bracketed IPv6 host, brackets included", async () => {
    const res = await request(buildApp(() => 5443))
      .get("/library")
      .set("Host", "[2001:db8::10]:5000");
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("https://[2001:db8::10]:5443/library");
  });

  it("keeps the base path when the app is mounted under QUESTARR_BASE_PATH", async () => {
    const root = express();
    root.use(
      "/questarr",
      buildApp(() => 5443)
    );
    const res = await request(root).get("/questarr/library").set("Host", "nas:5000");
    expect(res.headers["location"]).toBe("https://nas:5443/questarr/library");
  });

  it("lets requests that already arrived over HTTPS through", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use(createHttpsRedirect(() => 5443));
    app.get("/library", (_req, res) => res.send("ok"));
    const res = await request(app).get("/library").set("X-Forwarded-Proto", "https");
    expect(res.status).toBe(200);
  });
});

describe("safeRedirectHostname", () => {
  it("accepts DNS names, IPv4 and bracketed IPv6 literals", () => {
    expect(safeRedirectHostname("questarr.lan")).toBe("questarr.lan");
    expect(safeRedirectHostname("192.168.1.10")).toBe("192.168.1.10");
    expect(safeRedirectHostname("[::1]")).toBe("[::1]");
  });

  it("falls back to localhost for anything else", () => {
    expect(safeRedirectHostname("[not-an-ip]")).toBe("localhost");
    expect(safeRedirectHostname("[1.2.3.4]")).toBe("localhost");
    expect(safeRedirectHostname("a]b")).toBe("localhost");
    expect(safeRedirectHostname("evil.example/@attacker")).toBe("localhost");
  });
});
