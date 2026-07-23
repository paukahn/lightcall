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

// Мониторинг качества связи по getStats()
const statsTimers = new Map();

// Текущее состояние медиа каждого пира: peerId -> { audio: bool, video: bool }
const peerMediaState = new Map();

// Сессия для переподключения без повторного одобрения
let sessionToken = null;
let manualLeave = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let inCall = false;

// Выбранные устройства (mic/cam/speaker)
let selectedMicId = null, selectedCamId = null, selectedSpeakerId = null;

// Зелёная комната / индикатор уровня
let previewStream = null;
let audioCtx = null, meterRAF = null;

// Wake Lock
let wakeLock = null;

// Локальное безопасное хранение хэша текущей комнаты
let currentRoomPasswordHash = '';

// ICE-конфиг (STUN + TURN) запрашивается у сервера (TURN REST creds)
let cachedRtcConfig = null;
// Запасные STUN на случай, если запрос конфига к серверу не прошёл: несколько
// независимых серверов повышают шанс собрать srflx-кандидат, если один недоступен.
const FALLBACK_RTC = {
    iceServers: [{
        urls: [
            'stun:stun.l.google.com:19302',
            'stun:stun1.l.google.com:19302',
            'stun:stun.cloudflare.com:3478'
        ]
    }]
};

// Хоть раз получили relay-кандидат от TURN — значит TURN реально доступен.
// Нужно, чтобы отличить «TURN не настроен» от «TURN настроен, но недоступен».
let sawRelayCandidate = false;

// Есть ли в текущем ICE-конфиге хотя бы один TURN-сервер (turn:/turns:).
function rtcConfigHasTurn(cfg) {
    const servers = (cfg && cfg.iceServers) || [];
    return servers.some(s => {
        const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
        return urls.some(u => typeof u === 'string' && /^turns?:/i.test(u));
    });
}

async function getRtcConfig() {
    if (cachedRtcConfig) return cachedRtcConfig;
    try {
        const res = await fetch('/api/ice-servers', { cache: 'no-store' });
        const cfg = await res.json();
        cachedRtcConfig = (cfg && Array.isArray(cfg.iceServers) && cfg.iceServers.length) ? cfg : FALLBACK_RTC;
    } catch (err) {
        console.warn('[ICE] Не удалось получить конфиг с сервера, fallback на STUN:', err);
        cachedRtcConfig = FALLBACK_RTC;
    }
    return cachedRtcConfig;
}

// ---------------------------------------------------------------------------
// Констрейнты медиа: явные AEC/NS/AGC + выбранное устройство
// ---------------------------------------------------------------------------
function audioConstraints() {
    const c = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (selectedMicId) c.deviceId = { exact: selectedMicId };
    return c;
}
function videoConstraints() {
    const c = { width: { ideal: 1280 }, height: { ideal: 720 } };
    if (selectedCamId) c.deviceId = { exact: selectedCamId };
    return c;
}

// Хеширование паролей
async function sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function clearRoomForms() {
    ['create-name', 'create-room-name', 'create-password', 'join-user-name', 'join-room-id', 'join-password']
        .forEach(id => { const el = document.getElementById(id); if (el) { el.value = ''; el.disabled = false; } });
    currentRoomPasswordHash = '';
}

// --- ИНИЦИАЛИЗАЦИЯ ПРИ ЗАГРУЗКЕ ---
window.onload = () => {
    clearRoomForms();
    getRtcConfig();
    connectSocket();

    window.addEventListener('online', handleNetworkChange);
    if (navigator.connection && navigator.connection.addEventListener) {
        navigator.connection.addEventListener('change', () => {
            peerConnections.forEach(pc => { try { pc.restartIce(); } catch (e) {} });
        });
    }
    // Wake Lock переустанавливается, когда вкладка снова становится активной
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && inCall && !wakeLock) requestWakeLock();
    });
    // Закрытие вкладки / перезагрузка = осознанный выход: освобождаем слот сразу.
    // (При обрыве сети это событие не срабатывает — там остаётся grace на reconnect.)
    window.addEventListener('pagehide', () => {
        if (inCall) { try { sendSignaling({ type: 'leave' }); } catch (e) {} }
    });

    const hash = window.location.hash.substring(1);
    if (hash) {
        switchTab('join');
        if (hash.includes(':')) {
            const [roomId, incomingHash] = hash.split(':');
            const idInput = document.getElementById('join-room-id');
            const passInput = document.getElementById('join-password');
            if (idInput) idInput.value = roomId;
            currentRoomPasswordHash = incomingHash;
            if (passInput) { passInput.value = '••••••••••••••••'; passInput.disabled = true; }
        } else {
            const idInput = document.getElementById('join-room-id');
            if (idInput) idInput.value = hash;
        }
    }
};

// --- WEBSOCKET С АВТО-ПЕРЕПОДКЛЮЧЕНИЕМ ---
function connectSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${window.location.host}`);

    socket.onopen = () => {
        reconnectAttempts = 0;
        showReconnectBanner(false);
        if (sessionToken && inCall) sendSignaling({ type: 'rejoin', sessionToken });
    };
    socket.onmessage = (event) => { handleSignal(JSON.parse(event.data)); };
    socket.onclose = () => { if (!manualLeave && sessionToken && inCall) scheduleReconnect(); };
    socket.onerror = () => { try { socket.close(); } catch (e) {} };
}

function scheduleReconnect() {
    if (manualLeave || !sessionToken) return;
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, Math.min(reconnectAttempts, 4)), 15000);
    showReconnectBanner(true, `Переподключение... (попытка ${reconnectAttempts})`);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectSocket, delay);
}

function handleNetworkChange() {
    peerConnections.forEach(pc => { try { pc.restartIce(); } catch (e) {} });
    if (inCall && (!socket || socket.readyState !== WebSocket.OPEN)) connectSocket();
}

// --- РОУТЕР СИГНАЛЬНЫХ СООБЩЕНИЙ ---
async function handleSignal(data) {
    console.log('[Signaling] Входящее:', data.type);

    switch (data.type) {
        case 'room-created':
            myClientId = data.clientId;
            currentRoomId = data.roomId;
            isCreator = true;
            sessionToken = data.sessionToken;
            inCall = true;
            await showCallScreen(
                document.getElementById('pre-cam')?.checked !== false,
                document.getElementById('pre-mic')?.checked !== false
            );
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
            sessionToken = data.sessionToken;
            inCall = true;
            await showCallScreen(
                document.getElementById('join-pre-cam')?.checked !== false,
                document.getElementById('join-pre-mic')?.checked !== false
            );
            sendSignaling({ type: 'client-ready' });
            break;

        case 'join-rejected':
            alert('Создатель отклонил ваш запрос на вход.');
            location.reload();
            break;

        case 'rejoined':
            isCreator = data.isCreator;
            sessionToken = data.sessionToken;
            showReconnectBanner(false);
            peerConnections.forEach((_, id) => removePeer(id));
            updateModToolsVisibility();
            break;

        case 'rejoin-failed':
            sessionToken = null;
            inCall = false;
            alert(data.message || 'Сессия истекла, переподключитесь заново.');
            location.reload();
            break;

        case 'role-updated':
            isCreator = data.isCreator;
            updateModToolsVisibility();
            break;

        case 'new-peer':
            if (data.peerId !== myClientId) await handleNewPeer(data.peerId, data.peerName, data.polite);
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
                    console.log(`[WebRTC] Игнорируем Offer от невежливого пира ${senderPeerId}`);
                    return;
                }
                await pc.setRemoteDescription(new RTCSessionDescription(sdp));
                if (sdp.type === 'offer') {
                    const answer = await pc.createAnswer();
                    answer.sdp = preferOpusFecDtx(answer.sdp);
                    await pc.setLocalDescription(answer);
                    sendSignaling({ type: 'relay-sdp', targetPeerId: senderPeerId, sdp: pc.localDescription });
                }
            } catch (err) {
                console.error(`[WebRTC] Ошибка SDP от ${senderPeerId}:`, err);
            }
            break;
        }

        case 'relay-ice': {
            const { senderPeerId, candidate } = data;
            const pc = peerConnections.get(senderPeerId);
            if (!pc) return;
            try {
                if (candidate) await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
                if (!ignoreOffer.get(senderPeerId)) console.error(`[WebRTC] Ошибка ICE от ${senderPeerId}:`, err);
            }
            break;
        }

        case 'peer-left':
            removePeer(data.peerId);
            break;

        case 'media-state-change':
            updatePeerMedia(data.senderPeerId, data.mediaType, data.enabled);
            break;

        case 'force-mute':
            handleForceMute(data.mediaType);
            break;

        case 'chat-message':
            appendChatMessage(data.senderName, data.text, data.timestamp, data.isSystem);
            break;

        case 'screen-share-announced':
            if (data.sharerId !== myClientId && screenStream) {
                stopScreenShare();
                appendChatMessage('Система', 'Ваша трансляция экрана остановлена, так как другой участник начал свою презентацию.', new Date().toLocaleTimeString(), true);
            }
            break;

        case 'error':
            alert(data.message);
            manualLeave = true;
            location.reload();
            break;
    }
}

function sendSignaling(payload) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// SDP munging: включаем Opus inband FEC + DTX (устойчивость аудио к потерям)
// ---------------------------------------------------------------------------
function preferOpusFecDtx(sdp) {
    if (!sdp) return sdp;
    const lines = sdp.split('\r\n');
    let pt = null;
    for (const l of lines) { const m = l.match(/^a=rtpmap:(\d+) opus\/48000/i); if (m) { pt = m[1]; break; } }
    if (!pt) return sdp;

    let done = false;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith(`a=fmtp:${pt} `)) {
            const body = lines[i].slice(`a=fmtp:${pt} `.length);
            const kv = new Map();
            body.split(';').forEach(p => {
                if (!p) return;
                const idx = p.indexOf('=');
                if (idx < 0) kv.set(p.trim(), undefined);
                else kv.set(p.slice(0, idx).trim(), p.slice(idx + 1));
            });
            kv.set('useinbandfec', '1');
            kv.set('usedtx', '1');
            lines[i] = `a=fmtp:${pt} ` + Array.from(kv.entries()).map(([k, v]) => v === undefined ? k : `${k}=${v}`).join(';');
            done = true;
        }
    }
    if (!done) {
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith(`a=rtpmap:${pt} opus`)) {
                lines.splice(i + 1, 0, `a=fmtp:${pt} minptime=10;useinbandfec=1;usedtx=1`);
                break;
            }
        }
    }
    return lines.join('\r\n');
}

// ---------------------------------------------------------------------------
// Инициализация медиа
// ---------------------------------------------------------------------------
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
        const stream = await navigator.mediaDevices.getUserMedia({
            video: startVideo ? videoConstraints() : false,
            audio: startAudio ? audioConstraints() : false
        });
        stream.getTracks().forEach(track => localStream.addTrack(track));

        // Запоминаем реально выбранные устройства
        const at = localStream.getAudioTracks()[0];
        const vt = localStream.getVideoTracks()[0];
        if (at && !selectedMicId) selectedMicId = at.getSettings().deviceId || null;
        if (vt && !selectedCamId) selectedCamId = vt.getSettings().deviceId || null;

        const localVideo = document.getElementById('local-video');
        if (localVideo && startVideo) { localVideo.srcObject = localStream; showLocalAvatarPlaceholder(false); }
        else showLocalAvatarPlaceholder(true);

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
        const circle = document.createElement('div');
        circle.className = 'avatar-circle';
        circle.style.cssText = 'background-color:#555;width:80px;height:80px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:32px;color:white;font-weight:bold;margin:auto;';
        circle.textContent = 'Я';
        newPlaceholder.appendChild(circle);
        if (localContainer) {
            localContainer.insertBefore(newPlaceholder, localVideo);
            addZoomButton(localContainer);
        }
    }
    const cur = document.getElementById('local-avatar-placeholder');
    if (show) {
        cur?.classList.remove('hidden');
        localVideo?.classList.add('hidden');
        localContainer?.classList.add('video-muted');
    } else {
        cur?.classList.add('hidden');
        localVideo?.classList.remove('hidden');
        localContainer?.classList.remove('video-muted');
    }
}

function addZoomButton(container) {
    if (container.querySelector('.btn-zoom-tile')) return;
    const zoomBtn = document.createElement('button');
    zoomBtn.className = 'btn-zoom-tile';
    zoomBtn.textContent = '⛶';
    zoomBtn.title = 'Развернуть плитку';
    zoomBtn.style.cssText = 'position:absolute;top:8px;right:8px;background:rgba(0,0,0,0.6);border:none;color:white;border-radius:4px;width:28px;height:28px;cursor:pointer;z-index:10;font-weight:bold;display:flex;align-items:center;justify-content:center;transition:background 0.2s;';
    zoomBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isMax = container.classList.contains('maximized');
        document.querySelectorAll('.video-container').forEach(el => {
            el.classList.remove('maximized');
            const btn = el.querySelector('.btn-zoom-tile');
            if (btn) btn.textContent = '⛶';
        });
        if (!isMax) { container.classList.add('maximized'); zoomBtn.textContent = '🗗'; zoomBtn.title = 'Свернуть плитку'; }
        else { zoomBtn.textContent = '⛶'; zoomBtn.title = 'Развернуть плитку'; }
    });
    container.appendChild(zoomBtn);
}

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    const target = document.getElementById(screenId);
    if (target) target.classList.remove('hidden');
}

async function showCallScreen(startVideo, startAudio) {
    stopPreview(); // освобождаем камеру зелёной комнаты перед реальным захватом
    showScreen('call-screen');
    await initMedia(startVideo, startAudio);
    updateModToolsVisibility();
    requestWakeLock();
}

function switchTab(tab) {
    const tabCreate = document.getElementById('tab-create');
    const tabJoin = document.getElementById('tab-join');
    const formCreate = document.getElementById('form-create');
    const formJoin = document.getElementById('form-join');
    if (tab === 'create') {
        tabCreate?.classList.add('active'); tabJoin?.classList.remove('active');
        formCreate?.classList.remove('hidden'); formJoin?.classList.add('hidden');
    } else {
        tabCreate?.classList.remove('active'); tabJoin?.classList.add('active');
        formCreate?.classList.add('hidden'); formJoin?.classList.remove('hidden');
    }
}

function showShareBar() {
    const shareBar = document.getElementById('share-bar');
    if (shareBar && isCreator) shareBar.classList.remove('hidden');
}

function copyInviteLink() {
    if (!currentRoomId || !currentRoomPasswordHash) return;
    const inviteUrl = `${window.location.origin}/#${currentRoomId}:${currentRoomPasswordHash}`;
    navigator.clipboard.writeText(inviteUrl).then(() => {
        const btn = document.getElementById('btn-copy-link');
        if (btn) { btn.innerText = '✅ Ссылка скопирована!'; setTimeout(() => { btn.innerText = '📋 Скопировать ссылку'; }, 2000); }
    }).catch(err => console.error('Не удалось скопировать ссылку:', err));
}

async function createRoom() {
    const creatorName = document.getElementById('create-name')?.value.trim();
    const roomName = document.getElementById('create-room-name')?.value.trim();
    const password = document.getElementById('create-password')?.value;
    const maxUsers = document.getElementById('create-limit')?.value || 2;
    if (!roomName || !password) { alert('Пожалуйста, заполните название комнаты и код доступа.'); return; }
    currentRoomPasswordHash = await sha256(password);
    sendSignaling({ type: 'create-room', roomName, passwordHash: currentRoomPasswordHash, maxUsers, creatorName: creatorName || 'Создатель' });
}

async function joinRoomManual() {
    const userName = document.getElementById('join-user-name')?.value.trim();
    const roomId = document.getElementById('join-room-id')?.value.trim();
    const password = document.getElementById('join-password')?.value;
    if (!roomId) { alert('Пожалуйста, введите ID комнаты.'); return; }
    if (!currentRoomPasswordHash) {
        if (!password) { alert('Пожалуйста, введите код доступа.'); return; }
        currentRoomPasswordHash = await sha256(password);
    }
    sendSignaling({ type: 'join-room', roomId, passwordHash: currentRoomPasswordHash, userName: userName || 'Гость' });
}

// --- СВЯЗЬ WEBRTC И ПЛИТКИ ---
async function handleNewPeer(peerId, peerName, polite) {
    if (peerConnections.has(peerId)) return;
    const config = await getRtcConfig();
    if (peerConnections.has(peerId)) return;

    console.log(`[WebRTC] Соединение с ${peerName}. polite: ${polite}`);
    const pc = new RTCPeerConnection(config);
    peerConnections.set(peerId, pc);
    makingOffer.set(peerId, false);
    ignoreOffer.set(peerId, false);

    if (!polite) pc.createDataChannel('sig-assistance-channel');
    pc.ondatachannel = () => console.log(`[WebRTC] Получен канал данных от ${peerName}`);

    if (localStream) {
        localStream.getTracks().forEach(track => configureSender(pc.addTrack(track, localStream), track.kind));
    }
    refreshVideoBitrate();

    if (!document.getElementById(`video-${peerId}`)) createPeerTile(peerId, peerName, null);

    const remoteStream = new MediaStream();
    pc.ontrack = (event) => {
        event.streams[0].getTracks().forEach(track => remoteStream.addTrack(track));
        const videoEl = document.getElementById(`video-${peerId}`);
        const placeholder = document.getElementById(`avatar-placeholder-${peerId}`);
        if (event.track.kind === 'video') {
            if (videoEl) {
                videoEl.srcObject = remoteStream;
                videoEl.classList.remove('hidden');
                if (selectedSpeakerId && videoEl.setSinkId) videoEl.setSinkId(selectedSpeakerId).catch(() => {});
            }
            if (placeholder) placeholder.classList.add('hidden');
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            if (event.candidate.type === 'relay') sawRelayCandidate = true;
            sendSignaling({ type: 'relay-ice', targetPeerId: peerId, candidate: event.candidate });
        }
    };

    pc.oniceconnectionstatechange = () => {
        const st = pc.iceConnectionState;
        console.log(`[WebRTC] ICE ${peerName}: ${st}`);
        if (st === 'failed') {
            // Реальный провал — перезапускаем ICE и предупреждаем пользователя:
            // молчаливый провал ICE неотличим от «баг в приложении».
            try { pc.restartIce(); } catch (e) {}
            setQualityBadge(peerId, 'bad', 'Переподключение…');
            showIceFailureWarning();
        } else if (st === 'disconnected') {
            // 'disconnected' часто кратковременный и восстанавливается сам —
            // не паникуем, ждём, и только если не вернулось за 6с, рестартим ICE.
            setQualityBadge(peerId, 'medium', 'Восстановление соединения…');
            setTimeout(() => { if (pc.iceConnectionState === 'disconnected') { try { pc.restartIce(); } catch (e) {} } }, 6000);
        } else if (st === 'connected' || st === 'completed') {
            setQualityBadge(peerId, 'good', 'Соединение установлено');
            // Соединение поднялось — снимаем предупреждение, если оно висело.
            showIceWarningBanner(false);
        }
    };

    pc.onnegotiationneeded = async () => {
        try {
            makingOffer.set(peerId, true);
            const offer = await pc.createOffer();
            offer.sdp = preferOpusFecDtx(offer.sdp);
            await pc.setLocalDescription(offer);
            sendSignaling({ type: 'relay-sdp', targetPeerId: peerId, sdp: pc.localDescription, polite: !polite });
        } catch (err) {
            console.error('[WebRTC] Ошибка onnegotiationneeded:', err);
        } finally {
            makingOffer.set(peerId, false);
        }
    };

    startStatsMonitor(peerId, pc);

    // Сообщаем новому пиру своё состояние камеры/микрофона (для заглушки и кнопок).
    broadcastMyMediaState();
}

// Приоритет аудио над видео + динамический потолок битрейта видео по числу участников
function videoBitrateForCount(total) {
    if (total <= 2) return 1_200_000;
    if (total === 3) return 700_000;
    if (total === 4) return 450_000;
    return 300_000; // 5
}

function configureSender(sender, kind) {
    try {
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        if (kind === 'audio') {
            params.encodings[0].priority = 'high';
            params.encodings[0].networkPriority = 'high';
        } else {
            params.encodings[0].priority = 'low';
            params.encodings[0].networkPriority = 'low';
            params.encodings[0].maxBitrate = videoBitrateForCount(peerConnections.size + 1);
        }
        sender.setParameters(params).catch(() => {});
    } catch (e) { /* не все браузеры поддерживают — не критично */ }
}

function refreshVideoBitrate() {
    const max = videoBitrateForCount(peerConnections.size + 1);
    peerConnections.forEach(pc => {
        pc.getSenders().forEach(s => {
            if (s.track && s.track.kind === 'video') {
                try {
                    const p = s.getParameters();
                    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
                    p.encodings[0].maxBitrate = max;
                    s.setParameters(p).catch(() => {});
                } catch (e) {}
            }
        });
    });
}

function createPeerTile(peerId, peerName, remoteStream) {
    const grid = document.getElementById('video-grid');
    if (document.getElementById(`video-container-${peerId}`)) return;

    const container = document.createElement('div');
    container.className = 'video-container';
    container.id = `video-container-${peerId}`;

    const placeholder = document.createElement('div');
    placeholder.className = 'video-avatar-placeholder';
    placeholder.id = `avatar-placeholder-${peerId}`;
    const colors = ['#007bff', '#28a745', '#e83e8c', '#fd7e14', '#6f42c1', '#17a2b8'];
    const charCodeSum = peerName.split('').reduce((s, ch) => s + ch.charCodeAt(0), 0);
    const circle = document.createElement('div');
    circle.className = 'avatar-circle';
    circle.style.cssText = `background-color:${colors[charCodeSum % colors.length]};width:80px;height:80px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:32px;color:white;font-weight:bold;margin:auto;`;
    circle.textContent = (peerName.charAt(0) || '?').toUpperCase();
    placeholder.appendChild(circle);
    container.appendChild(placeholder);

    const video = document.createElement('video');
    video.id = `video-${peerId}`;
    video.autoplay = true;
    video.playsInline = true;
    if (remoteStream && remoteStream.getVideoTracks().length > 0) { video.srcObject = remoteStream; placeholder.classList.add('hidden'); }
    else video.classList.add('hidden');
    container.appendChild(video);

    const label = document.createElement('div');
    label.className = 'video-label';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'peer-name-text';
    nameSpan.textContent = peerName;
    const micInd = document.createElement('span');
    micInd.className = 'mic-status-indicator hidden';
    micInd.id = `mic-indicator-${peerId}`;
    micInd.title = 'Микрофон выключен';
    micInd.style.cssText = 'margin-left:6px;color:#ff4a4a;vertical-align:middle;';
    micInd.textContent = '🎙️📴';
    label.appendChild(nameSpan);
    label.appendChild(micInd);
    container.appendChild(label);

    const badge = document.createElement('div');
    badge.className = 'quality-badge';
    badge.id = `quality-${peerId}`;
    badge.title = 'Качество связи';
    badge.style.cssText = 'position:absolute;top:8px;left:8px;width:12px;height:12px;border-radius:50%;background:#888;z-index:10;box-shadow:0 0 4px rgba(0,0,0,0.5);';
    container.appendChild(badge);

    addZoomButton(container);

    if (isCreator) {
        const modTools = document.createElement('div');
        modTools.className = 'mod-tools';
        const btnMute = document.createElement('button');
        btnMute.id = `mod-audio-${peerId}`;
        btnMute.className = 'hidden'; // покажем, только если у пира включён микрофон
        btnMute.title = 'Заглушить'; btnMute.textContent = '🔇';
        btnMute.style.cssText = 'background:rgba(0,0,0,0.6);border:none;color:white;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:12px;margin-right:4px;';
        btnMute.addEventListener('click', () => mutePeerRemote(peerId, 'audio'));
        const btnCam = document.createElement('button');
        btnCam.id = `mod-video-${peerId}`;
        btnCam.className = 'hidden'; // покажем, только если у пира включена камера
        btnCam.title = 'Выключить видео'; btnCam.textContent = '🚫📷';
        btnCam.style.cssText = 'background:rgba(0,0,0,0.6);border:none;color:white;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:12px;';
        btnCam.addEventListener('click', () => mutePeerRemote(peerId, 'video'));
        modTools.appendChild(btnMute); modTools.appendChild(btnCam);
        container.appendChild(modTools);
        applyModButtonsVisibility(peerId);
    }

    grid.appendChild(container);
}

// Единая точка обновления состояния медиа пира: индикатор микрофона,
// заглушка вместо чёрного видео и видимость кнопок модерации.
function updatePeerMedia(peerId, mediaType, enabled) {
    const st = peerMediaState.get(peerId) || { audio: false, video: false };
    st[mediaType] = !!enabled;
    peerMediaState.set(peerId, st);

    if (mediaType === 'audio') {
        const ind = document.getElementById(`mic-indicator-${peerId}`);
        if (ind) ind.classList.toggle('hidden', enabled); // значок "микрофон выкл." — когда !enabled
    } else if (mediaType === 'video') {
        // Камера выключена -> прячем видео (чёрный кадр) и показываем аватар
        const videoEl = document.getElementById(`video-${peerId}`);
        const placeholder = document.getElementById(`avatar-placeholder-${peerId}`);
        if (videoEl) videoEl.classList.toggle('hidden', !enabled);
        if (placeholder) placeholder.classList.toggle('hidden', enabled);
    }
    applyModButtonsVisibility(peerId);
}

// Кнопки модерации показываем только для тех устройств, что у пира включены
// (нечего выключать, если камеры/микрофона нет).
function applyModButtonsVisibility(peerId) {
    const st = peerMediaState.get(peerId) || { audio: false, video: false };
    const a = document.getElementById(`mod-audio-${peerId}`);
    const v = document.getElementById(`mod-video-${peerId}`);
    if (a) a.classList.toggle('hidden', !st.audio);
    if (v) v.classList.toggle('hidden', !st.video);
}

// Рассылаем своё текущее состояние камеры/микрофона (чтобы пиры показали
// правильную заглушку и кнопки). Вызывается при подключении нового пира.
function broadcastMyMediaState() {
    if (!localStream) return;
    const a = localStream.getAudioTracks()[0];
    const v = localStream.getVideoTracks()[0];
    sendSignaling({ type: 'media-state-change', roomId: currentRoomId, mediaType: 'audio', enabled: !!(a && a.enabled) });
    sendSignaling({ type: 'media-state-change', roomId: currentRoomId, mediaType: 'video', enabled: !!(v && v.enabled) });
}

function setQualityBadge(peerId, level, title) {
    const badge = document.getElementById(`quality-${peerId}`);
    if (!badge) return;
    const colors = { good: '#28a745', medium: '#ffc107', bad: '#dc3545' };
    badge.style.background = colors[level] || '#888';
    if (title) badge.title = title;
}

function setSpeaking(peerId, on) {
    const c = document.getElementById(`video-container-${peerId}`);
    if (!c) return;
    c.style.outline = on ? '3px solid #28a745' : '';
    c.style.outlineOffset = on ? '-3px' : '';
}

// Мониторинг качества + активный говорящий (getStats)
function startStatsMonitor(peerId, pc) {
    stopStatsMonitor(peerId);
    let lastLost = 0, lastRecv = 0;
    const timer = setInterval(async () => {
        if (!peerConnections.has(peerId)) { stopStatsMonitor(peerId); return; }
        try {
            const stats = await pc.getStats();
            let rtt = null, lost = 0, recv = 0, audioLevel = 0;
            stats.forEach(r => {
                if (r.type === 'inbound-rtp') {
                    lost += r.packetsLost || 0;
                    recv += r.packetsReceived || 0;
                    if (r.kind === 'audio' && typeof r.audioLevel === 'number') audioLevel = Math.max(audioLevel, r.audioLevel);
                }
                if (r.type === 'track' && r.kind === 'audio' && typeof r.audioLevel === 'number') audioLevel = Math.max(audioLevel, r.audioLevel);
                if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) rtt = r.currentRoundTripTime;
            });
            const dLost = Math.max(0, lost - lastLost);
            const dRecv = Math.max(0, recv - lastRecv);
            lastLost = lost; lastRecv = recv;
            const lossRatio = (dLost + dRecv) > 0 ? dLost / (dLost + dRecv) : 0;

            let level = 'good';
            if (lossRatio > 0.08 || (rtt != null && rtt > 0.4)) level = 'bad';
            else if (lossRatio > 0.02 || (rtt != null && rtt > 0.2)) level = 'medium';
            const rttMs = rtt != null ? Math.round(rtt * 1000) : '—';
            setQualityBadge(peerId, level, `RTT: ${rttMs} мс, потери: ${(lossRatio * 100).toFixed(1)}%`);

            setSpeaking(peerId, audioLevel > 0.05);
        } catch (e) { /* getStats может кратко падать при renegotiation */ }
    }, 2000);
    statsTimers.set(peerId, timer);
}

function stopStatsMonitor(peerId) {
    const t = statsTimers.get(peerId);
    if (t) { clearInterval(t); statsTimers.delete(peerId); }
}

function removePeer(peerId) {
    stopStatsMonitor(peerId);
    peerMediaState.delete(peerId);
    const pc = peerConnections.get(peerId);
    if (pc) { pc.close(); peerConnections.delete(peerId); makingOffer.delete(peerId); ignoreOffer.delete(peerId); }
    document.getElementById(`video-container-${peerId}`)?.remove();
    refreshVideoBitrate();
}

// --- Динамическое включение/выключение микрофона ---
async function toggleMic() {
    if (!localStream) return;
    let track = localStream.getAudioTracks()[0];
    if (!track) {
        try {
            const tempStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints() });
            const newTrack = tempStream.getAudioTracks()[0];
            localStream.addTrack(newTrack);
            track = newTrack;
            peerConnections.forEach(pc => configureSender(pc.addTrack(newTrack, localStream), 'audio'));
        } catch (err) {
            console.error('[Media] Ошибка активации микрофона:', err);
            alert('Не удалось получить доступ к микрофону.');
            return;
        }
    } else {
        track.enabled = !track.enabled;
    }
    updateButtonUI('btn-mic', track.enabled);
    sendSignaling({ type: 'media-state-change', roomId: currentRoomId, mediaType: 'audio', enabled: track.enabled });
}

// --- Динамическое включение/выключение камеры ---
async function toggleCam() {
    if (!localStream) return;
    let track = localStream.getVideoTracks()[0];
    if (!track) {
        try {
            const tempStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints() });
            const newTrack = tempStream.getVideoTracks()[0];
            localStream.addTrack(newTrack);
            track = newTrack;
            const localVideo = document.getElementById('local-video');
            if (localVideo) localVideo.srcObject = localStream;
            peerConnections.forEach(pc => configureSender(pc.addTrack(newTrack, localStream), 'video'));
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
    sendSignaling({ type: 'media-state-change', roomId: currentRoomId, mediaType: 'video', enabled: track.enabled });
}

function updateButtonUI(btnId, isEnabled) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const iconOn = btn.querySelector('.icon-on');
    const iconOff = btn.querySelector('.icon-off');
    if (isEnabled) { btn.classList.remove('off'); iconOn?.classList.remove('hidden'); iconOff?.classList.add('hidden'); }
    else { btn.classList.add('off'); iconOn?.classList.add('hidden'); iconOff?.classList.remove('hidden'); }
}

function handleForceMute(mediaType) {
    if (!localStream) return;
    const track = mediaType === 'audio' ? localStream.getAudioTracks()[0] : localStream.getVideoTracks()[0];
    if (track && track.enabled) { if (mediaType === 'audio') toggleMic(); else toggleCam(); }
}

function mutePeerRemote(peerId, mediaType) {
    if (isCreator) sendSignaling({ type: 'moderator-mute-peer', targetPeerId: peerId, mediaType });
}

// ---------------------------------------------------------------------------
// Выбор устройств (mic/cam/speaker)
// ---------------------------------------------------------------------------
async function populateDevices(prefix) {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        fillSelect(`${prefix}-mic`, devices.filter(d => d.kind === 'audioinput'), selectedMicId);
        fillSelect(`${prefix}-cam`, devices.filter(d => d.kind === 'videoinput'), selectedCamId);
        fillSelect(`${prefix}-speaker`, devices.filter(d => d.kind === 'audiooutput'), selectedSpeakerId);
    } catch (e) { console.warn('enumerateDevices:', e); }
}

function fillSelect(id, devices, selectedId) {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.textContent = '';
    devices.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Устройство ${i + 1}`;
        if (d.deviceId === selectedId) opt.selected = true;
        sel.appendChild(opt);
    });
}

async function replaceLocalTrack(kind) {
    if (!localStream) return;
    const old = kind === 'audio' ? localStream.getAudioTracks()[0] : localStream.getVideoTracks()[0];
    try {
        const constraints = kind === 'audio' ? { audio: audioConstraints() } : { video: videoConstraints() };
        const s = await navigator.mediaDevices.getUserMedia(constraints);
        const newTrack = kind === 'audio' ? s.getAudioTracks()[0] : s.getVideoTracks()[0];
        if (old) { newTrack.enabled = old.enabled; old.stop(); localStream.removeTrack(old); }
        localStream.addTrack(newTrack);
        if (kind === 'video') { const lv = document.getElementById('local-video'); if (lv) lv.srcObject = localStream; }
        peerConnections.forEach(pc => {
            const sender = pc.getSenders().find(sn => sn.track && sn.track.kind === kind);
            if (sender) sender.replaceTrack(newTrack);
            else configureSender(pc.addTrack(newTrack, localStream), kind);
        });
    } catch (e) { console.error('replaceLocalTrack:', e); }
}

async function changeMic(deviceId) { selectedMicId = deviceId; await replaceLocalTrack('audio'); }
async function changeCam(deviceId) { selectedCamId = deviceId; await replaceLocalTrack('video'); }
async function changeSpeaker(deviceId) {
    selectedSpeakerId = deviceId;
    document.querySelectorAll('video').forEach(v => { if (v.setSinkId) v.setSinkId(deviceId).catch(() => {}); });
}

async function openSettings() {
    const m = document.getElementById('settings-modal');
    if (!m) return;
    await populateDevices('call-sel');
    m.classList.remove('hidden');
}
function closeSettings() { document.getElementById('settings-modal')?.classList.add('hidden'); }

// ---------------------------------------------------------------------------
// Зелёная комната (предпросмотр + индикатор уровня микрофона)
// ---------------------------------------------------------------------------
async function toggleMediaTest() {
    const panel = document.getElementById('media-test-panel');
    if (!panel) return;
    if (panel.classList.contains('hidden')) { panel.classList.remove('hidden'); await startPreview(); }
    else { stopPreview(); panel.classList.add('hidden'); }
}

async function startPreview() {
    try {
        stopPreview();
        previewStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(), video: videoConstraints() });
        const v = document.getElementById('preview-video');
        if (v) v.srcObject = previewStream;
        const at = previewStream.getAudioTracks()[0];
        const vt = previewStream.getVideoTracks()[0];
        if (at && !selectedMicId) selectedMicId = at.getSettings().deviceId || null;
        if (vt && !selectedCamId) selectedCamId = vt.getSettings().deviceId || null;
        await populateDevices('sel');
        startMeter(previewStream);
    } catch (e) {
        alert('Не удалось получить доступ к камере/микрофону: ' + e.message);
    }
}

function stopPreview() {
    stopMeter();
    if (previewStream) { previewStream.getTracks().forEach(t => t.stop()); previewStream = null; }
    const v = document.getElementById('preview-video');
    if (v) v.srcObject = null;
}

async function onPreviewDeviceChange() {
    selectedMicId = document.getElementById('sel-mic')?.value || selectedMicId;
    selectedCamId = document.getElementById('sel-cam')?.value || selectedCamId;
    selectedSpeakerId = document.getElementById('sel-speaker')?.value || selectedSpeakerId;
    await startPreview();
}

function startMeter(stream) {
    stopMeter();
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const src = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const bar = document.getElementById('mic-level');
        const loop = () => {
            analyser.getByteFrequencyData(data);
            let sum = 0; for (const v of data) sum += v;
            const pct = Math.min(100, Math.round((sum / data.length / 128) * 100));
            if (bar) bar.style.width = pct + '%';
            meterRAF = requestAnimationFrame(loop);
        };
        loop();
    } catch (e) {}
}

function stopMeter() {
    if (meterRAF) { cancelAnimationFrame(meterRAF); meterRAF = null; }
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    const bar = document.getElementById('mic-level');
    if (bar) bar.style.width = '0%';
}

// --- Wake Lock (экран не гаснет во время звонка) ---
async function requestWakeLock() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
}
function releaseWakeLock() { try { wakeLock?.release?.(); } catch (e) {} wakeLock = null; }

// --- УПРАВЛЕНИЕ UI СТУКА (KNOCK-KNOCK) ---
function showKnockModal(guestId, guestName) {
    const modal = document.getElementById('knock-modal');
    const msg = document.getElementById('knock-msg');
    const btnApprove = document.getElementById('btn-approve');
    const btnReject = document.getElementById('btn-reject');
    if (!modal || !msg) return;
    msg.textContent = `Пользователь ${guestName} хочет подключиться к этой комнате.`;
    modal.classList.remove('hidden');
    btnApprove.onclick = () => { sendSignaling({ type: 'approve-guest', guestId, approved: true }); modal.classList.add('hidden'); };
    btnReject.onclick = () => { sendSignaling({ type: 'approve-guest', guestId, approved: false }); modal.classList.add('hidden'); };
}

function updateModToolsVisibility() {
    document.querySelectorAll('.mod-tools').forEach(el => {
        if (isCreator) el.classList.remove('hidden'); else el.classList.add('hidden');
    });
}

// --- ЧАТ КОМНАТЫ ---
function toggleChat() {
    const chatContainer = document.querySelector('.chat-container');
    const chatBtn = document.getElementById('btn-chat-toggle');
    if (chatContainer) { chatContainer.classList.toggle('hidden'); chatBtn?.classList.toggle('active'); }
}

function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const text = input?.value.trim();
    if (!text) return;
    sendSignaling({ type: 'chat-message', text });
    input.value = '';
}

function handleChatKey(event) { if (event.key === 'Enter') sendChatMessage(); }

// Безопасный рендер сообщений: всё пользовательское — через textContent (нет XSS)
function appendChatMessage(senderName, text, timestamp, isSystem = false) {
    const feed = document.getElementById('chat-messages');
    if (!feed) return;

    const msg = document.createElement('div');
    if (isSystem || senderName === 'Система' || senderName === 'Администрация') {
        msg.className = 'chat-message system-message';
        const body = document.createElement('div');
        body.className = 'chat-text';
        body.style.cssText = 'color:#ffb74d;font-style:italic;font-size:12px;text-align:center;margin:6px 0;background:rgba(255,183,77,0.05);padding:4px;border-radius:4px;';
        body.textContent = `📢 ${text} `;
        const t = document.createElement('span');
        t.style.cssText = 'font-size:9px;color:#888;margin-left:5px;';
        t.textContent = timestamp;
        body.appendChild(t);
        msg.appendChild(body);
    } else {
        msg.className = 'chat-message';
        const meta = document.createElement('div');
        meta.className = 'chat-meta';
        meta.style.cssText = 'font-size:11px;color:#888;margin-bottom:2px;';
        const strong = document.createElement('strong');
        strong.style.color = '#007bff';
        strong.textContent = senderName;
        const t = document.createElement('span');
        t.style.cssText = 'float:right;';
        t.textContent = timestamp;
        meta.appendChild(strong); meta.appendChild(t);
        const body = document.createElement('div');
        body.className = 'chat-text';
        body.style.cssText = 'background:rgba(255,255,255,0.05);padding:6px 10px;border-radius:6px;word-break:break-word;';
        body.textContent = text;
        msg.appendChild(meta); msg.appendChild(body);
    }
    feed.appendChild(msg);
    feed.scrollTop = feed.scrollHeight;
}

// --- БАННЕР ПЕРЕПОДКЛЮЧЕНИЯ ---
function showReconnectBanner(show, text) {
    let banner = document.getElementById('reconnect-banner');
    if (!banner && show) {
        banner = document.createElement('div');
        banner.id = 'reconnect-banner';
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#c0392b;color:white;text-align:center;padding:8px;z-index:9999;font-size:14px;font-weight:bold;';
        document.body.appendChild(banner);
    }
    if (banner) {
        if (show) { banner.textContent = text || 'Переподключение...'; banner.style.display = 'block'; }
        else banner.style.display = 'none';
    }
}

// --- ПРЕДУПРЕЖДЕНИЕ О ПРОВАЛЕ ICE ---
// Показываем понятную причину, когда медиасоединение с пиром не поднялось.
// Диагностика по трём случаям: TURN не настроен / настроен, но недоступен /
// прочая нестабильность сети.
function showIceFailureWarning() {
    const hasTurn = rtcConfigHasTurn(cachedRtcConfig);
    let text;
    if (!hasTurn) {
        text = '⚠️ Не удаётся соединиться с собеседником. Вы, вероятно, в разных сетях за NAT/файрволом, а TURN-сервер не настроен — прямое P2P невозможно. Настройте TURN (см. DEPLOY.md).';
    } else if (!sawRelayCandidate) {
        text = '⚠️ Не удаётся соединиться. TURN указан в конфиге, но relay-кандидат не получен — TURN-сервер недоступен или настроен неверно (проверьте адрес, секрет и порты).';
    } else {
        text = '⚠️ Соединение с собеседником нестабильно, пытаемся переподключиться…';
    }
    showIceWarningBanner(true, text);
}

function showIceWarningBanner(show, text) {
    let banner = document.getElementById('ice-warning-banner');
    if (!banner && show) {
        banner = document.createElement('div');
        banner.id = 'ice-warning-banner';
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#b8860b;color:#fff;text-align:center;padding:8px 40px;z-index:9998;font-size:13px;font-weight:bold;box-shadow:0 2px 6px rgba(0,0,0,0.35);';

        const span = document.createElement('span');
        span.id = 'ice-warning-text';
        banner.appendChild(span);

        const close = document.createElement('button');
        close.textContent = '✕';
        close.title = 'Скрыть';
        close.style.cssText = 'position:absolute;top:50%;right:10px;transform:translateY(-50%);background:transparent;border:none;color:#fff;font-size:16px;line-height:1;cursor:pointer;';
        close.addEventListener('click', () => { banner.style.display = 'none'; });
        banner.appendChild(close);

        document.body.appendChild(banner);
    }
    if (banner) {
        if (show) {
            const span = document.getElementById('ice-warning-text');
            if (span) span.textContent = text || '';
            banner.style.display = 'block';
        } else {
            banner.style.display = 'none';
        }
    }
}

// --- СОВМЕСТНЫЙ ДОСТУП К ЭКРАНУ ---
async function toggleScreenShare() {
    const shareBtn = document.getElementById('btn-screen');
    if (screenStream) { stopScreenShare(); return; }
    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always' }, audio: false });
        const screenTrack = screenStream.getVideoTracks()[0];
        sendSignaling({ type: 'screen-share-started', roomId: currentRoomId });
        // Показ экрана = видео есть, даже если камера была выключена: снимаем заглушку у пиров
        sendSignaling({ type: 'media-state-change', roomId: currentRoomId, mediaType: 'video', enabled: true });
        peerConnections.forEach(pc => {
            const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (videoSender) videoSender.replaceTrack(screenTrack);
        });
        const localVideo = document.getElementById('local-video');
        if (localVideo) { localVideo.srcObject = screenStream; showLocalAvatarPlaceholder(false); }
        shareBtn?.classList.add('active');
        screenTrack.onended = () => stopScreenShare();
    } catch (err) {
        console.error('Ошибка захвата экрана:', err);
        screenStream = null;
        shareBtn?.classList.remove('active');
    }
}

async function stopScreenShare() {
    const shareBtn = document.getElementById('btn-screen');
    if (!screenStream) return;
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
    shareBtn?.classList.remove('active');
    if (localStream) {
        const cameraTrack = localStream.getVideoTracks()[0];
        peerConnections.forEach(pc => {
            const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (videoSender && cameraTrack) videoSender.replaceTrack(cameraTrack);
        });
        const localVideo = document.getElementById('local-video');
        if (localVideo) {
            if (cameraTrack && cameraTrack.enabled) { localVideo.srcObject = localStream; showLocalAvatarPlaceholder(false); }
            else showLocalAvatarPlaceholder(true);
        }
    } else {
        showLocalAvatarPlaceholder(true);
    }
    // Возвращаем пирам реальное состояние камеры после остановки показа экрана
    const cam = localStream && localStream.getVideoTracks()[0];
    sendSignaling({ type: 'media-state-change', roomId: currentRoomId, mediaType: 'video', enabled: !!(cam && cam.enabled) });
}

function leaveCall() {
    if (confirm('Вы уверены, что хотите выйти из звонка?')) {
        manualLeave = true;
        // Явно сообщаем серверу об уходе — слот освобождается сразу, без grace,
        // и остальные участники мгновенно видят, что мы вышли.
        sendSignaling({ type: 'leave' });
        sessionToken = null;
        inCall = false;
        releaseWakeLock();
        stopPreview();
        setTimeout(() => { try { socket?.close(); } catch (e) {} location.reload(); }, 200);
    }
}
