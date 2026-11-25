export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response("ELIAS BINGO SERVER ONLINE");
    if (url.pathname.startsWith("/room/")) {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("WebSocket connection required", { status: 426 });
      const roomId = decodeURIComponent(url.pathname.slice("/room/".length));
      if (!roomId) return new Response("Missing Game ID", { status: 400 });
      const id = env.BINGO_ROOMS.idFromName(roomId);
      return env.BINGO_ROOMS.get(id).fetch(request);
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
      this.adminToken = await this.ctx.storage.get("adminToken") || null;
      if (!this.roomState) {
        this.roomState = { gameId: null, status: "waiting", calledNumbers: [], pattern: "", patternName: "", patternMode: "auto", depositConfig: {enabled:false,amount:0,currency:"ETB",method:"Telebirr",account:""}, deposits: {}, players: {}, cards: {}, updatedAt: Date.now() };
        await this.ctx.storage.put("roomState", this.roomState);
      }
      if (!this.roomState.players) this.roomState.players = {};
      if (!this.roomState.cards) this.roomState.cards = {};
      if (!this.roomState.claims) this.roomState.claims = {};
      if (!this.roomState.withdrawals) this.roomState.withdrawals = {};
    });
  }

  async fetch(request) {
    await this.ready;
    const gameId = decodeURIComponent(new URL(request.url).pathname.slice("/room/".length));
    if (!this.roomState.gameId) { this.roomState.gameId = gameId; await this.saveState(); }
    if (this.roomState.gameId !== gameId) return new Response("Game ID mismatch", { status: 404 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "ROOM_STATE", data: this.roomState }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(sender, message) {
    await this.ready;
    let data;
    try { data = JSON.parse(String(message)); }
    catch { sender.send(JSON.stringify({ type: "ERROR", message: "Invalid JSON" })); return; }
    if (data.type === "GET_STATE") {
      sender.send(JSON.stringify({ type: "ROOM_STATE", data: this.roomState })); return;
    }
    if (data.type === "PING") { sender.send(JSON.stringify({ type: "PONG" })); return; }
    if (data.type === "ADMIN_AUTH") {
      const token = String(data.token || "");
      if (token.length < 24) { sender.send(JSON.stringify({type:"ERROR",message:"Invalid admin key"})); return; }
      if (!this.adminToken) {
        this.adminToken = token;
        await this.ctx.storage.put("adminToken", token);
      }
      if (this.adminToken !== token) { sender.send(JSON.stringify({type:"ERROR",message:"Admin key rejected"})); return; }
      this.ctx.getWebSockets().forEach(ws => { if (ws === sender) { try { ws.serializeAttachment({role:"admin"}); } catch {} } });
      sender.send(JSON.stringify({type:"ADMIN_AUTH_OK"}));
      return;
    }
    if (data.type === "ADMIN_SYNC_STATE") {
      let role = null;
      try { role = sender.deserializeAttachment()?.role; } catch {}
      if (role !== "admin") { sender.send(JSON.stringify({type:"ERROR",message:"Admin authorization required"})); return; }
      const nums = Array.isArray(data.calledNumbers) ? data.calledNumbers.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 75).slice(-75) : [];
      this.roomState.calledNumbers = [...new Set(nums)];
      this.roomState.pattern = typeof data.pattern === "string" ? data.pattern.slice(0, 32) : "";
      this.roomState.patternMode = data.patternMode === "manual" ? "manual" : "auto";
      this.roomState.patternName = typeof data.patternName === "string" ? data.patternName.slice(0, 80) : "";
      await this.saveState();
      this.broadcast({type:"ROOM_STATE",data:this.roomState});
      return;
    }
    if (data.type === "ADMIN_SET_DEPOSIT_CONFIG") {
      let role = null;
      try { role = sender.deserializeAttachment()?.role; } catch {}
      if (role !== "admin") { sender.send(JSON.stringify({type:"ERROR",message:"Admin authorization required"})); return; }
      const enabled = data.enabled === true;
      const amount = Number(data.amount);
      const currency = String(data.currency || "ETB").slice(0, 8);
      const method = ["Telebirr","CBE Birr","E-Birr"].includes(data.method) ? data.method : "Telebirr";
      const account = String(data.account || "").trim().slice(0, 100);
      if (enabled && (!Number.isFinite(amount) || amount <= 0 || !account)) {
        sender.send(JSON.stringify({type:"ERROR",message:"Enter a valid deposit amount and payment account"})); return;
      }
      this.roomState.depositConfig = {enabled,amount:enabled?amount:0,currency,method,account};
      await this.saveState();
      this.broadcast({type:"ROOM_STATE",data:this.roomState});
      sender.send(JSON.stringify({type:"DEPOSIT_CONFIG_SAVED"}));
      return;
    }
    if (data.type === "DEPOSIT_REQUEST") {
      const playerId = String(data.playerId || "").slice(0, 100);
      const player = this.roomState.players[playerId];
      const config = this.roomState.depositConfig || {enabled:false};
      const reference = String(data.reference || "").trim().slice(0, 100);
      if (!player || !config.enabled) { sender.send(JSON.stringify({type:"ERROR",message:"Deposit is not enabled or player is not connected"})); return; }
      if (reference.length < 3) { sender.send(JSON.stringify({type:"ERROR",message:"Enter a valid payment reference"})); return; }
      const duplicate = Object.values(this.roomState.deposits || {}).some(d => d && d.reference === reference && d.status !== "rejected");
      if (duplicate) { sender.send(JSON.stringify({type:"ERROR",message:"This payment reference has already been submitted"})); return; }
      const id = crypto.randomUUID();
      this.roomState.deposits[id] = {id,playerId,playerName:player.name,reference,amount:config.amount,currency:config.currency,method:config.method,status:"pending",createdAt:Date.now()};
      await this.saveState();
      this.broadcast({type:"ROOM_STATE",data:this.roomState});
      sender.send(JSON.stringify({type:"DEPOSIT_REQUEST_RECEIVED",depositId:id}));
      return;
    }
    if (data.type === "ADMIN_REVIEW_DEPOSIT") {
      let role = null;
      try { role = sender.deserializeAttachment()?.role; } catch {}
      if (role !== "admin") { sender.send(JSON.stringify({type:"ERROR",message:"Admin authorization required"})); return; }
      const id = String(data.depositId || "");
      const deposit = this.roomState.deposits && this.roomState.deposits[id];
      const decision = data.decision === "approved" ? "approved" : data.decision === "rejected" ? "rejected" : "";
      if (!deposit || deposit.status !== "pending" || !decision) { sender.send(JSON.stringify({type:"ERROR",message:"Deposit request is not pending"})); return; }
      deposit.status = decision;
      deposit.reviewedAt = Date.now();
      const player = this.roomState.players[deposit.playerId];
      if (player && decision === "approved") player.depositApproved = true;
      if (player && decision === "rejected") player.depositApproved = false;
      await this.saveState();
      this.broadcast({type:"ROOM_STATE",data:this.roomState});
      return;
    }
    if (data.type === "ADMIN_APPROVE_CARD" || data.type === "ADMIN_REJECT_CARD") {
      let role = null;
      try { role = sender.deserializeAttachment()?.role; } catch {}
      if (role !== "admin") { sender.send(JSON.stringify({type:"ERROR",message:"Admin authorization required"})); return; }
      const playerId = String(data.playerId || "").slice(0, 100);
      const cardNumber = Number(data.cardNumber);
      const player = this.roomState.players[playerId];
      const owner = this.roomState.cards[String(cardNumber)];
      if (data.type === "ADMIN_APPROVE_CARD" && this.roomState.depositConfig?.enabled && !player?.depositApproved) {
        sender.send(JSON.stringify({type:"ERROR",message:"Approve the player's deposit before approving cards"})); return;
      }
      if (!player || !Number.isInteger(cardNumber) || !Array.isArray(player.pendingCards) || !player.pendingCards.includes(cardNumber) || !owner || owner.playerId !== playerId || owner.status !== "pending") {
        sender.send(JSON.stringify({type:"ERROR",message:"This card request is no longer pending"})); return;
      }
      player.pendingCards = player.pendingCards.filter(n => n !== cardNumber);
      if (data.type === "ADMIN_APPROVE_CARD") {
        player.approvedCards = [...new Set([...(player.approvedCards || []), cardNumber])].sort((a,b)=>a-b);
        owner.status = "approved";
      } else {
        this.roomState.cards[String(cardNumber)] = null;
      }
      player.selectedCards = [...(player.approvedCards || [])];
      await this.saveState();
      this.broadcast({type:"ROOM_STATE",data:this.roomState});
      return;
    }
    if (data.type === "BINGO_CLAIM") {
      const playerId = String(data.playerId || "").slice(0, 100);
      const cardNumber = Number(data.cardNumber);
      const player = this.roomState.players[playerId];
      if (!player || !Array.isArray(player.approvedCards) || !player.approvedCards.includes(cardNumber)) {
        sender.send(JSON.stringify({type:"ERROR",message:"This card has not been approved by the Admin"})); return;
      }
      const cardValues = Array.isArray(data.cardValues) && data.cardValues.length === 25 && data.cardValues.every(v => v === "FREE" || (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 75)) ? data.cardValues : null;
      if (!this.roomState.claims) this.roomState.claims = {};
      const claimId = crypto.randomUUID();
      this.roomState.claims[claimId] = {claimId,playerId,playerName:player.name,cardNumber,status:"pending",claimedAt:Date.now()};
      await this.saveState();
      this.broadcast({type:"BINGO_CLAIM",claimId,playerId,playerName:player.name,cardNumber,cardValues,calledNumbers:this.roomState.calledNumbers,patternName:this.roomState.patternName,pattern:this.roomState.pattern,patternMode:this.roomState.patternMode,claimedAt:Date.now()});
      sender.send(JSON.stringify({type:"BINGO_CLAIM_RECEIVED",cardNumber,claimId}));
      return;
    }
    if (data.type === "ADMIN_CONFIRM_WINNER") {
      let role = null; try { role = sender.deserializeAttachment()?.role; } catch {}
      if (role !== "admin") { sender.send(JSON.stringify({type:"ERROR",message:"Admin authorization required"})); return; }
      const claimId = String(data.claimId || ""), claim = this.roomState.claims && this.roomState.claims[claimId], amount = Number(data.amount);
      if (!claim || claim.status !== "pending" || !Number.isFinite(amount) || amount <= 0) { sender.send(JSON.stringify({type:"ERROR",message:"Pending claim or valid prize amount not found"})); return; }
      const player = this.roomState.players[claim.playerId];
      if (!player) { sender.send(JSON.stringify({type:"ERROR",message:"Winner is no longer in this game"})); return; }
      player.walletBalance = (Number(player.walletBalance)||0) + amount;
      claim.status = "confirmed"; claim.prizeAmount = amount; claim.currency = String(data.currency||"ETB").slice(0,8); claim.confirmedAt = Date.now();
      await this.saveState(); this.broadcast({type:"ROOM_STATE",data:this.roomState}); return;
    }
    if (data.type === "PLAYER_WITHDRAWAL_REQUEST") {
      const playerId = String(data.playerId||"").slice(0,100), player = this.roomState.players[playerId], amount = Number(data.amount);
      const method = ["Telebirr","CBE Birr","E-Birr"].includes(data.method) ? data.method : "";
      const account = String(data.account||"").trim().slice(0,100);
      if (!player || !Number.isFinite(amount) || amount <= 0 || !method || account.length < 3) { sender.send(JSON.stringify({type:"ERROR",message:"Enter a valid amount, payment method, and account number"})); return; }
      const balance = Number(player.walletBalance)||0;
      if (amount > balance) { sender.send(JSON.stringify({type:"ERROR",message:"Insufficient balance. Your available balance is "+balance.toFixed(2)+" ETB."})); return; }
      if (!this.roomState.withdrawals) this.roomState.withdrawals = {};
      const id = crypto.randomUUID(); player.walletBalance = balance - amount;
      this.roomState.withdrawals[id] = {id,playerId,playerName:player.name,amount,currency:String(data.currency||"ETB").slice(0,8),method,account,status:"pending",createdAt:Date.now()};
      await this.saveState(); this.broadcast({type:"ROOM_STATE",data:this.roomState}); sender.send(JSON.stringify({type:"WITHDRAWAL_REQUEST_RECEIVED",withdrawalId:id})); return;
    }
    if (data.type === "ADMIN_REVIEW_WITHDRAWAL") {
      let role = null; try { role = sender.deserializeAttachment()?.role; } catch {}
      if (role !== "admin") { sender.send(JSON.stringify({type:"ERROR",message:"Admin authorization required"})); return; }
      const id = String(data.withdrawalId||""), item = this.roomState.withdrawals && this.roomState.withdrawals[id];
      const decision = data.decision === "approved" ? "approved" : data.decision === "rejected" ? "rejected" : "";
      if (!item || item.status !== "pending" || !decision) { sender.send(JSON.stringify({type:"ERROR",message:"Withdrawal request is not pending"})); return; }
      item.status = decision; item.reviewedAt = Date.now();
      if (decision === "rejected") { const player = this.roomState.players[item.playerId]; if (player) player.walletBalance = (Number(player.walletBalance)||0) + item.amount; }
      await this.saveState(); this.broadcast({type:"ROOM_STATE",data:this.roomState}); return;
    }
    if (data.type === "ADMIN_MARK_WITHDRAWAL_PAID") {
      let role = null; try { role = sender.deserializeAttachment()?.role; } catch {}
      if (role !== "admin") { sender.send(JSON.stringify({type:"ERROR",message:"Admin authorization required"})); return; }
      const item = this.roomState.withdrawals && this.roomState.withdrawals[String(data.withdrawalId||"")];
      if (!item || item.status !== "approved") { sender.send(JSON.stringify({type:"ERROR",message:"Only approved withdrawals can be marked paid"})); return; }
      item.status = "paid"; item.paidAt = Date.now(); await this.saveState(); this.broadcast({type:"ROOM_STATE",data:this.roomState}); return;
    }
    if (data.type === "JOIN_PLAYER") {
      const playerId = String(data.playerId || "").slice(0, 100);
      const name = String(data.name || "").trim().slice(0, 60);
      const rawCards = Array.isArray(data.cards) ? data.cards : [data.card];
      const cards = [...new Set(rawCards.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 300))].slice(0, 300);
      if (!playerId || !name || cards.length === 0) {
        sender.send(JSON.stringify({ type: "ERROR", message: "Valid player ID, name, and at least one card are required" })); return;
      }
      const previous = this.roomState.players[playerId] || {};
      if (!this.roomState.deposits) this.roomState.deposits = {};
      if (!this.roomState.depositConfig) this.roomState.depositConfig = {enabled:false,amount:0,currency:"ETB",method:"Telebirr",account:""};
      if (!this.roomState.claims) this.roomState.claims = {};
      if (!this.roomState.withdrawals) this.roomState.withdrawals = {};
      const approvedCards = Array.isArray(previous.approvedCards) ? previous.approvedCards : [];
      const pendingCards = Array.isArray(previous.pendingCards) ? previous.pendingCards : [];
      const unavailable = [];
      for (const cardNumber of cards) {
        if (approvedCards.includes(cardNumber) || pendingCards.includes(cardNumber)) continue;
        const key = String(cardNumber), owner = this.roomState.cards[key];
        if (owner && owner.playerId !== playerId) { unavailable.push(cardNumber); continue; }
        this.roomState.cards[key] = { playerId, status: "pending" };
        pendingCards.push(cardNumber);
      }
      this.roomState.players[playerId] = { ...previous, name, walletBalance: Number(previous.walletBalance)||0, approvedCards, pendingCards: [...new Set(pendingCards)].sort((a,b)=>a-b), selectedCards: approvedCards, selectedCard: approvedCards[0] || null, status: "joined", joinedAt: previous.joinedAt || Date.now() };
      await this.saveState();
      sender.send(JSON.stringify({type:"CARD_REQUEST_RESULT",pendingCards:this.roomState.players[playerId].pendingCards,approvedCards,unavailable}));
      this.broadcast({ type: "ROOM_STATE", data: this.roomState });
      return;
    }
    sender.send(JSON.stringify({ type: "ERROR", message: "Unknown message type" }));
  }

  async saveState() { this.roomState.updatedAt = Date.now(); await this.ctx.storage.put("roomState", this.roomState); }
  broadcast(data) {
    const message = JSON.stringify(data);
    for (const socket of this.ctx.getWebSockets()) { try { socket.send(message); } catch {} }
  }
  webSocketClose() {}
  webSocketError() {}
}
