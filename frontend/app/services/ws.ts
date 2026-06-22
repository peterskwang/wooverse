type Listener = (payload: any) => void;

type ListenerMap = Record<string, Set<Listener>>;

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8100';
const WS_URL = API_URL.replace('http', 'ws');

const MIN_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;

class FlowWebSocket {
  private socket: WebSocket | null = null;
  private listeners: ListenerMap = {};
  private identity = { userId: '', groupId: '', name: '' };
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = MIN_RECONNECT_DELAY;
  private manuallyDisconnected = false;

  connect(userId: string, groupId: string, name: string) {
    if (!userId || !groupId) return;

    // Prevent double-connect: detach old socket's onclose BEFORE closing
    // so the stale async onclose cannot fire a reconnect after we open a new socket (#27, #29)
    this._clearReconnectTimer();
    this.reconnectDelay = MIN_RECONNECT_DELAY;

    if (this.socket) {
      this.socket.onclose = null;   // detach old handler — no stale reconnect
      this.socket.onerror = null;
      this.socket.close();
      this.socket = null;
    }

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
      this.emit('status', { state: 'connected' });
      this.send({ type: 'join' });
    };

    this.socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.emit('message', data);
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
      this.emit('status', { state: 'closed' });
      if (!wasManual && this.identity.userId && this.identity.groupId) {
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
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
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

  on(event: string, listener: Listener) {
    if (!this.listeners[event]) {
      this.listeners[event] = new Set();
    }
    this.listeners[event].add(listener);
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
