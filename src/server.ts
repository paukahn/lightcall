import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'my-super-secret-admin-token';
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

app.use(express.static(path.join(__dirname, '../public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

async function logToTelegram(message: string) {
  console.log(`[LOG]: ${message}`);
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  
  try {
    const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text: `🛡️ *LightCall Monitor*:\n${message}`,
        parse_mode: 'Markdown'
      })
    });
  } catch (err) {
    console.error('Ошибка отправки лога в Telegram:', err);
  }
}

interface Participant {
  id: string;
  name: string;
  ws: WebSocket;
  isCreator: boolean;
  approved: boolean;
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
      approved: p.approved
    }))
  }));

  adminSocket.send(JSON.stringify({ type: 'admin-state', rooms: roomsData }));
}

wss.on('connection', (ws: WebSocket) => {
  let currentRoomId: string | null = null;
  let clientId: string | null = null;
  let isAdmin = false;

  ws.on('message', async (message: string) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'admin-auth') {
        if (data.token === ADMIN_TOKEN) {
          isAdmin = true;
          adminSocket = ws;
          console.log('[Admin] Администратор успешно авторизован');
          sendStateToAdmin();
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Неверный токен админа' }));
          ws.close();
        }
        return;
      }

      if (isAdmin) {
        switch (data.type) {
          case 'admin-kick': {
            const { roomId, userId } = data;
            const room = rooms.get(roomId);
            if (room) {
              const participant = room.participants.get(userId);
              if (participant) {
                await logToTelegram(`🚫 Админ кикнул пользователя *${participant.name}* из комнаты *${room.name}*`);
                
                room.participants.forEach(p => {
                  if (p.id !== userId && p.approved && p.ws.readyState === WebSocket.OPEN) {
                    p.ws.send(JSON.stringify({ type: 'peer-left', peerId: userId }));
                  }
                });

                participant.ws.send(JSON.stringify({ type: 'error', message: 'Вы были исключены администратором.' }));
                room.participants.delete(userId);
                participant.ws.close();
                sendStateToAdmin();
              }
            }
            break;
          }

          case 'admin-make-creator': {
            const { roomId, userId } = data;
            const room = rooms.get(roomId);
            if (room) {
              room.participants.forEach(p => p.isCreator = (p.id === userId));
              await logToTelegram(`👑 Админ передал права создателя комнаты *${room.name}* пользователю *${room.participants.get(userId)?.name}*`);
              
              room.participants.forEach(p => {
                p.ws.send(JSON.stringify({ type: 'role-updated', isCreator: p.isCreator }));
              });
              sendStateToAdmin();
            }
            break;
          }

          case 'admin-mute-peer': {
            const { roomId, userId, mediaType } = data;
            const room = rooms.get(roomId);
            if (room) {
              const participant = room.participants.get(userId);
              if (participant && participant.ws.readyState === WebSocket.OPEN) {
                const deviceName = mediaType === 'audio' ? 'микрофон' : 'камеру';
                await logToTelegram(`🛡️ Админ принудительно выключил *${deviceName}* пользователю *${participant.name}* в комнате *${room.name}*`);
                
                participant.ws.send(JSON.stringify({ type: 'force-mute', mediaType }));

                room.participants.forEach(p => {
                  if (p.approved && p.ws.readyState === WebSocket.OPEN) {
                    const systemText = p.id === userId 
                      ? `Администратор системы отключил вам ${deviceName}.`
                      : `Администратор системы отключил ${deviceName} пользователю ${participant.name}.`;

                    p.ws.send(JSON.stringify({
                      type: 'chat-message',
                      senderName: 'Администрация',
                      text: systemText,
                      timestamp: new Date().toLocaleTimeString(),
                      isSystem: true
                    }));
                  }
                });
              }
            }
            break;
          }
        }
        return;
      }

      switch (data.type) {
        case 'create-room': {
          const { roomName, passwordHash, maxUsers, creatorName } = data;
          const roomId = crypto.randomBytes(16).toString('hex');
          const limit = Math.min(Math.max(parseInt(maxUsers) || 2, 2), 5);

          clientId = crypto.randomBytes(4).toString('hex');

          const creator: Participant = {
            id: clientId,
            name: creatorName || 'Создатель',
            ws,
            isCreator: true,
            approved: true
          };

          const newRoom: Room = {
            id: roomId,
            name: roomName,
            passwordHash,
            maxUsers: limit,
            participants: new Map([[clientId, creator]])
          };

          rooms.set(roomId, newRoom);
          currentRoomId = roomId;

          await logToTelegram(`🟢 Создана комната *${roomName}*\nСоздатель: *${creator.name}*\nЛимит: ${limit} участников.`);

          ws.send(JSON.stringify({ type: 'room-created', roomId, clientId, roomName }));
          sendStateToAdmin();
          break;
        }

        case 'join-room': {
          const { roomId, passwordHash, userName } = data;
          const room = rooms.get(roomId);

          if (!room) {
            ws.send(JSON.stringify({ type: 'error', message: 'Комната не найдена.' }));
            return;
          }

          if (room.participants.size >= room.maxUsers) {
            ws.send(JSON.stringify({ type: 'error', message: 'Комната заполнена.' }));
            return;
          }

          if (room.passwordHash !== passwordHash) {
            ws.send(JSON.stringify({ type: 'error', message: 'Неверный код доступа.' }));
            return;
          }

          clientId = crypto.randomBytes(4).toString('hex');
          
          const newParticipant: Participant = {
            id: clientId,
            name: userName || 'Гость',
            ws,
            isCreator: false,
            approved: false
          };

          room.participants.set(clientId, newParticipant);
          currentRoomId = roomId;

          await logToTelegram(`🚪 В дверь комнаты *${room.name}* постучался: *${newParticipant.name}*`);

          let creator: Participant | null = null;
          for (const p of room.participants.values()) {
            if (p.isCreator) { creator = p; break; }
          }

          if (creator && creator.ws.readyState === WebSocket.OPEN) {
            creator.ws.send(JSON.stringify({
              type: 'knock-knock',
              guestId: clientId,
              guestName: newParticipant.name
            }));
            ws.send(JSON.stringify({ type: 'waiting-approval', clientId }));
          } else {
            room.participants.delete(clientId);
            ws.send(JSON.stringify({ type: 'error', message: 'Создатель комнаты отсутствует.' }));
          }
          sendStateToAdmin();
          break;
        }

        case 'approve-guest': {
          const { guestId, approved } = data;
          if (!currentRoomId) return;

          const room = rooms.get(currentRoomId);
          if (!room) return;

          const guest = room.participants.get(guestId);
          if (!guest) return;

          if (approved) {
            guest.approved = true;
            await logToTelegram(`✅ Пользователь *${guest.name}* допущен в комнату *${room.name}*`);
            guest.ws.send(JSON.stringify({ type: 'join-approved', roomId: currentRoomId, clientId: guestId }));
          } else {
            await logToTelegram(`❌ Доступ пользователя *${guest.name}* в комнату *${room.name}* отклонён`);
            guest.ws.send(JSON.stringify({ type: 'join-rejected' }));
            room.participants.delete(guestId);
          }
          sendStateToAdmin();
          break;
        }

        case 'client-ready': {
          if (!currentRoomId || !clientId) return;
          const room = rooms.get(currentRoomId);
          if (!room) return;

          const me = room.participants.get(clientId);
          if (!me || !me.approved) return;

          console.log(`[Ready] Клиент ${me.name} (${clientId}) готов к связи.`);

          room.participants.forEach((participant) => {
            if (participant.id !== clientId && participant.approved && participant.ws.readyState === WebSocket.OPEN) {
              participant.ws.send(JSON.stringify({ 
                type: 'new-peer', 
                peerId: clientId, 
                peerName: me.name, 
                polite: false 
              }));
              
              me.ws.send(JSON.stringify({ 
                type: 'new-peer', 
                peerId: participant.id, 
                peerName: participant.name, 
                polite: true 
              }));
            }
          });
          break;
        }

        // --- ДОБАВЛЕНО: Обработка старта новой презентации экрана ---
        case 'screen-share-started': {
          if (!currentRoomId || !clientId) return;
          const room = rooms.get(currentRoomId);
          if (!room) return;

          const sender = room.participants.get(clientId);
          if (!sender || !sender.approved) return;

          await logToTelegram(`🖥️ Участник *${sender.name}* запустил трансляцию экрана в комнате *${room.name}*`);

          // Сообщаем всем пирам в комнате, чтобы они загасили свой скриншейринг
          room.participants.forEach(p => {
            if (p.approved && p.ws.readyState === WebSocket.OPEN) {
              p.ws.send(JSON.stringify({
                type: 'screen-share-announced',
                sharerId: clientId
              }));
            }
          });
          break;
        }

        case 'moderator-mute-peer': {
          if (!currentRoomId) return;
          const room = rooms.get(currentRoomId);
          if (!room) return;

          const sender = room.participants.get(clientId!);
          if (!sender || !sender.isCreator) return;

          const { targetPeerId, mediaType } = data; 
          const targetPeer = room.participants.get(targetPeerId);

          if (targetPeer && targetPeer.ws.readyState === WebSocket.OPEN) {
            const deviceName = mediaType === 'audio' ? 'микрофон' : 'камеру';
            await logToTelegram(`⚠️ Создатель *${sender.name}* принудительно выключил *${deviceName}* пользователю *${targetPeer.name}*`);
            
            targetPeer.ws.send(JSON.stringify({ type: 'force-mute', mediaType }));

            room.participants.forEach(p => {
              if (p.approved && p.ws.readyState === WebSocket.OPEN) {
                let systemText = '';
                if (p.id === targetPeerId) {
                  systemText = `Создатель комнаты отключил вам ${deviceName}.`;
                } else if (p.id === sender.id) {
                  systemText = `Вы отключили ${deviceName} пользователю ${targetPeer.name}.`;
                } else {
                  systemText = `Создатель комнаты отключил ${deviceName} пользователю ${targetPeer.name}.`;
                }

                p.ws.send(JSON.stringify({
                  type: 'chat-message',
                  senderName: 'Система',
                  text: systemText,
                  timestamp: new Date().toLocaleTimeString(),
                  isSystem: true
                }));
              }
            });
          }
          break;
        }

        case 'relay-sdp':
        case 'relay-ice': {
          if (!currentRoomId) return;
          const room = rooms.get(currentRoomId);
          if (!room) return;

          const { targetPeerId } = data;
          const targetPeer = room.participants.get(targetPeerId);

          if (targetPeer && targetPeer.approved && targetPeer.ws.readyState === WebSocket.OPEN) {
            data.senderPeerId = clientId;
            targetPeer.ws.send(JSON.stringify(data));
          }
          break;
        }

        case 'chat-message': {
          if (!currentRoomId) return;
          const room = rooms.get(currentRoomId);
          if (!room) return;

          const sender = room.participants.get(clientId!);
          if (!sender || !sender.approved) return;

          for (const participant of room.participants.values()) {
            if (participant.approved && participant.ws.readyState === WebSocket.OPEN) {
              participant.ws.send(JSON.stringify({
                type: 'chat-message',
                senderName: sender.name,
                text: data.text,
                timestamp: new Date().toLocaleTimeString(),
                isSystem: false
              }));
            }
          }
          break;
        }
      }
    } catch (err) {
      console.error('[Server] Ошибка:', err);
    }
  });

  ws.on('close', async () => {
    if (isAdmin) {
      adminSocket = null;
      return;
    }

    if (currentRoomId && clientId) {
      const room = rooms.get(currentRoomId);
      if (room) {
        const participant = room.participants.get(clientId);
        
        if (participant) {
          const name = participant.name;
          room.participants.delete(clientId);
          await logToTelegram(`🚪 Участник *${name}* покинул комнату *${room.name}*`);

          if (room.participants.size === 0) {
            rooms.delete(currentRoomId);
            await logToTelegram(`🗑️ Комната *${room.name}* опустела и удалена из памяти.`);
          } else {
            if (participant.isCreator) {
              const nextCreator = Array.from(room.participants.values()).find(p => p.approved);
              if (nextCreator) {
                nextCreator.isCreator = true;
                await logToTelegram(`👑 Создатель вышел. Новым создателем комнаты *${room.name}* назначен *${nextCreator.name}*`);
                nextCreator.ws.send(JSON.stringify({ type: 'role-updated', isCreator: true }));
              }
            }

            for (const p of room.participants.values()) {
              if (p.approved && p.ws.readyState === WebSocket.OPEN) {
                p.ws.send(JSON.stringify({ type: 'peer-left', peerId: clientId }));
              }
            }
          }
        }
        sendStateToAdmin();
      }
    }
  });
});

server.listen(port, () => {
  console.log(`[Server] Сервер запущен на порту ${port}`);
});