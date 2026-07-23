import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

// ---------------------------------------------------------------------------
// Конфигурация (всё из ENV, с безопасными дефолтами под бюджет 1 vCPU / 1GB)
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 3000);

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
  throw new Error('ADMIN_TOKEN is not configured');
}

const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Секрет для подписи сессионных токенов. Комнаты живут только в RAM и теряются
// при рестарте — поэтому переживать рестарт токенам не нужно: генерируем
// эфемерный секрет, если не задан явно.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL = Number(process.env.SESSION_TTL || 12 * 60 * 60); // сек, срок жизни токена

// TURN REST API (coturn --use-auth-secret). Если секрет не задан — TURN
// отключён и клиент получит только STUN (с предупреждением в логах).
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_URLS = (process.env.TURN_URLS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const TURN_TTL = Number(process.env.TURN_TTL || 3600); // сек, срок жизни TURN-креды
// Несколько независимых публичных STUN по умолчанию: если один недоступен или
// режет запросы, srflx-кандидат всё равно соберётся с другого. STUN не заменяет
// TURN (symmetric NAT/файрволы), но даёт запас надёжности для обычных NAT.
const STUN_URLS = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302,stun:stun.cloudflare.com:3478')
  .split(',').map(s => s.trim()).filter(Boolean);

// Тайминги устойчивости на слабом интернете
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 30_000); // период ping
const GRACE_MS = Number(process.env.GRACE_MS || 20_000);         // окно на reconnect (только при обрыве сети)
const PENDING_MS = Number(process.env.PENDING_MS || 60_000);     // TTL «стука» без одобрения

// Rate limiting (защита 1 vCPU от тривиального DoS)
const MAX_CONNS_PER_IP = Number(process.env.MAX_CONNS_PER_IP || 25);
const MAX_ROOMS_PER_IP_MIN = Number(process.env.MAX_ROOMS_PER_IP_MIN || 10);
const MAX_ADMIN_FAILS = Number(process.env.MAX_ADMIN_FAILS || 5);
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

const MAX_NAME_LEN = 50;
const MAX_TEXT_LEN = 2000;
const MAX_WS_PAYLOAD = 64 * 1024; // 64KB: SDP+ICE влезает с запасом, крупные фреймы режем

const nowSec = () => Math.floor(Date.now() / 1000);

// Структурный JSON-лог: одна строка на событие, с контекстом для трассировки
// конкретной сессии (connId / roomId / clientId).
type LogCtx = Record<string, unknown>;
function log(level: 'info' | 'warn' | 'error', msg: string, ctx: LogCtx = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...ctx });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

// ---------------------------------------------------------------------------
// Express + HTTP + WS
// ---------------------------------------------------------------------------
const app = express();

// Динамический ICE-конфиг с time-limited TURN-кредами (TURN REST API).
// Клиент запрашивает его перед созданием RTCPeerConnection.
app.get('/api/ice-servers', (_req, res) => {
  res.json({ iceServers: buildIceServers() });
});

app.use(express.static(path.join(__dirname, '../public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: MAX_WS_PAYLOAD });

function buildIceServers() {
  const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [];
  if (STUN_URLS.length) iceServers.push({ urls: STUN_URLS });

  if (TURN_SECRET && TURN_URLS.length) {
    // coturn REST: username = "<expiry>", credential = base64(HMAC-SHA1(secret, username))
    const expiry = nowSec() + TURN_TTL;
    const username = `${expiry}`;
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    iceServers.push({ urls: TURN_URLS, username, credential });
  }
  return iceServers;
}

// ---------------------------------------------------------------------------
// Telegram-лог (fire-and-forget: НЕ блокирует горячий путь create/join)
// ---------------------------------------------------------------------------
function logToTelegram(message: string): void {
  log('info', 'event', { message });
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;

  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TG_CHAT_ID,
      text: `🛡️ *LightCall Monitor*:\n${message}`,
      parse_mode: 'Markdown'
    })
  }).catch(err => log('error', 'telegram_send_failed', { err: String(err) }));
}

// ---------------------------------------------------------------------------
// Модель данных
// ---------------------------------------------------------------------------
interface Participant {
  id: string;
  name: string;
  ws: WebSocket;
  isCreator: boolean;
  approved: boolean;
  connected: boolean;
  graceTimer?: NodeJS.Timeout;   // отложенное удаление после обрыва (reconnect)
  pendingTimer?: NodeJS.Timeout; // TTL ожидания одобрения
}

interface Room {
  id: string;
  name: string;
  passwordHash: string;
  maxUsers: number;
  participants: Map<string, Participant>;
}

const rooms = new Map<string, Room>();
let adminSocket: WebSocket | null = null;

// Считаем к лимиту комнаты только реальных участников (создатель + одобренные).
// Неодобренные «стучащиеся» гости слот НЕ занимают.
function countSlots(room: Room): number {
  let n = 0;
  for (const p of room.participants.values()) if (p.approved || p.isCreator) n++;
  return n;
}

function sanitizeName(v: unknown): string {
  return String(v ?? '').slice(0, MAX_NAME_LEN);
}

// ---------------------------------------------------------------------------
// Сессионные токены (HMAC) для переподключения без повторного approve
// ---------------------------------------------------------------------------
function makeSession(roomId: string, clientId: string): string {
  const exp = nowSec() + SESSION_TTL;
  const payload = `${roomId}.${clientId}.${exp}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifySession(token: unknown): { roomId: string; clientId: string } | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [roomId, clientId, expStr, sig] = parts;
  const payload = `${roomId}.${clientId}.${expStr}`;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(expStr) < nowSec()) return null;
  return { roomId, clientId };
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// Rate limiting (in-memory, near-zero стоимость)
// ---------------------------------------------------------------------------
interface IpStat { conns: number; roomTimes: number[]; adminFails: number; }
const ipStats = new Map<string, IpStat>();

function ipOf(req: http.IncomingMessage): string {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    const v = Array.isArray(xff) ? xff[0] : xff;
    if (v) return v.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function getIpStat(ip: string): IpStat {
  let s = ipStats.get(ip);
  if (!s) { s = { conns: 0, roomTimes: [], adminFails: 0 }; ipStats.set(ip, s); }
  return s;
}

function allowRoomCreate(ip: string): boolean {
  const s = getIpStat(ip);
  const cutoff = Date.now() - 60_000;
  s.roomTimes = s.roomTimes.filter(t => t > cutoff);
  if (s.roomTimes.length >= MAX_ROOMS_PER_IP_MIN) return false;
  s.roomTimes.push(Date.now());
  return true;
}

// ---------------------------------------------------------------------------
// Отправка состояния в админку (+ метрики процесса для мониторинга бюджета)
// ---------------------------------------------------------------------------
function sendStateToAdmin() {
  if (!adminSocket || adminSocket.readyState !== WebSocket.OPEN) return;

  const roomsData = Array.from(rooms.values()).map(r => ({
    id: r.id,
    name: r.name,
    maxUsers: r.maxUsers,
    participants: Array.from(r.participants.values()).map(p => ({
      id: p.id,
      name: p.name,
      isCreator: p.isCreator,
      approved: p.approved,
      connected: p.connected
    }))
  }));

  const mem = process.memoryUsage();
  adminSocket.send(JSON.stringify({
    type: 'admin-state',
    rooms: roomsData,
    metrics: {
      rooms: rooms.size,
      connections: wss.clients.size,
      rssMB: Math.round(mem.rss / 1024 / 1024),
      heapMB: Math.round(mem.heapUsed / 1024 / 1024),
      uptimeSec: Math.round(process.uptime())
    }
  }));
}

// ---------------------------------------------------------------------------
// Хелперы над комнатой
// ---------------------------------------------------------------------------
function send(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function findCreator(room: Room): Participant | null {
  for (const p of room.participants.values()) if (p.isCreator) return p;
  return null;
}

// Спарить участника со всеми уже присутствующими одобренными пирами (mesh).
function pairWithPeers(room: Room, me: Participant) {
  room.participants.forEach(peer => {
    if (peer.id === me.id || !peer.approved || !peer.connected) return;
    if (peer.ws.readyState !== WebSocket.OPEN) return;
    send(peer.ws, { type: 'new-peer', peerId: me.id, peerName: me.name, polite: false });
    send(me.ws, { type: 'new-peer', peerId: peer.id, peerName: peer.name, polite: true });
  });
}

// Финальный выход участника: удаление, уведомление пиров, переизбрание создателя,
// удаление пустой комнаты.
function finalizeLeave(room: Room, roomId: string, clientId: string) {
  const participant = room.participants.get(clientId);
  if (!participant) return;

  if (participant.graceTimer) clearTimeout(participant.graceTimer);
  if (participant.pendingTimer) clearTimeout(participant.pendingTimer);

  const name = participant.name;
  room.participants.delete(clientId);
  logToTelegram(`🚪 Участник *${name}* покинул комнату *${room.name}*`);

  if (room.participants.size === 0) {
    rooms.delete(roomId);
    logToTelegram(`🗑️ Комната *${room.name}* опустела и удалена из памяти.`);
    sendStateToAdmin();
    return;
  }

  if (participant.isCreator) {
    const next = Array.from(room.participants.values()).find(p => p.approved && p.connected)
      || Array.from(room.participants.values()).find(p => p.approved);
    if (next) {
      next.isCreator = true;
      logToTelegram(`👑 Создатель вышел. Новым создателем комнаты *${room.name}* назначен *${next.name}*`);
      send(next.ws, { type: 'role-updated', isCreator: true });
    }
  }

  for (const p of room.participants.values()) {
    if (p.approved && p.connected) send(p.ws, { type: 'peer-left', peerId: clientId });
  }
  sendStateToAdmin();
}

// ---------------------------------------------------------------------------
// WebSocket-соединения
// ---------------------------------------------------------------------------
wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  const ip = ipOf(req);
  const stat = getIpStat(ip);
  const connId = crypto.randomBytes(4).toString('hex');

  // Лимит одновременных соединений с одного IP
  if (stat.conns >= MAX_CONNS_PER_IP) {
    ws.close(1013, 'Too many connections');
    return;
  }
  stat.conns++;

  // Heartbeat: помечаем живым, обновляем на pong
  (ws as any).isAlive = true;
  ws.on('pong', () => { (ws as any).isAlive = true; });

  let currentRoomId: string | null = null;
  let clientId: string | null = null;
  let isAdmin = false;

  ws.on('message', (raw: RawData) => {
    let data: any;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return; // мусорный фрейм — молча игнорируем
    }
    if (!data || typeof data.type !== 'string') return;

    try {
      // --- Аутентификация админа (с защитой от брутфорса) ---
      if (data.type === 'admin-auth') {
        if (stat.adminFails >= MAX_ADMIN_FAILS) {
          send(ws, { type: 'error', message: 'Слишком много попыток. Попробуйте позже.' });
          ws.close();
          return;
        }
        if (typeof data.token === 'string' && safeEqual(data.token, ADMIN_TOKEN!)) {
          isAdmin = true;
          adminSocket = ws;
          stat.adminFails = 0;
          log('info', 'admin_authorized', { connId, ip });
          sendStateToAdmin();
        } else {
          stat.adminFails++;
          send(ws, { type: 'error', message: 'Неверный токен админа' });
          ws.close();
        }
        return;
      }

      // --- Переподключение по сессионному токену (reconnect) ---
      if (data.type === 'rejoin') {
        const parsed = verifySession(data.sessionToken);
        if (!parsed) { send(ws, { type: 'rejoin-failed', message: 'Сессия истекла.' }); return; }

        const room = rooms.get(parsed.roomId);
        const participant = room?.participants.get(parsed.clientId);
        if (!room || !participant) { send(ws, { type: 'rejoin-failed', message: 'Сессия недействительна.' }); return; }

        // Заменяем сокет; старый (если ещё жив) закрываем — его close-хендлер
        // не тронет участника из-за проверки p.ws === ws.
        const oldWs = participant.ws;
        if (oldWs !== ws && oldWs.readyState === WebSocket.OPEN) oldWs.terminate();

        if (participant.graceTimer) { clearTimeout(participant.graceTimer); participant.graceTimer = undefined; }
        participant.ws = ws;
        participant.connected = true;
        currentRoomId = parsed.roomId;
        clientId = parsed.clientId;

        send(ws, {
          type: 'rejoined',
          roomId: room.id,
          clientId: participant.id,
          isCreator: participant.isCreator,
          sessionToken: makeSession(room.id, participant.id)
        });

        // Пересобираем mesh: просим остальных сбросить устаревшее соединение,
        // затем заново спариваем.
        if (participant.approved) {
          room.participants.forEach(peer => {
            if (peer.id !== participant.id && peer.approved && peer.connected) {
              send(peer.ws, { type: 'peer-left', peerId: participant.id });
            }
          });
          pairWithPeers(room, participant);
        }
        logToTelegram(`🔄 Участник *${participant.name}* переподключился к комнате *${room.name}*`);
        sendStateToAdmin();
        return;
      }

      // --- Осознанный выход (кнопка / закрытие вкладки): освобождаем слот сразу,
      //     без grace-периода. Grace нужен только при внезапном обрыве сети. ---
      if (data.type === 'leave') {
        if (currentRoomId && clientId) {
          const room = rooms.get(currentRoomId);
          const me = room?.participants.get(clientId);
          if (room && me && me.ws === ws) finalizeLeave(room, currentRoomId, clientId);
        }
        return;
      }

      // --- Команды администратора ---
      if (isAdmin) {
        switch (data.type) {
          case 'admin-kick': {
            const room = rooms.get(data.roomId);
            const participant = room?.participants.get(data.userId);
            if (room && participant) {
              logToTelegram(`🚫 Админ кикнул пользователя *${participant.name}* из комнаты *${room.name}*`);
              room.participants.forEach(p => {
                if (p.id !== participant.id && p.approved && p.connected) {
                  send(p.ws, { type: 'peer-left', peerId: participant.id });
                }
              });
              send(participant.ws, { type: 'error', message: 'Вы были исключены администратором.' });
              if (participant.graceTimer) clearTimeout(participant.graceTimer);
              if (participant.pendingTimer) clearTimeout(participant.pendingTimer);
              room.participants.delete(participant.id);
              participant.ws.close();
              if (room.participants.size === 0) rooms.delete(room.id);
              sendStateToAdmin();
            }
            break;
          }
          case 'admin-make-creator': {
            const room = rooms.get(data.roomId);
            if (room && room.participants.has(data.userId)) {
              room.participants.forEach(p => { p.isCreator = (p.id === data.userId); });
              logToTelegram(`👑 Админ передал права создателя комнаты *${room.name}* → *${room.participants.get(data.userId)?.name}*`);
              room.participants.forEach(p => send(p.ws, { type: 'role-updated', isCreator: p.isCreator }));
              sendStateToAdmin();
            }
            break;
          }
          case 'admin-mute-peer': {
            const room = rooms.get(data.roomId);
            const participant = room?.participants.get(data.userId);
            if (room && participant && participant.connected) {
              const deviceName = data.mediaType === 'audio' ? 'микрофон' : 'камеру';
              logToTelegram(`🛡️ Админ выключил *${deviceName}* пользователю *${participant.name}* в комнате *${room.name}*`);
              send(participant.ws, { type: 'force-mute', mediaType: data.mediaType });
              room.participants.forEach(p => {
                if (!p.approved || !p.connected) return;
                const systemText = p.id === participant.id
                  ? `Администратор системы отключил вам ${deviceName}.`
                  : `Администратор системы отключил ${deviceName} пользователю ${participant.name}.`;
                send(p.ws, { type: 'chat-message', senderName: 'Администрация', text: systemText, timestamp: new Date().toLocaleTimeString(), isSystem: true });
              });
            }
            break;
          }
        }
        return;
      }

      // --- Команды обычных клиентов ---
      switch (data.type) {
        case 'create-room': {
          if (!allowRoomCreate(ip)) {
            send(ws, { type: 'error', message: 'Слишком много комнат. Подождите минуту.' });
            return;
          }
          const roomName = sanitizeName(data.roomName) || 'Комната';
          const passwordHash = typeof data.passwordHash === 'string' ? data.passwordHash : '';
          const roomId = crypto.randomBytes(16).toString('hex');
          const limit = Math.min(Math.max(parseInt(data.maxUsers) || 2, 2), 5);
          clientId = crypto.randomBytes(8).toString('hex');

          const creator: Participant = {
            id: clientId,
            name: sanitizeName(data.creatorName) || 'Создатель',
            ws, isCreator: true, approved: true, connected: true
          };
          const newRoom: Room = { id: roomId, name: roomName, passwordHash, maxUsers: limit, participants: new Map([[clientId, creator]]) };
          rooms.set(roomId, newRoom);
          currentRoomId = roomId;

          logToTelegram(`🟢 Создана комната *${roomName}*\nСоздатель: *${creator.name}*\nЛимит: ${limit}`);
          send(ws, { type: 'room-created', roomId, clientId, roomName, sessionToken: makeSession(roomId, clientId) });
          sendStateToAdmin();
          break;
        }

        case 'join-room': {
          const room = rooms.get(data.roomId);
          if (!room) { send(ws, { type: 'error', message: 'Комната не найдена.' }); return; }
          if (countSlots(room) >= room.maxUsers) { send(ws, { type: 'error', message: 'Комната заполнена.' }); return; }
          if (typeof data.passwordHash !== 'string' || !safeEqual(room.passwordHash, data.passwordHash)) {
            send(ws, { type: 'error', message: 'Неверный код доступа.' }); return;
          }

          const creator = findCreator(room);
          if (!creator || !creator.connected || creator.ws.readyState !== WebSocket.OPEN) {
            send(ws, { type: 'error', message: 'Создатель комнаты отсутствует.' }); return;
          }

          clientId = crypto.randomBytes(8).toString('hex');
          const guest: Participant = {
            id: clientId, name: sanitizeName(data.userName) || 'Гость',
            ws, isCreator: false, approved: false, connected: true
          };
          // TTL на «стук»: если создатель не ответил за PENDING_MS — снимаем гостя.
          guest.pendingTimer = setTimeout(() => {
            const cur = room.participants.get(guest.id);
            if (cur && !cur.approved) {
              room.participants.delete(guest.id);
              send(cur.ws, { type: 'error', message: 'Время ожидания одобрения истекло.' });
              sendStateToAdmin();
            }
          }, PENDING_MS);

          room.participants.set(clientId, guest);
          currentRoomId = data.roomId;

          logToTelegram(`🚪 В дверь комнаты *${room.name}* постучался: *${guest.name}*`);
          send(creator.ws, { type: 'knock-knock', guestId: clientId, guestName: guest.name });
          send(ws, { type: 'waiting-approval', clientId });
          sendStateToAdmin();
          break;
        }

        case 'approve-guest': {
          if (!currentRoomId) return;
          const room = rooms.get(currentRoomId);
          const me = room?.participants.get(clientId!);
          if (!room || !me || !me.isCreator) return; // одобрять может только создатель

          const guest = room.participants.get(data.guestId);
          if (!guest) return;
          if (guest.pendingTimer) { clearTimeout(guest.pendingTimer); guest.pendingTimer = undefined; }

          if (data.approved) {
            if (countSlots(room) >= room.maxUsers) {
              send(guest.ws, { type: 'error', message: 'Комната заполнена.' });
              room.participants.delete(guest.id);
            } else {
              guest.approved = true;
              logToTelegram(`✅ Пользователь *${guest.name}* допущен в комнату *${room.name}*`);
              send(guest.ws, { type: 'join-approved', roomId: currentRoomId, clientId: guest.id, sessionToken: makeSession(currentRoomId, guest.id) });
            }
          } else {
            logToTelegram(`❌ Доступ *${guest.name}* в комнату *${room.name}* отклонён`);
            send(guest.ws, { type: 'join-rejected' });
            room.participants.delete(guest.id);
          }
          sendStateToAdmin();
          break;
        }

        case 'client-ready': {
          if (!currentRoomId || !clientId) return;
          const room = rooms.get(currentRoomId);
          const me = room?.participants.get(clientId);
          if (!room || !me || !me.approved) return;
          log('info', 'client_ready', { connId, roomId: currentRoomId, clientId, name: me.name });
          pairWithPeers(room, me);
          break;
        }

        case 'media-state-change': {
          // Ретрансляция состояния мик/камеры пирам (для индикатора у собеседников)
          if (!currentRoomId || !clientId) return;
          const room = rooms.get(currentRoomId);
          const sender = room?.participants.get(clientId);
          if (!room || !sender || !sender.approved) return;
          room.participants.forEach(p => {
            if (p.id !== sender.id && p.approved && p.connected) {
              send(p.ws, { type: 'media-state-change', senderPeerId: sender.id, mediaType: data.mediaType, enabled: !!data.enabled });
            }
          });
          break;
        }

        case 'screen-share-started': {
          if (!currentRoomId || !clientId) return;
          const room = rooms.get(currentRoomId);
          const sender = room?.participants.get(clientId);
          if (!room || !sender || !sender.approved) return;
          logToTelegram(`🖥️ Участник *${sender.name}* запустил трансляцию экрана в комнате *${room.name}*`);
          room.participants.forEach(p => {
            if (p.approved && p.connected) send(p.ws, { type: 'screen-share-announced', sharerId: sender.id });
          });
          break;
        }

        case 'moderator-mute-peer': {
          if (!currentRoomId || !clientId) return;
          const room = rooms.get(currentRoomId);
          const sender = room?.participants.get(clientId);
          if (!room || !sender || !sender.isCreator) return;

          const targetPeer = room.participants.get(data.targetPeerId);
          if (targetPeer && targetPeer.connected) {
            const deviceName = data.mediaType === 'audio' ? 'микрофон' : 'камеру';
            logToTelegram(`⚠️ Создатель *${sender.name}* выключил *${deviceName}* пользователю *${targetPeer.name}*`);
            send(targetPeer.ws, { type: 'force-mute', mediaType: data.mediaType });
            room.participants.forEach(p => {
              if (!p.approved || !p.connected) return;
              let systemText: string;
              if (p.id === targetPeer.id) systemText = `Создатель комнаты отключил вам ${deviceName}.`;
              else if (p.id === sender.id) systemText = `Вы отключили ${deviceName} пользователю ${targetPeer.name}.`;
              else systemText = `Создатель комнаты отключил ${deviceName} пользователю ${targetPeer.name}.`;
              send(p.ws, { type: 'chat-message', senderName: 'Система', text: systemText, timestamp: new Date().toLocaleTimeString(), isSystem: true });
            });
          }
          break;
        }

        case 'relay-sdp':
        case 'relay-ice': {
          if (!currentRoomId || !clientId) return;
          const room = rooms.get(currentRoomId);
          const sender = room?.participants.get(clientId);
          if (!room || !sender || !sender.approved) return; // релеить может только одобренный

          const targetPeer = room.participants.get(data.targetPeerId);
          if (targetPeer && targetPeer.approved && targetPeer.connected) {
            data.senderPeerId = clientId;
            send(targetPeer.ws, data);
          }
          break;
        }

        case 'chat-message': {
          if (!currentRoomId || !clientId) return;
          const room = rooms.get(currentRoomId);
          const sender = room?.participants.get(clientId);
          if (!room || !sender || !sender.approved) return;
          const text = String(data.text ?? '').slice(0, MAX_TEXT_LEN);
          if (!text) return;
          for (const p of room.participants.values()) {
            if (p.approved && p.connected) {
              send(p.ws, { type: 'chat-message', senderName: sender.name, text, timestamp: new Date().toLocaleTimeString(), isSystem: false });
            }
          }
          break;
        }
      }
    } catch (err) {
      log('error', 'message_handler_error', { connId, roomId: currentRoomId, err: String(err) });
    }
  });

  ws.on('close', () => {
    stat.conns = Math.max(0, stat.conns - 1);
    // Прибираем счётчик IP, если он полностью «остыл»
    if (stat.conns === 0 && stat.roomTimes.length === 0 && stat.adminFails === 0) ipStats.delete(ip);

    if (isAdmin) { if (adminSocket === ws) adminSocket = null; return; }
    if (!currentRoomId || !clientId) return;

    const room = rooms.get(currentRoomId);
    if (!room) return;
    const participant = room.participants.get(clientId);
    if (!participant || participant.ws !== ws) return; // соединение вытеснено reconnect'ом

    // Неодобренного гостя убираем сразу; одобренному даём окно на reconnect.
    if (!participant.approved && !participant.isCreator) {
      finalizeLeave(room, currentRoomId, clientId);
      return;
    }

    participant.connected = false;
    if (participant.graceTimer) clearTimeout(participant.graceTimer);
    participant.graceTimer = setTimeout(() => {
      const r = rooms.get(currentRoomId!);
      const cur = r?.participants.get(clientId!);
      if (r && cur && !cur.connected) finalizeLeave(r, currentRoomId!, clientId!);
    }, GRACE_MS);
    sendStateToAdmin();
  });

  ws.on('error', (err) => log('error', 'ws_error', { connId, err: String(err) }));
});

// ---------------------------------------------------------------------------
// Heartbeat: раз в HEARTBEAT_MS пингуем всех; кто не ответил pong'ом — terminate
// ---------------------------------------------------------------------------
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if ((ws as any).isAlive === false) { ws.terminate(); return; }
    (ws as any).isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

// ---------------------------------------------------------------------------
// Отказоустойчивость процесса: логируем, но не роняем весь сервер (и все
// комнаты в RAM) из-за одной необработанной ошибки в одном соединении.
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
  log('error', 'unhandledRejection', { reason: String(reason) });
});
process.on('uncaughtException', (err) => {
  log('error', 'uncaughtException', { err: String(err) });
});

server.listen(PORT, '0.0.0.0', () => {
  log('info', 'server_started', { port: PORT });
  if (!TURN_SECRET || !TURN_URLS.length) {
    log('warn', 'turn_not_configured', { hint: 'set TURN_SECRET/TURN_URLS; only STUN available' });
  } else {
    log('info', 'turn_ready', { ttl: TURN_TTL, servers: TURN_URLS });
  }
});
