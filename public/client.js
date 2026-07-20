let socket;
let localStream;
let myClientId = null;
let currentRoomId = null;
let isCreator = false;
let peerConnections = new Map();
let screenStream = null;

// Состояния Perfect Negotiation для предотвращения конфликтов сигнализации
const makingOffer = new Map();
const ignoreOffer = new Map();

// Локальное безопасное хранение хэша текущей комнаты
let currentRoomPasswordHash = '';

// Надежные STUN-серверы, работающие без сбоев
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.3cx.com:3478' },
        { urls: 'stun:stun.linphone.org:3478' },
        { urls: 'stun:stun.ekiga.net:3478' },
        { urls: 'stun:stun.ideasip.com:3478' },
        { urls: 'stun:stun.sipgate.net:3478' },
        { urls: 'stun:stun.sipnet.net:3478' },
        { urls: 'stun:stun.voiparound.com:3478' },
        { urls: 'stun:stun.voipbuster.com:3478' },
        { urls: 'stun:stun.voipstunt.com:3478' },
        { urls: 'stun:stun.voxgratia.org:3478' },
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// Хеширование паролей
async function sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function clearRoomForms() {
    const fields = [
        'create-name', 'create-room-name', 'create-password', 
        'join-user-name', 'join-room-id', 'join-password'
    ];
    fields.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.value = '';
            el.disabled = false;
        }
    });
    currentRoomPasswordHash = '';
}

// --- ИНИЦИАЛИЗАЦИЯ ПРИ ЗАГРУЗКЕ ---
window.onload = () => {
    clearRoomForms();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${window.location.host}`);

    socket.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        console.log('[Signaling] Входящее сообщение:', data.type, data);

        switch (data.type) {
            case 'room-created':
                myClientId = data.clientId;
                currentRoomId = data.roomId;
                isCreator = true;
                
                const preCam = document.getElementById('pre-cam')?.checked !== false;
                const preMic = document.getElementById('pre-mic')?.checked !== false;
                
                await showCallScreen(preCam, preMic);
                showShareBar();
                break;

            case 'waiting-approval':
                myClientId = data.clientId;
                showScreen('lobby-screen');
                break;

            case 'knock-knock':
                showKnockModal(data.guestId, data.guestName);
                break;

            case 'join-approved':
                currentRoomId = data.roomId;
                myClientId = data.clientId;
                
                const joinCam = document.getElementById('join-pre-cam')?.checked !== false;
                const joinMic = document.getElementById('join-pre-mic')?.checked !== false;
                
                await showCallScreen(joinCam, joinMic);
                sendSignaling({ type: 'client-ready' });
                break;

            case 'join-rejected':
                alert('Создатель отклонил ваш запрос на вход.');
                location.reload();
                break;

            case 'role-updated':
                isCreator = data.isCreator;
                updateModToolsVisibility();
                break;

            case 'new-peer':
                if (data.peerId !== myClientId) {
                    await handleNewPeer(data.peerId, data.peerName, data.polite);
                }
                break;

            case 'relay-sdp': {
                const { senderPeerId, sdp } = data;
                const pc = peerConnections.get(senderPeerId);
                if (!pc) return;
                const polite = data.polite || false; 

                try {
                    const offerCollision = (sdp.type === 'offer') && 
                                           (makingOffer.get(senderPeerId) || pc.signalingState !== 'stable');

                    ignoreOffer.set(senderPeerId, !polite && offerCollision);
                    
                    if (ignoreOffer.get(senderPeerId)) {
                        console.log(`[WebRTC] Игнорируем входящий Offer от невежливого пира ${senderPeerId}`);
                        return;
                    }

                    await pc.setRemoteDescription(new RTCSessionDescription(sdp));

                    if (sdp.type === 'offer') {
                        const answer = await pc.createAnswer();
                        await pc.setLocalDescription(answer);
                        sendSignaling({
                            type: 'relay-sdp',
                            targetPeerId: senderPeerId,
                            sdp: pc.localDescription
                        });
                    }
                } catch (err) {
                    console.error(`[WebRTC] Ошибка обработки SDP от ${senderPeerId}:`, err);
                }
                break;
            }

            case 'relay-ice': {
                const { senderPeerId, candidate } = data;
                const pc = peerConnections.get(senderPeerId);
                if (!pc) return;

                try {
                    if (candidate) {
                        await pc.addIceCandidate(new RTCIceCandidate(candidate));
                    }
                } catch (err) {
                    if (!ignoreOffer.get(senderPeerId)) {
                        console.error(`[WebRTC] Ошибка добавления ICE от ${senderPeerId}:`, err);
                    }
                }
                break;
            }

            case 'peer-left':
                removePeer(data.peerId);
                break;

            case 'force-mute':
                handleForceMute(data.mediaType);
                break;

            case 'chat-message':
                appendChatMessage(data.senderName, data.text, data.timestamp, data.isSystem);
                break;

            // --- ДОБАВЛЕНО: Кто-то другой начал трансляцию экрана ---
            case 'screen-share-announced':
                if (data.sharerId !== myClientId && screenStream) {
                    console.log('[ScreenShare] Кто-то другой начал трансляцию экрана. Отключаем свою.');
                    stopScreenShare();
                    appendChatMessage('Система', 'Ваша трансляция экрана остановлена, так как другой участник начал свою презентацию.', new Date().toLocaleTimeString(), true);
                }
                break;

            case 'error':
                alert(data.message);
                location.reload();
                break;
        }
    };

    const hash = window.location.hash.substring(1);
    if (hash) {
        switchTab('join');
        if (hash.includes(':')) {
            const [roomId, incomingHash] = hash.split(':');
            const idInput = document.getElementById('join-room-id');
            const passInput = document.getElementById('join-password');

            if (idInput) idInput.value = roomId;
            currentRoomPasswordHash = incomingHash;

            if (passInput) {
                passInput.value = '••••••••••••••••';
                passInput.disabled = true;
            }
        } else {
            const idInput = document.getElementById('join-room-id');
            if (idInput) idInput.value = hash;
        }
    }
};

function sendSignaling(payload) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
    }
}

// Инициализация медиа с созданием заглушек при отсутствии треков
async function initMedia(startVideo, startAudio) {
    try {
        localStream = new MediaStream();

        if (!startVideo && !startAudio) {
            console.log('[Media] Вход в режиме "Слушатель".');
            updateButtonUI('btn-mic', false);
            updateButtonUI('btn-cam', false);
            showLocalAvatarPlaceholder(true);
            return;
        }

        const constraints = { video: startVideo, audio: startAudio };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        
        stream.getTracks().forEach(track => {
            localStream.addTrack(track);
        });

        const localVideo = document.getElementById('local-video');
        if (localVideo && startVideo) {
            localVideo.srcObject = localStream;
            showLocalAvatarPlaceholder(false);
        } else {
            showLocalAvatarPlaceholder(true);
        }

        updateButtonUI('btn-mic', startAudio);
        updateButtonUI('btn-cam', startVideo);

    } catch (err) {
        console.warn('Предупреждение медиа-доступа при входе:', err);
        updateButtonUI('btn-mic', false);
        updateButtonUI('btn-cam', false);
        showLocalAvatarPlaceholder(true);
    }
}

function showLocalAvatarPlaceholder(show) {
    const placeholder = document.getElementById('local-avatar-placeholder');
    const localVideo = document.getElementById('local-video');
    const localContainer = document.querySelector('.video-container.local');

    if (!placeholder) {
        const newPlaceholder = document.createElement('div');
        newPlaceholder.className = 'video-avatar-placeholder';
        newPlaceholder.id = 'local-avatar-placeholder';
        newPlaceholder.innerHTML = `
            <div class="avatar-circle" style="background-color: #555; width: 80px; height: 80px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 32px; color: white; font-weight: bold; margin: auto;">
                Я
            </div>
        `;
        if (localContainer) {
            localContainer.insertBefore(newPlaceholder, localVideo);
            // Добавляем кнопку масштабирования и для локального окна
            addZoomButton(localContainer);
        }
    }

    const currentPlaceholder = document.getElementById('local-avatar-placeholder');
    if (show) {
        currentPlaceholder?.classList.remove('hidden');
        localVideo?.classList.add('hidden');
        localContainer?.classList.add('video-muted');
    } else {
        currentPlaceholder?.classList.add('hidden');
        localVideo?.classList.remove('hidden');
        localContainer?.classList.remove('video-muted');
    }
}

// --- ДОБАВЛЕНО: Кнопка масштабирования (Zoom) ---
function addZoomButton(container) {
    if (container.querySelector('.btn-zoom-tile')) return;

    const zoomBtn = document.createElement('button');
    zoomBtn.className = 'btn-zoom-tile';
    zoomBtn.innerHTML = '⛶';
    zoomBtn.title = 'Развернуть плитку';
    zoomBtn.style.cssText = `
        position: absolute;
        top: 8px;
        right: 8px;
        background: rgba(0, 0, 0, 0.6);
        border: none;
        color: white;
        border-radius: 4px;
        width: 28px;
        height: 28px;
        cursor: pointer;
        z-index: 10;
        font-weight: bold;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s;
    `;

    zoomBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        
        const isMaximized = container.classList.contains('maximized');
        
        // Снимаем максимизацию со всех остальных окон
        document.querySelectorAll('.video-container').forEach(el => {
            el.classList.remove('maximized');
            const btn = el.querySelector('.btn-zoom-tile');
            if (btn) btn.innerHTML = '⛶';
        });

        if (!isMaximized) {
            container.classList.add('maximized');
            zoomBtn.innerHTML = '🗗';
            zoomBtn.title = 'Свернуть плитку';
        } else {
            zoomBtn.innerHTML = '⛶';
            zoomBtn.title = 'Развернуть плитку';
        }
    });

    container.appendChild(zoomBtn);
}

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    const target = document.getElementById(screenId);
    if (target) target.classList.remove('hidden');
}

async function showCallScreen(startVideo, startAudio) {
    showScreen('call-screen');
    await initMedia(startVideo, startAudio);
    updateModToolsVisibility();
}

function switchTab(tab) {
    const tabCreate = document.getElementById('tab-create');
    const tabJoin = document.getElementById('tab-join');
    const formCreate = document.getElementById('form-create');
    const formJoin = document.getElementById('form-join');

    if (tab === 'create') {
        tabCreate?.classList.add('active');
        tabJoin?.classList.remove('active');
        formCreate?.classList.remove('hidden');
        formJoin?.classList.add('hidden');
    } else {
        tabCreate?.classList.remove('active');
        tabJoin?.classList.add('active');
        formCreate?.classList.add('hidden');
        formJoin?.classList.remove('hidden');
    }
}

function showShareBar() {
    const shareBar = document.getElementById('share-bar');
    if (shareBar && isCreator) {
        shareBar.classList.remove('hidden');
    }
}

function copyInviteLink() {
    if (!currentRoomId || !currentRoomPasswordHash) return;
    const inviteUrl = `${window.location.origin}/#${currentRoomId}:${currentRoomPasswordHash}`;
    navigator.clipboard.writeText(inviteUrl).then(() => {
        const btn = document.getElementById('btn-copy-link');
        if (btn) {
            btn.innerText = '✅ Ссылка скопирована!';
            setTimeout(() => { btn.innerText = '📋 Скопировать ссылку'; }, 2000);
        }
    }).catch(err => {
        console.error('Не удалось скопировать ссылку:', err);
    });
}

async function createRoom() {
    const creatorName = document.getElementById('create-name')?.value.trim();
    const roomName = document.getElementById('create-room-name')?.value.trim();
    const password = document.getElementById('create-password')?.value;
    const maxUsers = document.getElementById('create-limit')?.value || 2;

    if (!roomName || !password) {
        alert('Пожалуйста, заполните название комнаты и код доступа.');
        return;
    }

    currentRoomPasswordHash = await sha256(password);

    sendSignaling({
        type: 'create-room',
        roomName,
        passwordHash: currentRoomPasswordHash,
        maxUsers,
        creatorName: creatorName || 'Создатель'
    });
}

async function joinRoomManual() {
    const userName = document.getElementById('join-user-name')?.value.trim();
    const roomId = document.getElementById('join-room-id')?.value.trim();
    const passwordInput = document.getElementById('join-password');
    const password = passwordInput?.value;

    if (!roomId) {
        alert('Пожалуйста, введите ID комнаты.');
        return;
    }

    if (!currentRoomPasswordHash) {
        if (!password) {
            alert('Пожалуйста, введите код доступа.');
            return;
        }
        currentRoomPasswordHash = await sha256(password);
    }

    sendSignaling({
        type: 'join-room',
        roomId,
        passwordHash: currentRoomPasswordHash,
        userName: userName || 'Гость'
    });
}

// --- СВЯЗЬ WEBRTC И ПЛИТКИ ---
async function handleNewPeer(peerId, peerName, polite) {
    if (peerConnections.has(peerId)) return;

    console.log(`[WebRTC] Создаем соединение с ${peerName}. Роль polite: ${polite}`);
    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections.set(peerId, pc);
    makingOffer.set(peerId, false);
    ignoreOffer.set(peerId, false);

    if (!polite) {
        pc.createDataChannel('sig-assistance-channel');
    }

    pc.ondatachannel = (event) => {
        console.log(`[WebRTC] Получен вспомогательный канал данных от ${peerName}`);
    };

    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    if (!document.getElementById(`video-${peerId}`)) {
        const remoteStream = new MediaStream();
        createPeerTile(peerId, peerName, remoteStream);
        
        const placeholder = document.getElementById(`avatar-placeholder-${peerId}`);
        if (placeholder) {
            placeholder.classList.remove('hidden');
        }
        const videoEl = document.getElementById(`video-${peerId}`);
        if (videoEl) {
            videoEl.classList.add('hidden');
        }
    }

    const remoteStream = new MediaStream();
    
    pc.ontrack = (event) => {
        console.log(`[WebRTC] Получен трек от ${peerName}:`, event.track.kind);
        event.streams[0].getTracks().forEach(track => remoteStream.addTrack(track));
        
        const videoEl = document.getElementById(`video-${peerId}`);
        const placeholder = document.getElementById(`avatar-placeholder-${peerId}`);

        if (event.track.kind === 'video') {
            if (videoEl) {
                videoEl.srcObject = remoteStream;
                videoEl.classList.remove('hidden');
            }
            if (placeholder) {
                placeholder.classList.add('hidden');
            }
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            sendSignaling({
                type: 'relay-ice',
                targetPeerId: peerId,
                candidate: event.candidate
            });
        }
    };

    pc.onnegotiationneeded = async () => {
        try {
            makingOffer.set(peerId, true);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            sendSignaling({
                type: 'relay-sdp',
                targetPeerId: peerId,
                sdp: pc.localDescription,
                polite: !polite
            });
        } catch (err) {
            console.error('[WebRTC] Ошибка при onnegotiationneeded:', err);
        } finally {
            makingOffer.set(peerId, false);
        }
    };
}

function createPeerTile(peerId, peerName, remoteStream) {
    const grid = document.getElementById('video-grid');
    if (document.getElementById(`video-container-${peerId}`)) return;

    const container = document.createElement('div');
    container.className = 'video-container';
    container.id = `video-container-${peerId}`;

    // Создаем аватар-заглушку
    const placeholder = document.createElement('div');
    placeholder.className = 'video-avatar-placeholder';
    placeholder.id = `avatar-placeholder-${peerId}`;
    
    const colors = ['#007bff', '#28a745', '#e83e8c', '#fd7e14', '#6f42c1', '#17a2b8'];
    const charCodeSum = peerName.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const randomColor = colors[charCodeSum % colors.length];

    placeholder.innerHTML = `
        <div class="avatar-circle" style="background-color: ${randomColor}; width: 80px; height: 80px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 32px; color: white; font-weight: bold; margin: auto;">
            ${peerName.charAt(0).toUpperCase()}
        </div>
    `;
    container.appendChild(placeholder);

    const video = document.createElement('video');
    video.id = `video-${peerId}`;
    video.autoplay = true;
    video.playsinline = true;
    
    if (remoteStream && remoteStream.getVideoTracks().length > 0) {
        video.srcObject = remoteStream;
        placeholder.classList.add('hidden');
    } else {
        video.classList.add('hidden');
    }

    const label = document.createElement('div');
    label.className = 'video-label';
    label.innerHTML = `
        <span class="peer-name-text">${peerName}</span>
        <span class="mic-status-indicator hidden" id="mic-indicator-${peerId}" title="Микрофон выключен" style="margin-left: 6px; color: #ff4a4a; vertical-align: middle;">🎙️📴</span>
    `;

    container.appendChild(video);
    container.appendChild(label);

    // Добавляем функционал зума на плитку пира
    addZoomButton(container);

    if (isCreator) {
        const modTools = document.createElement('div');
        modTools.className = 'mod-tools';
        modTools.innerHTML = `
            <button onclick="mutePeerRemote('${peerId}', 'audio')" title="Заглушить" style="background: rgba(0,0,0,0.6); border: none; color: white; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 12px; margin-right: 4px;">🔇</button>
            <button onclick="mutePeerRemote('${peerId}', 'video')" title="Выключить видео" style="background: rgba(0,0,0,0.6); border: none; color: white; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 12px;">🚫📷</button>
        `;
        container.appendChild(modTools);
    }

    grid.appendChild(container);
}

function removePeer(peerId) {
    const pc = peerConnections.get(peerId);
    if (pc) {
        pc.close();
        peerConnections.delete(peerId);
        makingOffer.delete(peerId);
        ignoreOffer.delete(peerId);
    }
    const container = document.getElementById(`video-container-${peerId}`);
    if (container) {
        container.remove();
    }
}

// --- Динамическое включение/выключение микрофона ---
async function toggleMic() {
    if (!localStream) return;
    let track = localStream.getAudioTracks()[0];

    if (!track) {
        try {
            console.log('[Media] Микрофон не инициализирован. Запрос аудио-доступа...');
            const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const newTrack = tempStream.getAudioTracks()[0];
            
            localStream.addTrack(newTrack);
            track = newTrack;

            peerConnections.forEach((pc) => {
                pc.addTrack(newTrack, localStream);
            });
        } catch (err) {
            console.error('[Media] Ошибка активации микрофона:', err);
            alert('Не удалось получить доступ к микрофону.');
            return;
        }
    } else {
        track.enabled = !track.enabled;
    }

    updateButtonUI('btn-mic', track.enabled);

    sendSignaling({
        type: 'media-state-change',
        roomId: currentRoomId,
        mediaType: 'audio',
        enabled: track.enabled
    });
}

// --- Динамическое включение/выключение камеры ---
async function toggleCam() {
    if (!localStream) return;
    let track = localStream.getVideoTracks()[0];

    if (!track) {
        try {
            console.log('[Media] Камера не инициализирована. Запрос видео-доступа...');
            const tempStream = await navigator.mediaDevices.getUserMedia({ video: true });
            const newTrack = tempStream.getVideoTracks()[0];
            
            localStream.addTrack(newTrack);
            track = newTrack;

            const localVideo = document.getElementById('local-video');
            if (localVideo) {
                localVideo.srcObject = localStream;
            }

            peerConnections.forEach((pc) => {
                pc.addTrack(newTrack, localStream);
            });
        } catch (err) {
            console.error('[Media] Ошибка активации камеры:', err);
            alert('Не удалось получить доступ к камере.');
            return;
        }
    } else {
        track.enabled = !track.enabled;
    }

    updateButtonUI('btn-cam', track.enabled);
    showLocalAvatarPlaceholder(!track.enabled);

    sendSignaling({
        type: 'media-state-change',
        roomId: currentRoomId,
        mediaType: 'video',
        enabled: track.enabled
    });
}

function updateButtonUI(btnId, isEnabled) {
    const btn = document.getElementById(btnId);
    if (!btn) return;

    const iconOn = btn.querySelector('.icon-on');
    const iconOff = btn.querySelector('.icon-off');

    if (isEnabled) {
        btn.classList.remove('off');
        iconOn?.classList.remove('hidden');
        iconOff?.classList.add('hidden');
    } else {
        btn.classList.add('off');
        iconOn?.classList.add('hidden');
        iconOff?.classList.remove('hidden');
    }
}

function handleForceMute(mediaType) {
    if (!localStream) return;
    const track = mediaType === 'audio' ? localStream.getAudioTracks()[0] : localStream.getVideoTracks()[0];
    if (track && track.enabled) {
        if (mediaType === 'audio') toggleMic();
        else toggleCam();
    }
}

function mutePeerRemote(peerId, mediaType) {
    if (isCreator) {
        sendSignaling({
            type: 'moderator-mute-peer',
            targetPeerId: peerId,
            mediaType
        });
    }
}

// --- УПРАВЛЕНИЕ UI СТУКА (KNOCK-KNOCK) ---
function showKnockModal(guestId, guestName) {
    const modal = document.getElementById('knock-modal');
    const msg = document.getElementById('knock-msg');
    const btnApprove = document.getElementById('btn-approve');
    const btnReject = document.getElementById('btn-reject');

    if (!modal || !msg) return;

    msg.innerText = `Пользователь ${guestName} хочет подключиться к этой комнате.`;
    modal.classList.remove('hidden');

    btnApprove.onclick = () => {
        sendSignaling({ type: 'approve-guest', guestId, approved: true });
        modal.classList.add('hidden');
    };

    btnReject.onclick = () => {
        sendSignaling({ type: 'approve-guest', guestId, approved: false });
        modal.classList.add('hidden');
    };
}

function updateModToolsVisibility() {
    document.querySelectorAll('.mod-tools').forEach(el => {
        if (isCreator) el.classList.remove('hidden');
        else el.classList.add('hidden');
    });
}

// --- ЧАТ КОМНАТЫ ---
function toggleChat() {
    const chatContainer = document.querySelector('.chat-container');
    const chatBtn = document.getElementById('btn-chat-toggle');
    if (chatContainer) {
        chatContainer.classList.toggle('hidden');
        chatBtn?.classList.toggle('active');
    }
}

function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const text = input?.value.trim();
    if (!text) return;

    sendSignaling({ type: 'chat-message', text });
    input.value = '';
}

function handleChatKey(event) {
    if (event.key === 'Enter') {
        sendChatMessage();
    }
}

function appendChatMessage(senderName, text, timestamp, isSystem = false) {
    const feed = document.getElementById('chat-messages');
    if (!feed) return;

    const msg = document.createElement('div');
    
    if (isSystem || senderName === 'Система' || senderName === 'Администрация') {
        msg.className = 'chat-message system-message';
        msg.innerHTML = `
            <div class="chat-text" style="color: #ffb74d; font-style: italic; font-size: 12px; text-align: center; margin: 6px 0; background: rgba(255,183,77,0.05); padding: 4px; border-radius: 4px;">
                📢 ${text} <span style="font-size: 9px; color: #888; margin-left: 5px;">${timestamp}</span>
            </div>
        `;
    } else {
        msg.className = 'chat-message';
        msg.innerHTML = `
            <div class="chat-meta" style="font-size: 11px; color: #888; margin-bottom: 2px;">
                <strong style="color: #007bff;">${senderName}</strong> <span style="float: right;">${timestamp}</span>
            </div>
            <div class="chat-text" style="background: rgba(255,255,255,0.05); padding: 6px 10px; border-radius: 6px; word-break: break-all;">${text}</div>
        `;
    }
    
    feed.appendChild(msg);
    feed.scrollTop = feed.scrollHeight;
}

// --- СОВМЕСТНЫЙ ДОСТУП К ЭКРАНУ ---
async function toggleScreenShare() {
    const shareBtn = document.getElementById('btn-screen-share');
    
    if (screenStream) {
        stopScreenShare();
        return;
    }

    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: { cursor: "always" },
            audio: false
        });

        const screenTrack = screenStream.getVideoTracks()[0];

        // --- УВЕДОМЛЯЕМ ВСЕХ: Мы начинаем новую трансляцию (сбросит чужую демонстрацию) ---
        sendSignaling({
            type: 'screen-share-started',
            roomId: currentRoomId
        });

        peerConnections.forEach((pc) => {
            const senders = pc.getSenders();
            const videoSender = senders.find(s => s.track && s.track.kind === 'video');
            if (videoSender) {
                videoSender.replaceTrack(screenTrack);
            }
        });

        const localVideo = document.getElementById('local-video');
        if (localVideo) {
            localVideo.srcObject = screenStream;
            showLocalAvatarPlaceholder(false);
        }

        shareBtn?.classList.add('active');

        screenTrack.onended = () => {
            stopScreenShare();
        };

        console.log('[ScreenShare] Трансляция экрана успешно запущена.');

    } catch (err) {
        console.error('Ошибка при попытке захвата экрана:', err);
        screenStream = null;
        shareBtn?.classList.remove('active');
    }
}

async function stopScreenShare() {
    const shareBtn = document.getElementById('btn-screen-share');
    if (!screenStream) return;

    console.log('[ScreenShare] Остановка трансляции экрана, возвращаем камеру.');

    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;

    shareBtn?.classList.remove('active');

    if (localStream) {
        const cameraTrack = localStream.getVideoTracks()[0];
        
        peerConnections.forEach((pc) => {
            const senders = pc.getSenders();
            const videoSender = senders.find(s => s.track && s.track.kind === 'video');
            if (videoSender && cameraTrack) {
                videoSender.replaceTrack(cameraTrack);
            }
        });

        const localVideo = document.getElementById('local-video');
        if (localVideo) {
            if (cameraTrack && cameraTrack.enabled) {
                localVideo.srcObject = localStream;
                showLocalAvatarPlaceholder(false);
            } else {
                showLocalAvatarPlaceholder(true);
            }
        }
    } else {
        showLocalAvatarPlaceholder(true);
    }
}

function leaveCall() {
    if (confirm('Вы уверены, что хотите выйти из звонка?')) {
        location.reload();
    }
}