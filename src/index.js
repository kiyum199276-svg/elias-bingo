
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("ELIAS BINGO SERVER ONLINE");
    }

    if (url.pathname.startsWith("/room/")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("WebSocket connection required", {
          status: 426
        });
      }

      const roomId = url.pathname.split("/")[2];

      if (!roomId) {
        return new Response("Missing Game ID", { status: 400 });
      }

      const id = env.BINGO_ROOMS.idFromName(roomId);
      const room = env.BINGO_ROOMS.get(id);

      return room.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  }
};

export class BingoRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);

    server.send(JSON.stringify({
      type: "CONNECTED",
      message: "Connected to ELIAS BINGO room"
    }));

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  webSocketMessage(sender, message) {
    const response = JSON.stringify({
      type: "ROOM_MESSAGE",
      data: String(message)
    });

    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== sender) {
        socket.send(response);
      }
    }
  }

  webSocketClose(ws) {
    // Cloudflare manages the closed connection.
  }

  webSocketError(ws) {
    // Cloudflare manages the connection error.
  }
}
