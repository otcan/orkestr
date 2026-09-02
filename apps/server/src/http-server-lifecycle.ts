import type { Server } from "node:http";
import type { Duplex } from "node:stream";

export function trackUpgradedSockets(server: Server): () => void {
  const sockets = new Set<Duplex>();

  const track = (_request: unknown, socket: Duplex) => {
    sockets.add(socket);
    // A browser can reset an upgraded connection while a server is shutting
    // down. Treat that peer disconnect as connection lifecycle, not as an
    // uncaught process error.
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  };

  server.on("upgrade", track);

  return () => {
    server.off("upgrade", track);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };
}
