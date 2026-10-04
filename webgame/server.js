import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { GameEngine } from './src/game-engine.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const AVATARS = ['♠', '☠', '♦', '♣'];
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/game.js', ['game.js', 'text/javascript; charset=utf-8']],
  ['/src/game-engine.js', ['src/game-engine.js', 'text/javascript; charset=utf-8']],
  ['/src/guest-profile.js', ['src/guest-profile.js', 'text/javascript; charset=utf-8']],
  ['/src/i18n.js', ['src/i18n.js', 'text/javascript; charset=utf-8']],
  ['/src/llm-config.js', ['src/llm-config.js', 'text/javascript; charset=utf-8']],
  ['/src/llm-decision.js', ['src/llm-decision.js', 'text/javascript; charset=utf-8']],
  ['/assets/tavern-bg.png', ['assets/tavern-bg.png', 'image/png']],
]);

function roomCode(rooms, random = Math.random) {
  let code;
  do {
    code = Array.from({ length: 4 }, () => ROOM_ALPHABET[Math.floor(random() * ROOM_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// ===== 本地反代(Anthropic /v1/messages 协议)配置:供单人模式的 LLM AI 玩家使用 =====
// 模型阵容在 src/llm-config.js 的 LLM_SEATS(玩家名 = 模型名);密钥只留在服务端。
// 需要 key 的反代通过环境变量注入(如 WORKBUDDY_API_KEY),不要把密钥写进代码。
const LLM_PROVIDERS = {
  qoder: { base_url: 'http://127.0.0.1:8288', api_key: '' },
  workbuddy: { base_url: 'http://127.0.0.1:8377', api_key: process.env.WORKBUDDY_API_KEY || '' },
};
const LLM_TIMEOUT_MS = 110000;
const LLM_BODY_LIMIT = 262144;

async function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > LLM_BODY_LIMIT) {
        reject(new Error('payload too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function handleLlmRequest(request, response, logger = console) {
  const replyJson = (status, payload) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(payload));
  };
  let payload;
  try {
    payload = JSON.parse(await readRequestBody(request));
  } catch {
    replyJson(400, { error: '请求体不是合法 JSON' });
    return;
  }
  const { provider, model, system, messages, max_tokens: maxTokens } = payload ?? {};
  const upstream = LLM_PROVIDERS[provider];
  const validMessages = Array.isArray(messages)
    && messages.every((message) => message
      && (message.role === 'user' || message.role === 'assistant')
      && typeof message.content === 'string' && message.content.length);
  if (!upstream || typeof model !== 'string' || !model.trim() || !validMessages) {
    replyJson(400, { error: '参数无效:需要 provider、model 和 user/assistant 消息列表' });
    return;
  }

  const body = {
    model: model.trim(),
    max_tokens: Number.isFinite(maxTokens) ? Math.min(Math.max(Math.trunc(maxTokens), 256), 16384) : 8192,
    stream: false,
    messages: messages.map(({ role, content }) => ({ role, content })),
  };
  if (typeof system === 'string' && system.trim()) body.system = system;
  const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (upstream.api_key) {
    headers.Authorization = `Bearer ${upstream.api_key}`;
    headers['x-api-key'] = upstream.api_key;
  }
  logger?.info?.(`LLM 请求: ${provider}/${model} msgs=${body.messages.length}`);

  try {
    const upstreamResponse = await fetch(`${upstream.base_url}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    const detail = await upstreamResponse.text();
    if (!upstreamResponse.ok) {
      logger?.error?.(`LLM 反代返回 HTTP ${upstreamResponse.status}: ${detail.slice(0, 300)}`);
      replyJson(502, { error: `反代返回 ${upstreamResponse.status}` });
      return;
    }
    const result = JSON.parse(detail);
    const blocks = Array.isArray(result.content) ? result.content : [];
    replyJson(200, {
      content: blocks.filter((block) => block?.type === 'text').map((block) => block.text ?? '').join(''),
      reasoning: blocks.filter((block) => block?.type === 'thinking').map((block) => block.thinking ?? '').join(''),
    });
  } catch (error) {
    logger?.error?.(`LLM 反代调用失败: ${error.message}`);
    replyJson(502, { error: error.message });
  }
}

function cleanName(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/\s+/g, ' ').slice(0, 12);
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

export function createGameServer({
  host = process.env.HOST || '0.0.0.0',
  port = Number(process.env.PORT) || 4173,
  revealDelay = 4200,
  logger = console,
} = {}) {
  const rooms = new Map();
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'POST' && new URL(request.url, 'http://localhost').pathname === '/api/llm') {
        await handleLlmRequest(request, response, logger);
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method Not Allowed');
        return;
      }
      const path = new URL(request.url, 'http://localhost').pathname;
      const asset = STATIC_FILES.get(path);
      if (!asset) {
        response.writeHead(404).end('Not Found');
        return;
      }
      const [file, type] = asset;
      const body = await readFile(joinPath(ROOT, file));
      response.writeHead(200, {
        'Content-Type': type,
        'Content-Length': body.length,
        'Cache-Control': path.endsWith('.png') ? 'public, max-age=3600' : 'no-cache',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; script-src 'self'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      logger?.error(error);
      response.writeHead(500).end('Internal Server Error');
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
  wss.on('error', (error) => { if (server.listening) logger?.error(error); });

  function roomView(room) {
    return {
      code: room.code,
      hostId: room.hostId,
      started: Boolean(room.engine),
      players: [...room.members.values()].map(({ id, name, avatar }) => ({ id, name, avatar })),
    };
  }

  function broadcastRoom(room) {
    const view = roomView(room);
    room.members.forEach((member) => send(member.socket, { type: 'room', youId: member.id, room: view }));
  }

  function broadcastState(room) {
    if (!room.engine) return;
    room.members.forEach((member) => {
      send(member.socket, {
        type: 'game-state',
        youId: member.id,
        room: roomView(room),
        state: room.engine.viewFor(member.id),
      });
    });
  }

  function broadcast(room, message) {
    room.members.forEach((member) => send(member.socket, message));
  }

  function requireRoom(socket) {
    const room = rooms.get(socket.roomCode);
    if (!room || !room.members.has(socket.playerId)) throw new Error('你还没有加入房间');
    return room;
  }

  function joinRoom(socket, room, name) {
    if (socket.roomCode) throw new Error('请先离开当前房间');
    if (room.engine) throw new Error('牌局已经开始');
    if (room.members.size >= 4) throw new Error('房间已满');
    const id = randomUUID();
    const usedAvatars = new Set([...room.members.values()].map(({ avatar }) => avatar));
    const member = { id, name, avatar: AVATARS.find((avatar) => !usedAvatars.has(avatar)), socket };
    room.members.set(id, member);
    socket.roomCode = room.code;
    socket.playerId = id;
  }

  function handleMessage(socket, raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      throw new Error('消息格式无效');
    }
    if (!message || typeof message.type !== 'string') throw new Error('消息类型无效');

    if (message.type === 'create-room') {
      const name = cleanName(message.name);
      if (!name) throw new Error('请输入玩家昵称');
      const code = roomCode(rooms);
      const room = { code, hostId: null, members: new Map(), engine: null, roundTimer: null };
      rooms.set(code, room);
      joinRoom(socket, room, name);
      room.hostId = socket.playerId;
      broadcastRoom(room);
      return;
    }

    if (message.type === 'join-room') {
      const name = cleanName(message.name);
      const code = String(message.code ?? '').trim().toUpperCase();
      if (!name) throw new Error('请输入玩家昵称');
      const room = rooms.get(code);
      if (!room) throw new Error('找不到该房间');
      joinRoom(socket, room, name);
      broadcastRoom(room);
      return;
    }

    const room = requireRoom(socket);
    if (message.type === 'start-game') {
      if (room.hostId !== socket.playerId) throw new Error('只有房主可以开始');
      if (room.members.size < 2) throw new Error('至少需要 2 名玩家');
      if (room.engine && room.engine.phase !== 'ended') throw new Error('牌局已经开始');
      clearTimeout(room.roundTimer);
      room.engine = new GameEngine([...room.members.values()].map(({ id, name, avatar }) => ({ id, name, avatar })));
      room.engine.start();
      broadcastState(room);
      return;
    }

    if (!room.engine) throw new Error('牌局尚未开始');
    if (message.type === 'play') {
      room.engine.play(socket.playerId, message.indices);
      broadcastState(room);
      return;
    }

    if (message.type === 'challenge') {
      const result = room.engine.challenge(socket.playerId);
      broadcast(room, { type: 'reveal', result });
      broadcastState(room);
      clearTimeout(room.roundTimer);
      room.roundTimer = setTimeout(() => {
        if (room.engine?.phase !== 'reveal') return;
        room.engine.nextRound();
        broadcastState(room);
      }, revealDelay);
      return;
    }

    if (message.type === 'leave-room') {
      socket.close(1000, 'left room');
      return;
    }

    throw new Error('未知操作');
  }

  function cleanup(socket) {
    if (socket.cleaned) return;
    socket.cleaned = true;
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    const member = room.members.get(socket.playerId);
    if (!member) return;

    room.members.delete(socket.playerId);
    if (room.engine) room.engine.forfeit(socket.playerId);
    if (!room.members.size) {
      clearTimeout(room.roundTimer);
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === socket.playerId) room.hostId = room.members.keys().next().value;
    broadcastRoom(room);
    broadcastState(room);
  }

  wss.on('connection', (socket) => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('message', (raw) => {
      try {
        handleMessage(socket, raw);
      } catch (error) {
        send(socket, { type: 'error', message: error.message || '操作失败' });
      }
    });
    socket.on('close', () => cleanup(socket));
    socket.on('error', (error) => logger?.error(error));
  });

  const heartbeat = setInterval(() => {
    wss.clients.forEach((socket) => {
      if (socket.isAlive === false) {
        socket.terminate();
        return;
      }
      socket.isAlive = false;
      socket.ping();
    });
  }, 30000);
  heartbeat.unref();

  return {
    server,
    wss,
    rooms,
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve(server.address());
      });
    }),
    close: () => new Promise((resolve) => {
      clearInterval(heartbeat);
      rooms.forEach((room) => clearTimeout(room.roundTimer));
      wss.clients.forEach((socket) => socket.terminate());
      wss.close(() => server.close(() => resolve()));
    }),
  };
}

function lanUrls(port) {
  const urls = new Set([`http://localhost:${port}`]);
  Object.values(networkInterfaces()).flat().forEach((address) => {
    if (address?.family === 'IPv4' && !address.internal) urls.add(`http://${address.address}:${port}`);
  });
  return [...urls];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const gameServer = createGameServer();
  try {
    const address = await gameServer.start();
    console.log('骗子酒馆 v1.7.1 已启动：');
    lanUrls(address.port).forEach((url) => console.log(`  ${url}`));

    const shutdown = async () => {
      await gameServer.close();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    const port = Number(process.env.PORT) || 4173;
    console.error(error.code === 'EADDRINUSE' ? `启动失败：端口 ${port} 已被占用，请设置其他 PORT 后重试。` : `启动失败：${error.message}`);
    process.exitCode = 1;
  }
}
