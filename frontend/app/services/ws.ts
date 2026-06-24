type Listener = (payload: any) => void;

type ListenerMap = Record<string, Set<Listener>>;

export interface LocationMessage {
  type: 'location';
  userId?: string;
  user_id?: string;
  lat: number;
  lng: number;
  altitude_m?: number | null;
  speed_ms?: number | null;
  sent_at?: number | string | null;
  ts?: number;
}

export interface PresenceMessage {
  type: 'member_joined' | 'member_left';
  userId?: string;
  user_id?: string;
  name?: string;
  online: boolean;
  last_seen_at?: string | null;
}

export interface MemberSnapshotMessage {
  type: 'members_snapshot';
  groupId: string;
  members: Array<{
    user_id?: string;
    userId?: string;
    name?: string;
    online: boolean;
    last_seen_at?: string | null;
    lat?: number | null;
    lng?: number | null;
    location_updated_at?: string | null;
  }>;
}

export interface WebRtcSignalMessage {
  type: 'webrtc_signal';
  from_user_id: string;
  signal: any;
}

export type SignalTier = 'excellent' | 'good' | 'fair' | 'poor';

export interface SignalQuality {
  tier: SignalTier;
  rttMs: number | null;
  reconnectCount: number;
  lastPongAt: number | null;
}

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8100';
const WS_URL = API_URL.replace('http', 'ws');

const MIN_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const PING_INTERVAL_MS = 12000;

class FlowWebSocket {
  private socket: WebSocket | null = null;
  private listeners: ListenerMap = {};
  private identity = { userId: '', groupId: '', name: '' };
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = MIN_RECONNECT_DELAY;
  private manuallyDisconnected = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectCount = 0;
  private lastPongAt: number | null = null;
  private signalQuality: SignalQuality = {
    tier: 'poor',
    rttMs: null,
    reconnectCount: 0,
    lastPongAt: null,
  };

  connect(userId: string, groupId: string, name: string) {
    if (!userId || !groupId) return;

    // Prevent double-connect: detach old socket's onclose BEFORE closing
    // so the stale async onclose cannot fire a reconnect after we open a new socket (#27, #29)
    this._clearReconnectTimer();
    this.reconnectDelay = MIN_RECONNECT_DELAY;
    this.reconnectCount = 0;

    if (this.socket) {
      this.socket.onclose = null;   // detach old handler — no stale reconnect
      this.socket.onerror = null;
      this.socket.close();
      this.socket = null;
    }

    // Reset for the new socket — reconnect on genuine network drops
    this.manuallyDisconnected = false;

    this.identity = { userId, groupId, name };
    this._openSocket();
  }

  private _openSocket() {
    const { userId, groupId, name } = this.identity;
    if (!userId || !groupId) return;

    const url = `${WS_URL}/ws?userId=${userId}&groupId=${groupId}&name=${encodeURIComponent(name || '')}`;
    this.socket = new WebSocket(url);

    this.socket.onopen = () => {
      this.reconnectDelay = MIN_RECONNECT_DELAY;
      this.reconnectCount = 0;
      this.emit('status', { state: 'connected' });
      this.send({ type: 'join' });
      this._startPingLoop();
      this._emitSignalQuality(this.signalQuality.rttMs);
    };

    this.socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data?.type === 'server_pong') {
          const ts = Number(data?.ts);
          const rttMs = Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : null;
          this.lastPongAt = Date.now();
          this._emitSignalQuality(rttMs);
        }
        this.emit('message', data);
        if (typeof data?.type === 'string') {
          this.emit(data.type, data);
        }
      } catch (error) {
        console.warn('Failed to parse WS message', error);
      }
    };

    this.socket.onerror = (error) => {
      console.warn('WebSocket error', error);
      this.emit('status', { state: 'error', error });
    };

    this.socket.onclose = () => {
      const wasManual = this.manuallyDisconnected;
      this._clearPingLoop();
      this.emit('status', { state: 'closed' });
      if (!wasManual && this.identity.userId && this.identity.groupId) {
        this.reconnectCount += 1;
        this._emitSignalQuality(this.signalQuality.rttMs);
        // Add jitter (±20%) to prevent thundering-herd reconnects (#29)
        const jitter = 0.8 + Math.random() * 0.4;
        const delay = Math.round(this.reconnectDelay * jitter);
        this.reconnectTimeout = setTimeout(() => {
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
          this._openSocket();
        }, delay);
      }
    };
  }

  private _clearReconnectTimer() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private _startPingLoop() {
    this._clearPingLoop();
    this.pingInterval = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.sendPing(Date.now());
      }
    }, PING_INTERVAL_MS);
  }

  private _clearPingLoop() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private _deriveSignalTier(rttMs: number | null): SignalTier {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return 'poor';
    }
    if (this.reconnectCount >= 3) {
      return 'poor';
    }
    if (rttMs == null) {
      return this.reconnectCount === 0 ? 'good' : 'fair';
    }
    if (rttMs <= 140 && this.reconnectCount === 0) return 'excellent';
    if (rttMs <= 280 && this.reconnectCount <= 1) return 'good';
    if (rttMs <= 600) return 'fair';
    return 'poor';
  }

  private _emitSignalQuality(rttMs: number | null) {
    const quality: SignalQuality = {
      tier: this._deriveSignalTier(rttMs),
      rttMs,
      reconnectCount: this.reconnectCount,
      lastPongAt: this.lastPongAt,
    };
    this.signalQuality = quality;
    this.emit('signal_quality', quality);
  }

  send(payload: Record<string, any>) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;

    const envelope: Record<string, any> = { ...payload };
    if (typeof envelope.payload === 'object' && envelope.payload !== null) {
      Object.entries(envelope.payload).forEach(([key, value]) => {
        if (envelope[key] === undefined) {
          envelope[key] = value;
        }
      });
      delete envelope.payload;
    }

    if (this.identity.userId && envelope.userId == null) {
      envelope.userId = this.identity.userId;
    }
    if (this.identity.groupId && envelope.groupId == null) {
      envelope.groupId = this.identity.groupId;
    }
    if (this.identity.name && envelope.name == null) {
      envelope.name = this.identity.name;
    }

    this.socket.send(JSON.stringify(envelope));
  }

  disconnect() {
    this.manuallyDisconnected = true;
    this._clearReconnectTimer();
    this._clearPingLoop();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.reconnectCount = 0;
    this.lastPongAt = null;
    this.signalQuality = {
      tier: 'poor',
      rttMs: null,
      reconnectCount: 0,
      lastPongAt: null,
    };
    this.identity = { userId: '', groupId: '', name: '' };
  }

  getState(): 'connecting' | 'connected' | 'error' | 'closed' {
    if (!this.socket) return 'closed';
    switch (this.socket.readyState) {
      case WebSocket.OPEN: return 'connected';
      case WebSocket.CONNECTING: return 'connecting';
      default: return 'closed';
    }
  }

  isConnected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Subscribe to any WS message whose type starts with 'goggle_'.
   * Returns an unsubscribe function.
   */
  onGoggleSignal(handler: (msg: any) => void): () => void {
    const listener = (data: any) => {
      if (typeof data?.type === 'string' && data.type.startsWith('goggle_')) {
        handler(data);
      }
    };
    this.on('message', listener);
    return () => this.off('message', listener);
  }

  onLocation(handler: (msg: LocationMessage) => void): () => void {
    const listener = (data: any) => {
      if (data?.type === 'location') {
        handler(data as LocationMessage);
      }
    };
    this.on('message', listener);
    return () => this.off('message', listener);
  }

  onPresence(handler: (msg: PresenceMessage) => void): () => void {
    const listener = (data: any) => {
      if (data?.type === 'member_joined' || data?.type === 'member_left') {
        handler(data as PresenceMessage);
      }
    };
    this.on('message', listener);
    return () => this.off('message', listener);
  }

  onMemberSnapshot(handler: (msg: MemberSnapshotMessage) => void): () => void {
    const listener = (data: any) => {
      if (data?.type === 'members_snapshot') {
        handler(data as MemberSnapshotMessage);
      }
    };
    this.on('message', listener);
    return () => this.off('message', listener);
  }

  sendWebRtcSignal(targetUserId: string, signal: any) {
    this.send({
      type: 'webrtc_signal',
      target_user_id: targetUserId,
      signal,
    });
  }

  sendPing(ts = Date.now()) {
    this.send({ type: 'client_ping', ts });
  }

  onSignalQuality(handler: (quality: SignalQuality) => void): () => void {
    return this.on('signal_quality', (payload: any) => {
      handler(payload as SignalQuality);
    });
  }

  on(event: string, listener: Listener): () => void {
    if (!this.listeners[event]) {
      this.listeners[event] = new Set();
    }
    this.listeners[event].add(listener);
    return () => this.off(event, listener);
  }

  off(event: string, listener: Listener) {
    this.listeners[event]?.delete(listener);
  }

  private emit(event: string, payload: any) {
    this.listeners[event]?.forEach((listener) => listener(payload));
  }
}

const wsClient = new FlowWebSocket();

export default wsClient;
