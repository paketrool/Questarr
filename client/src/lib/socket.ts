import { io, type Socket } from "socket.io-client";
import { getSocketPath } from "@/lib/app-path";
import { getBearerToken } from "@/lib/queryClient";

let sharedSocket: Socket | null = null;

export function getSocket(): Socket {
  if (!sharedSocket) {
    sharedSocket = io({
      path: getSocketPath(),
      // The server authenticates the handshake. Browsers send the httpOnly
      // auth cookie on their own; a session still on the legacy bearer token
      // has no cookie, so it hands the token over here instead.
      auth: (cb) => {
        const token = getBearerToken();
        cb(token ? { token } : {});
      },
    });
  } else if (!sharedSocket.active) {
    // A rejected handshake (e.g. the socket was opened with an expired
    // session) is not retried automatically, so reconnect once a signed-in
    // view asks for the socket again.
    sharedSocket.connect();
  }

  return sharedSocket;
}

/** Close the shared socket, e.g. on logout, so it stops receiving events. */
export function disconnectSocket(): void {
  sharedSocket?.disconnect();
}
