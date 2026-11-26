
const PASSWORD_ITERATIONS = 100000;
function normalizePhone(value) {
  let phone = String(value || "").replace(/[\s()+.-]/g, "");
  if (/^251[79]\d{8}$/.test(phone)) phone = "0" + phone.slice(3);
  if (/^0[79]\d{8}$/.test(phone)) return phone;
  return "";
}
function randomHex(bytes = 32) {
  const data = new Uint8Array(bytes); crypto.getRandomValues(data);
  return Array.from(data, b => b.toString(16).padStart(2, "0")).join("");
}
async function hashPassword(password, saltHex, iterations = PASSWORD_ITERATIONS) {
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map(x => parseInt(x, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const safeIterations = Math.min(100000, Math.max(1, Number(iterations) || PASSWORD_ITERATIONS));
  const bits = await crypto.subtle.deriveBits({name:"PBKDF2", hash:"SHA-256", salt, iterations:safeIterations}, key, 256);
  return Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2, "0")).join("");
}


const OWNER_PHONE = "0977320235";
const OWNER_ORIGIN = "https://elias-bingo.pages.dev";
function b64url(bytes) {
  let binary = ""; for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
function fromB64url(value) {
  const raw = atob(value.replace(/-/g,"+").replace(/_/g,"/"));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
async function ownerToken(payload, secret) {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const sig = await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(body));
  return body+"."+b64url(new Uint8Array(sig));
}
async function verifyOwnerToken(token, secret) {
  try {
    const [body,signature] = String(token||"").split(".");
    if (!body || !signature) return false;
    const key = await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
    const valid = await crypto.subtle.verify("HMAC",key,fromB64url(signature),new TextEncoder().encode(body));
    if (!valid) return false;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    return payload.phone===OWNER_PHONE && payload.exp>Date.now();
  } catch { return false; }
}
function ownerJson(data,status=200) {
  return new Response(status===204?null:JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Access-Control-Allow-Origin":OWNER_ORIGIN,"Access-Control-Allow-Headers":"Authorization, Content-Type","Access-Control-Allow-Methods":"GET, POST, OPTIONS","Vary":"Origin"}});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/owner/") || request.method === "OPTIONS") {
      if (request.method === "OPTIONS") return ownerJson({},204);
      if (url.pathname === "/owner/login" && request.method === "POST") {
        if (!env.OWNER_PASSWORD || !env.OWNER_SESSION_SECRET) return ownerJson({error:"Owner login is not configured yet. Set OWNER_PASSWORD and OWNER_SESSION_SECRET in Cloudflare Worker secrets."},503);
        let body={}; try { body=await request.json(); } catch {}
        const phone=normalizePhone(body.phone), password=String(body.password||"");
        if (phone!==OWNER_PHONE || password!==env.OWNER_PASSWORD) return ownerJson({error:"Phone number or password is incorrect."},401);
        const token=await ownerToken({phone:OWNER_PHONE,exp:Date.now()+8*60*60*1000},env.OWNER_SESSION_SECRET);
        return ownerJson({token,expiresIn:28800});
      }
      const auth=(request.headers.get("Authorization")||"").replace(/^Bearer\s+/i,"");
      if (!env.OWNER_SESSION_SECRET || !await verifyOwnerToken(auth,env.OWNER_SESSION_SECRET)) return ownerJson({error:"Owner login required."},401);
      if (url.pathname === "/owner/games" && request.method === "GET") {
        const id=env.OWNER_REGISTRY.idFromName("global");
        const response=await env.OWNER_REGISTRY.get(id).fetch("https://registry/list");
        return new Response(response.body,{status:response.status,headers:{"Content-Type":"application/json; charset=utf-8","Access-Control-Allow-Origin":OWNER_ORIGIN,"Access-Control-Allow-Headers":"Authorization, Content-Type","Access-Control-Allow-Methods":"GET, POST, OPTIONS","Vary":"Origin"}});
      }
      return ownerJson({error:"Owner endpoint not found."},404);
    }
    if (url.pathname === "/") return new Response("ELIAS BINGO SERVER ONLINE");
    if (url.pathname.startsWith("/room/")) {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("WebSocket connection required", { status: 426 });
      const roomId = decodeURIComponent(url.pathname.slice("/room/".length));
      if (!roomId) return new Response("Missing Game ID", { status: 400 });
      const registryId=env.OWNER_REGISTRY.idFromName("global");
      await env.OWNER_REGISTRY.get(registryId).fetch("https://registry/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({gameId:roomId})});
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
      if (!Number.isFinite(Number(this.roomState.cardPrice))) this.roomState.cardPrice = 0;
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
    const accountRequiredActions = new Set(["PLAYER_PURCHASE_CARDS","DEPOSIT_REQUEST","BINGO_CLAIM","PLAYER_WITHDRAWAL_REQUEST"]);
    if (accountRequiredActions.has(data.type)) {
      let session = null; try { session = sender.deserializeAttachment(); } catch {}
      if (session?.role !== "player" || !session.phone) { sender.send(JSON.stringify({type:"ERROR",message:"Please log in with your phone number and password first."})); return; }
      const account = await this.ctx.storage.get("playerAccount:" + session.phone);
      if (!account || account.playerId !== session.playerId) { sender.send(JSON.stringify({type:"ERROR",message:"Player account session is no longer valid. Please log in again."})); return; }
      if (account.mustChangePassword) { sender.send(JSON.stringify({type:"ERROR",message:"Your password was reset. Change your password before continuing."})); return; }
    }
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
    if (data.type === "ADMIN_START_NEW_ROUND") {
      let role = null;
      try { role = sender.deserializeAttachment()?.role; } catch {}
      if (role !== "admin") { sender.send(JSON.stringify({type:"ERROR",message:"Admin authorization required"})); return; }
      this.roomState.gameRound = (Number(this.roomState.gameRound) || 0) + 1;
      this.roomState.calledNumbers = [];
      this.roomState.cards = {};
      for (const player of Object.values(this.roomState.players || {})) {
        player.approvedCards = [];
        player.pendingCards = [];
        player.selectedCards = [];
        player.selectedCard = null;
      }
      this.roomState.claims = {};
      await this.saveState();
      this.broadcast({type:"ROOM_STATE",data:this.roomState});
      sender.send(JSON.stringify({type:"NEW_ROUND_STARTED",gameRound:this.roomState.gameRound}));
      return;
    }
    if (data.type === "ADMIN_SET_CARD_PRICE") {
      let role = null; try { role = sender.deserializeAttachment()?.role; } catch {}
      if (role !== "admin") { sender.send(JSON.stringify({type:"ERROR",message:"Admin authorization required"})); return; }
      const price = Number(data.price);
      if (!Number.isFinite(price) || price <= 0 || price > 100000000) { sender.send(JSON.stringify({type:"ERROR",message:"Enter a valid price per card"})); return; }
      this.roomState.cardPrice = price; await this.saveState(); this.broadcast({type:"ROOM_STATE",data:this.roomState});
      sender.send(JSON.stringify({type:"CARD_PRICE_SAVED",price})); return;
    }
    if (data.type === "PLAYER_PURCHASE_CARDS") {
      let identity = null; try { identity = sender.deserializeAttachment(); } catch {}
      if (identity?.role !== "player" || !identity.playerId) { sender.send(JSON.stringify({type:"ERROR",message:"Reconnect to the game before purchasing"})); return; }
      const playerId = identity.playerId, player = this.roomState.players[playerId];
      const requested=Array.isArray(data.cards)?[...new Set(data.cards.map(Number).filter(n=>Number.isInteger(n)&&n>=1&&n<=300))]:[];
      const price=Number(this.roomState.cardPrice);
      if(!player||!requested.length){sender.send(JSON.stringify({type:"ERROR",message:"Connect to the game and select at least one card"}));return;}
      if(!Number.isFinite(price)||price<=0){sender.send(JSON.stringify({type:"ERROR",message:"The Admin has not set a card price yet"}));return;}
      if(this.roomState.depositConfig?.enabled&&!player.depositApproved){sender.send(JSON.stringify({type:"ERROR",message:"Your deposit must be approved before buying cards"}));return;}
      const already=new Set(player.approvedCards||[]),cards=requested.filter(n=>!already.has(n));
      if(!cards.length){sender.send(JSON.stringify({type:"ERROR",message:"You already own all selected cards"}));return;}
      const unavailable=cards.filter(n=>{const owner=this.roomState.cards[String(n)];if(!owner)return false;const ownerId=typeof owner==="string"?owner:owner.playerId;return ownerId!==playerId;});
      if(unavailable.length){sender.send(JSON.stringify({type:"ERROR",message:"These cards are unavailable: "+unavailable.join(", ")}));return;}
      const total=price*cards.length,balance=Number(player.walletBalance)||0;
      if(balance<total){sender.send(JSON.stringify({type:"ERROR",message:"Insufficient balance. Need "+total.toFixed(2)+" ETB; available "+balance.toFixed(2)+" ETB."}));return;}
      player.walletBalance=balance-total;player.approvedCards=[...new Set([...(player.approvedCards||[]),...cards])].sort((x,y)=>x-y);
      player.pendingCards=(player.pendingCards||[]).filter(n=>!cards.includes(n));player.selectedCards=[...player.approvedCards];player.selectedCard=player.approvedCards[0]||null;
      if(!Array.isArray(player.cardPurchases))player.cardPurchases=[];
      player.cardPurchases.push({cards,pricePerCard:price,total,currency:"ETB",createdAt:Date.now()});
      for(const n of cards)this.roomState.cards[String(n)]={playerId,status:"approved"};
      await this.saveState();this.broadcast({type:"ROOM_STATE",data:this.roomState});
      sender.send(JSON.stringify({type:"CARD_PURCHASE_SUCCESS",cards,total,balance:player.walletBalance}));return;
    }
    if (data.type === "ADMIN_SYNC_STATE") {
      let role = null;
      try { role = sender.deserializeAttachment()?.role; } catch {}
      if (role !== "admin") { sender.send(JSON.stringify({type:"ERROR",message:"Admin authorization required"})); return; }
      const nums = Array.isArray(data.calledNumbers) ? data.calledNumbers.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 75).slice(-75) : [];
      const previousCalledNumbers = Array.isArray(this.roomState.calledNumbers) ? this.roomState.calledNumbers : [];
      const startingNextRound = previousCalledNumbers.length > 0 && nums.length === 0;
      if (startingNextRound) {
        this.roomState.gameRound = (Number(this.roomState.gameRound) || 0) + 1;
        // Card reservations belong to one round only. Release every card
        // and clear each player's round-specific card lists for the next round.
        this.roomState.cards = {};
        for (const player of Object.values(this.roomState.players || {})) {
          player.approvedCards = [];
          player.pendingCards = [];
          player.selectedCards = [];
          player.selectedCard = null;
        }
        this.roomState.claims = {};
      }
      if (!Number.isFinite(Number(this.roomState.gameRound))) this.roomState.gameRound = 0;
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
      const currency = "ETB";
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
      let identity = null; try { identity = sender.deserializeAttachment(); } catch {}
      if (identity?.role !== "player" || !identity.playerId) { sender.send(JSON.stringify({type:"ERROR",message:"Reconnect to the game before submitting a deposit"})); return; }
      const playerId = identity.playerId;
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
      if (player && decision === "approved") { player.depositApproved = true; player.walletBalance = (Number(player.walletBalance)||0) + Number(deposit.amount||0); deposit.creditedToWallet = true; }
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
      let identity = null; try { identity = sender.deserializeAttachment(); } catch {}
      if (identity?.role !== "player" || !identity.playerId) { sender.send(JSON.stringify({type:"ERROR",message:"Reconnect to the game before claiming Bingo"})); return; }
      const playerId = identity.playerId;
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
      let identity = null; try { identity = sender.deserializeAttachment(); } catch {}
      if (identity?.role !== "player" || !identity.playerId) { sender.send(JSON.stringify({type:"ERROR",message:"Reconnect to the game before requesting a withdrawal"})); return; }
      const playerId = identity.playerId, player = this.roomState.players[playerId], amount = Number(data.amount);
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

    if (data.type === "PLAYER_REGISTER") {
      let currentIdentity = null; try { currentIdentity = sender.deserializeAttachment(); } catch {}
      if (currentIdentity?.role === "admin") { sender.send(JSON.stringify({type:"ERROR",message:"Admin connections cannot register player accounts."})); return; }
      const phone = normalizePhone(data.phone), password = String(data.password || ""), name = String(data.name || "").trim().slice(0,60) || normalizePhone(data.phone);
      const playerId = String(data.playerId || "").slice(0,100), playerToken = String(data.playerToken || "");
      if (!phone || password.length < 8 || password.length > 128 || !playerId || playerToken.length < 32) {
        sender.send(JSON.stringify({type:"ERROR",message:"Enter a valid phone number and password (8 to 128 characters)."})); return;
      }
      const accountKey = "playerAccount:" + phone;
      const legacyPhone = "251" + phone.slice(1);
      if (await this.ctx.storage.get(accountKey) || await this.ctx.storage.get("playerAccount:" + legacyPhone)) { sender.send(JSON.stringify({type:"ERROR",message:"This phone number is already registered in this game. Please log in."})); return; }
      const tokenKey = "playerToken:" + playerId, savedToken = await this.ctx.storage.get(tokenKey);
      if ((savedToken && savedToken !== playerToken) || (!savedToken && this.roomState.players[playerId])) {
        sender.send(JSON.stringify({type:"ERROR",message:"This existing player profile cannot be linked from this device. Contact the Admin."})); return;
      }
      const salt = randomHex(16), passwordHash = await hashPassword(password, salt);
      if (!savedToken) await this.ctx.storage.put(tokenKey, playerToken);
      const previous = this.roomState.players[playerId] || {};
      this.roomState.players[playerId] = {...previous,name,walletBalance:Number(previous.walletBalance)||0,approvedCards:Array.isArray(previous.approvedCards)?previous.approvedCards:[],pendingCards:Array.isArray(previous.pendingCards)?previous.pendingCards:[],selectedCards:Array.isArray(previous.approvedCards)?previous.approvedCards:[],selectedCard:(previous.approvedCards||[])[0]||null,status:"joined",joinedAt:previous.joinedAt||Date.now()};
      await this.ctx.storage.put(accountKey,{phone,playerId,salt,passwordHash,iterations:PASSWORD_ITERATIONS,mustChangePassword:false,createdAt:Date.now()});
      await this.saveState();
      try { sender.serializeAttachment({role:"player",playerId,phone}); } catch {}
      sender.send(JSON.stringify({type:"PLAYER_AUTH_OK",playerId,phone,mustChangePassword:false,approvedCards:this.roomState.players[playerId].approvedCards}));
      this.broadcast({type:"ROOM_STATE",data:this.roomState}); return;
    }
    if (data.type === "PLAYER_LOGIN") {
      const phone = normalizePhone(data.phone), password = String(data.password || "");
      if (!phone || !password) { sender.send(JSON.stringify({type:"ERROR",message:"Enter your phone number and password."})); return; }
      const failKey = "playerLoginFail:" + phone;
      const failures = await this.ctx.storage.get(failKey) || {count:0,lockedUntil:0};
      if (Number(failures.lockedUntil) > Date.now()) { sender.send(JSON.stringify({type:"ERROR",message:"Too many login attempts. Try again later."})); return; }
      const key = "playerAccount:" + phone;
      const legacyKey = "playerAccount:251" + phone.slice(1);
      const account = await this.ctx.storage.get(key) || await this.ctx.storage.get(legacyKey);
      if (!account) { sender.send(JSON.stringify({type:"ERROR",message:"Phone number or password is incorrect."})); return; }
      const attemptHash = await hashPassword(password, account.salt, account.iterations);
      if (attemptHash !== account.passwordHash) {
        failures.count = (Number(failures.count)||0) + 1;
        if (failures.count >= 6) { failures.count = 0; failures.lockedUntil = Date.now() + 15*60*1000; }
        await this.ctx.storage.put(failKey,failures);
        sender.send(JSON.stringify({type:"ERROR",message:"Phone number or password is incorrect."})); return;
      }
      await this.ctx.storage.delete(failKey);
      const player = this.roomState.players[account.playerId];
      if (!player) { sender.send(JSON.stringify({type:"ERROR",message:"Player account data was not found. Contact the Admin."})); return; }
      try { sender.serializeAttachment({role:"player",playerId:account.playerId,phone}); } catch {}
      player.status = "joined"; player.lastLoginAt = Date.now(); await this.saveState();
      sender.send(JSON.stringify({type:"PLAYER_AUTH_OK",playerId:account.playerId,phone,mustChangePassword:!!account.mustChangePassword,approvedCards:player.approvedCards||[]}));
      this.broadcast({type:"ROOM_STATE",data:this.roomState}); return;
    }
    if (data.type === "PLAYER_CHANGE_PASSWORD") {
      let identity = null; try { identity = sender.deserializeAttachment(); } catch {}
      if (identity?.role !== "player" || !identity.phone) { sender.send(JSON.stringify({type:"ERROR",message:"Log in before changing your password."})); return; }
      const password = String(data.newPassword || "");
      if (password.length < 8 || password.length > 128) { sender.send(JSON.stringify({type:"ERROR",message:"New password must be at least 8 characters."})); return; }
      const key = "playerAccount:" + identity.phone, account = await this.ctx.storage.get(key);
      if (!account || account.playerId !== identity.playerId) { sender.send(JSON.stringify({type:"ERROR",message:"Player account not found."})); return; }
      const salt = randomHex(16), passwordHash = await hashPassword(password, salt);
      account.salt = salt; account.passwordHash = passwordHash; account.iterations = PASSWORD_ITERATIONS; account.mustChangePassword = false; account.passwordChangedAt = Date.now();
      await this.ctx.storage.put(key,account);
      sender.send(JSON.stringify({type:"PLAYER_PASSWORD_CHANGED"})); return;
    }
    if (data.type === "ADMIN_RESET_PLAYER_PASSWORD") {
      let role = null; try { role = sender.deserializeAttachment()?.role; } catch {}
      if (role !== "admin") { sender.send(JSON.stringify({type:"ERROR",message:"Admin authorization required."})); return; }
      const phone = normalizePhone(data.phone), temporaryPassword = String(data.temporaryPassword || "");
      if (!phone || temporaryPassword.length < 8 || temporaryPassword.length > 128) { sender.send(JSON.stringify({type:"ERROR",message:"Enter a valid player phone number and temporary password (at least 8 characters)."})); return; }
      const key = "playerAccount:" + phone;
      const legacyKey = "playerAccount:251" + phone.slice(1);
      const account = await this.ctx.storage.get(key) || await this.ctx.storage.get(legacyKey);
      if (!account) { sender.send(JSON.stringify({type:"ERROR",message:"No registered player found with that phone number in this game."})); return; }
      const salt = randomHex(16); account.salt = salt; account.passwordHash = await hashPassword(temporaryPassword,salt); account.iterations = PASSWORD_ITERATIONS; account.mustChangePassword = true; account.passwordResetAt = Date.now();
      await this.ctx.storage.put(key,account);
      sender.send(JSON.stringify({type:"PLAYER_PASSWORD_RESET",phone})); return;
    }
    if (data.type === "JOIN_PLAYER") {
      sender.send(JSON.stringify({type:"ERROR",message:"Please register or log in with your phone number and password."})); return;
      /* legacy device-token join disabled; account login is required. */

      let currentIdentity = null; try { currentIdentity = sender.deserializeAttachment(); } catch {}
      if (currentIdentity?.role === "admin") { sender.send(JSON.stringify({type:"ERROR",message:"Admin connections cannot join as players"})); return; }
      const playerId = String(data.playerId || "").slice(0, 100);
      const playerToken = String(data.playerToken || "");
      const name = String(data.name || "").trim().slice(0, 60);
      const rawCards = Array.isArray(data.cards) ? data.cards : [data.card];
      const cards = [...new Set(rawCards.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 300))].slice(0, 300);
      if (!playerId || !name || playerToken.length < 32) {
        sender.send(JSON.stringify({ type: "ERROR", message: "Valid player identity and name are required. Please refresh the player page." })); return;
      }
      const tokenKey = "playerToken:" + playerId;
      const savedToken = await this.ctx.storage.get(tokenKey);
      if (savedToken && savedToken !== playerToken) {
        sender.send(JSON.stringify({ type: "ERROR", message: "Player identity verification failed. Use the original device or contact the Admin." })); return;
      }
      if (!savedToken) await this.ctx.storage.put(tokenKey, playerToken);
      const previous = this.roomState.players[playerId] || {};
      if (!this.roomState.deposits) this.roomState.deposits = {};
      if (!this.roomState.depositConfig) this.roomState.depositConfig = {enabled:false,amount:0,currency:"ETB",method:"Telebirr",account:""};
      if (!this.roomState.claims) this.roomState.claims = {};
      if (!this.roomState.withdrawals) this.roomState.withdrawals = {};
      const approvedCards = Array.isArray(previous.approvedCards) ? previous.approvedCards : [];
      const pendingCards = Array.isArray(previous.pendingCards) ? previous.pendingCards : [];
      this.roomState.players[playerId] = { ...previous, name, walletBalance: Number(previous.walletBalance)||0, approvedCards, pendingCards, selectedCards: approvedCards, selectedCard: approvedCards[0] || null, status: "joined", joinedAt: previous.joinedAt || Date.now() };
      await this.saveState();
      try { sender.serializeAttachment({role:"player",playerId}); } catch {}
      sender.send(JSON.stringify({type:"PLAYER_JOINED",approvedCards}));
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

export class OwnerRegistry {
  constructor(ctx,env) { this.ctx=ctx; this.env=env; this.ready=this.ctx.blockConcurrencyWhile(async()=>{this.games=await this.ctx.storage.get("games")||{};}); }
  async fetch(request) {
    await this.ready;
    const url=new URL(request.url);
    if (url.pathname==="/register" && request.method==="POST") {
      let body={}; try {body=await request.json();} catch {}
      const gameId=String(body.gameId||"").trim().slice(0,80);
      if (!/^[A-Za-z0-9_-]{3,80}$/.test(gameId)) return new Response(JSON.stringify({error:"Invalid Game ID"}),{status:400});
      const previous=this.games[gameId]||{};
      this.games[gameId]={gameId,firstSeen:previous.firstSeen||Date.now(),lastSeen:Date.now()};
      await this.ctx.storage.put("games",this.games);
      return new Response(JSON.stringify({ok:true}));
    }
    if (url.pathname==="/list" && request.method==="GET") {
      const games=Object.values(this.games).sort((a,b)=>b.lastSeen-a.lastSeen);
      return new Response(JSON.stringify({games}),{headers:{"Content-Type":"application/json"}});
    }
    return new Response("Not found",{status:404});
  }
}
