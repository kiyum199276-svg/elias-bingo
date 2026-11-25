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

    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      this.roomState = await this.ctx.storage.get("roomState");

      if (!this.roomState) {
        this.roomState = {
          gameId: null,
          status: "waiting",
          calledNumbers: [],
          players: {},
          cards: {},
          updatedAt: Date.now()
        };

        await this.ctx.storage.put("roomState", this.roomState);
      }
    });
  }

  async fetch(request) {
    await this.ready;

    const url = new URL(request.url);
    const gameId = url.pathname.split("/")[2];

    if (!this.roomState.gameId) {
      this.roomState.gameId = gameId;
      await this.saveState();
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);

    server.send(JSON.stringify({
      type: "ROOM_STATE",
      data: this.roomState
    }));

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async webSocketMessage(sender, message) {
    await this.ready;

    const text = String(message);

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      this.broadcast({
        type: "ROOM_MESSAGE",
        data: text
      }, sender);

      return;
    }

    if (data.type === "GET_STATE") {
      sender.send(JSON.stringify({
        type: "ROOM_STATE",
        data: this.roomState
      }));

      return;
    }

    if (data.type === "PING") {
      sender.send(JSON.stringify({
        type: "PONG"
      }));

      return;
    }

    sender.send(JSON.stringify({
      type: "ERROR",
      message: "Unknown message type"
    }));
  }

  async saveState() {
    this.roomState.updatedAt = Date.now();
    await this.ctx.storage.put("roomState", this.roomState);
  }

  broadcast(data, sender) {
    const message = JSON.stringify(data);

    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== sender) {
        try {
          socket.send(message);
        } catch {
          // Ignore sockets that have disconnected.
        }
      }
    }
  }

  webSocketClose(ws) {
    // The saved room state remains available after disconnection.
  }

  webSocketError(ws) {
    // Cloudflare manages the closed connection.
  }
}
