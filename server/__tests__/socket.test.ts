import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server as HttpServer } from "http";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

const VALID_TOKEN = "valid-session-token";

vi.mock("../auth.js", () => ({
  verifyAuthToken: vi.fn(async (token: string) =>
    token === VALID_TOKEN ? { id: "user-1", username: "admin" } : undefined
  ),
}));

import { setupSocketIO, getIO, notifyUser } from "../socket.js";
import { logEmitter } from "../log-events.js";

async function listen(server: HttpServer): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

/** Resolves with the connect_error message, or "connected" if the handshake was accepted. */
function handshakeOutcome(socket: ClientSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.on("connect", () => resolve("connected"));
    socket.on("connect_error", (err) => resolve(err.message));
  });
}

describe("socket.ts", () => {
  let httpServer: HttpServer;
  let port: number;
  let clientSocket: ClientSocket | undefined;

  afterEach(async () => {
    if (clientSocket) {
      clientSocket.disconnect();
      clientSocket = undefined;
    }
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it("throws when getIO is called before setup", async () => {
    vi.resetModules();
    const freshSocket = await import("../socket.js");
    expect(() => freshSocket.getIO()).toThrow("Socket.IO not initialized!");
  });

  it("initializes the socket server and accepts client connections", async () => {
    httpServer = createServer();
    const server = setupSocketIO(httpServer);
    expect(server).toBeDefined();

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });
    const address = httpServer.address();
    port = typeof address === "object" && address ? address.port : 0;

    await new Promise<void>((resolve, reject) => {
      clientSocket = ioClient(`http://localhost:${port}`, {
        transports: ["websocket"],
        reconnection: false,
        auth: { token: VALID_TOKEN },
      });
      clientSocket.on("connect", () => resolve());
      clientSocket.on("connect_error", (err) => reject(err));
    });

    expect(clientSocket?.connected).toBe(true);
    expect(getIO()).toBe(server);
  });

  it("broadcasts logEmitter lines to connected clients as logLine events", async () => {
    httpServer = createServer();
    setupSocketIO(httpServer);

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });
    const address = httpServer.address();
    port = typeof address === "object" && address ? address.port : 0;

    await new Promise<void>((resolve, reject) => {
      clientSocket = ioClient(`http://localhost:${port}`, {
        transports: ["websocket"],
        reconnection: false,
        auth: { token: VALID_TOKEN },
      });
      clientSocket.on("connect", () => resolve());
      clientSocket.on("connect_error", (err) => reject(err));
    });

    const received = new Promise<string>((resolve) => {
      clientSocket?.once("logLine", (line: string) => resolve(line));
    });

    logEmitter.emit("line", "hello from log emitter");

    const line = await received;
    expect(line).toBe("hello from log emitter");
  });

  it("notifyUser emits an event through the shared io instance", async () => {
    httpServer = createServer();
    setupSocketIO(httpServer);

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });
    const address = httpServer.address();
    port = typeof address === "object" && address ? address.port : 0;

    await new Promise<void>((resolve, reject) => {
      clientSocket = ioClient(`http://localhost:${port}`, {
        transports: ["websocket"],
        reconnection: false,
        auth: { token: VALID_TOKEN },
      });
      clientSocket.on("connect", () => resolve());
      clientSocket.on("connect_error", (err) => reject(err));
    });

    const received = new Promise<{ message: string }>((resolve) => {
      clientSocket?.once("customEvent", (payload: { message: string }) => resolve(payload));
    });

    notifyUser("customEvent", { message: "hi" });

    const payload = await received;
    expect(payload.message).toBe("hi");
  });

  it("rejects a handshake that carries no credential", async () => {
    httpServer = createServer();
    setupSocketIO(httpServer);
    port = await listen(httpServer);

    clientSocket = ioClient(`http://localhost:${port}`, {
      transports: ["websocket"],
      reconnection: false,
    });

    expect(await handshakeOutcome(clientSocket)).toBe("Authentication required");
  });

  it("rejects a handshake with an invalid token", async () => {
    httpServer = createServer();
    setupSocketIO(httpServer);
    port = await listen(httpServer);

    clientSocket = ioClient(`http://localhost:${port}`, {
      transports: ["websocket"],
      reconnection: false,
      auth: { token: "forged" },
    });

    expect(await handshakeOutcome(clientSocket)).toBe("Authentication required");
  });

  it("accepts the httpOnly auth cookie a browser sends with the handshake", async () => {
    httpServer = createServer();
    setupSocketIO(httpServer);
    port = await listen(httpServer);

    clientSocket = ioClient(`http://localhost:${port}`, {
      transports: ["websocket"],
      reconnection: false,
      extraHeaders: { Cookie: `questarr_csrf=abc; questarr_auth=${VALID_TOKEN}` },
    });

    expect(await handshakeOutcome(clientSocket)).toBe("connected");
  });

  it.each([
    { label: "same-origin", origin: (port: number) => `http://localhost:${port}`, ok: true },
    { label: "no Origin (non-browser client)", origin: () => undefined, ok: true },
    { label: "another origin on the same site", origin: () => "http://localhost:1", ok: false },
    { label: "a malformed Origin", origin: () => "not a url", ok: false },
  ])("with the cookie, a handshake from $label is accepted=$ok", async ({ origin, ok }) => {
    httpServer = createServer();
    setupSocketIO(httpServer);
    port = await listen(httpServer);
    const originHeader = origin(port);

    clientSocket = ioClient(`http://localhost:${port}`, {
      transports: ["websocket"],
      reconnection: false,
      extraHeaders: {
        Cookie: `questarr_auth=${VALID_TOKEN}`,
        ...(originHeader ? { Origin: originHeader } : {}),
      },
    });

    expect(await handshakeOutcome(clientSocket)).toBe(ok ? "connected" : "Authentication required");
  });

  it("with the cookie, accepts the public origin a reverse proxy forwards as X-Forwarded-Host", async () => {
    httpServer = createServer();
    setupSocketIO(httpServer);
    port = await listen(httpServer);

    clientSocket = ioClient(`http://localhost:${port}`, {
      transports: ["websocket"],
      reconnection: false,
      extraHeaders: {
        Cookie: `questarr_auth=${VALID_TOKEN}`,
        Origin: "https://questarr.example.com",
        "X-Forwarded-Host": "questarr.example.com",
      },
    });

    expect(await handshakeOutcome(clientSocket)).toBe("connected");
  });

  it("accepts an explicit bearer token whatever the Origin, since it isn't ambient", async () => {
    httpServer = createServer();
    setupSocketIO(httpServer);
    port = await listen(httpServer);

    clientSocket = ioClient(`http://localhost:${port}`, {
      transports: ["websocket"],
      reconnection: false,
      auth: { token: VALID_TOKEN },
      extraHeaders: { Origin: "http://elsewhere.example" },
    });

    expect(await handshakeOutcome(clientSocket)).toBe("connected");
  });

  it("does not stream log lines to a rejected client", async () => {
    httpServer = createServer();
    setupSocketIO(httpServer);
    port = await listen(httpServer);

    clientSocket = ioClient(`http://localhost:${port}`, {
      transports: ["websocket"],
      reconnection: false,
    });
    const received: string[] = [];
    clientSocket.on("logLine", (line: string) => received.push(line));
    await handshakeOutcome(clientSocket);

    logEmitter.emit("line", "secret log line");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toEqual([]);
  });

  it("disconnecting a client does not throw", async () => {
    httpServer = createServer();
    setupSocketIO(httpServer);

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });
    const address = httpServer.address();
    port = typeof address === "object" && address ? address.port : 0;

    await new Promise<void>((resolve, reject) => {
      clientSocket = ioClient(`http://localhost:${port}`, {
        transports: ["websocket"],
        reconnection: false,
        auth: { token: VALID_TOKEN },
      });
      clientSocket.on("connect", () => resolve());
      clientSocket.on("connect_error", (err) => reject(err));
    });

    clientSocket?.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(clientSocket?.connected).toBe(false);
  });
});
