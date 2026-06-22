import {
  MediaStream,
  MediaStreamTrack,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  mediaDevices,
} from 'react-native-webrtc';

export type SignalTier = 'excellent' | 'good' | 'fair' | 'poor';
export type AudioBitrateBps = 6000 | 12000 | 18000 | 24000;

export type GroupAudioSignal =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; candidate: any };

export interface GroupAudioIdentity {
  userId: string;
  groupId: string;
  name?: string;
}

export interface GroupAudioPeer {
  userId: string;
  name?: string;
}

export interface GroupAudioCallbacks {
  sendSignal: (targetUserId: string, signal: GroupAudioSignal) => void;
  onRemoteStream?: (peerUserId: string, stream: MediaStream) => void;
  onPeerState?: (peerUserId: string, state: string) => void;
  onSpeakingTrack?: (peerUserId: string, enabled: boolean) => void;
  onError?: (peerUserId: string | null, error: Error) => void;
}

export interface GroupAudioManagerOptions {
  identity: GroupAudioIdentity;
  callbacks: GroupAudioCallbacks;
  initialSignalTier?: SignalTier;
}

interface PeerRecord {
  userId: string;
  name?: string;
  pc: RTCPeerConnection;
  remoteStream?: MediaStream;
  iceQueue: any[];
  makingOffer: boolean;
  remoteDescriptionSet: boolean;
  senderTrack?: MediaStreamTrack;
}

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

export function bitrateForSignalTier(tier: SignalTier): AudioBitrateBps {
  switch (tier) {
    case 'excellent':
      return 24000;
    case 'good':
      return 18000;
    case 'fair':
      return 12000;
    case 'poor':
    default:
      return 6000;
  }
}

function normalizeSignalTier(tier?: SignalTier): SignalTier {
  if (tier === 'excellent' || tier === 'good' || tier === 'fair' || tier === 'poor') {
    return tier;
  }
  return 'good';
}

function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({ iceServers: ICE_SERVERS } as any);
}

function isGroupAudioSignal(value: any): value is GroupAudioSignal {
  if (!value || typeof value !== 'object' || typeof value.kind !== 'string') return false;
  if (value.kind === 'offer' || value.kind === 'answer') {
    return typeof value.sdp === 'string' && value.sdp.length > 0;
  }
  if (value.kind === 'ice') {
    return value.candidate != null;
  }
  return false;
}

async function getOrCreateLocalAudioStream(): Promise<MediaStream> {
  return mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    } as any,
    video: false,
  } as any);
}

function setTrackEnabled(stream: MediaStream | null, enabled: boolean): void {
  if (!stream) return;
  stream.getAudioTracks().forEach((track) => {
    track.enabled = enabled;
  });
}

function preferOpus(pc: RTCPeerConnection): void {
  const anyPc = pc as any;
  const transceivers = typeof anyPc.getTransceivers === 'function' ? anyPc.getTransceivers() : [];
  const firstAudio = transceivers.find((t: any) => t?.sender?.track?.kind === 'audio' || t?.receiver?.track?.kind === 'audio');
  if (!firstAudio || typeof firstAudio.setCodecPreferences !== 'function') {
    return;
  }

  const caps = typeof (globalThis as any).RTCRtpReceiver?.getCapabilities === 'function'
    ? (globalThis as any).RTCRtpReceiver.getCapabilities('audio')
    : null;
  const codecs = Array.isArray(caps?.codecs) ? caps.codecs.slice() : [];
  if (!codecs.length) return;

  const opus = codecs.filter((codec: any) => {
    const mimeType = String(codec?.mimeType || '').toLowerCase();
    return mimeType === 'audio/opus' || mimeType.endsWith('/opus');
  });
  if (!opus.length) return;

  const remaining = codecs.filter((codec: any) => !opus.includes(codec));
  firstAudio.setCodecPreferences([...opus, ...remaining]);
}

async function applySenderBitrate(pc: RTCPeerConnection, bitrateBps: AudioBitrateBps): Promise<void> {
  const anyPc = pc as any;
  const senders = typeof anyPc.getSenders === 'function' ? anyPc.getSenders() : [];
  const audioSender = senders.find((sender: any) => sender?.track?.kind === 'audio');
  if (!audioSender || typeof audioSender.getParameters !== 'function' || typeof audioSender.setParameters !== 'function') {
    return;
  }

  const parameters = audioSender.getParameters() || {};
  const encodings = Array.isArray(parameters.encodings) ? parameters.encodings.slice() : [{}];
  if (!encodings[0]) encodings[0] = {};
  encodings[0] = {
    ...encodings[0],
    maxBitrate: bitrateBps,
  };

  await audioSender.setParameters({
    ...parameters,
    encodings,
  });
}

function closePeer(peer: PeerRecord): void {
  try {
    (peer.pc as any).onicecandidate = null;
    (peer.pc as any).ontrack = null;
    (peer.pc as any).onconnectionstatechange = null;
    peer.pc.close();
  } catch {
    // no-op
  }
  peer.iceQueue = [];
}

export class GroupAudioManager {
  private readonly identity: GroupAudioIdentity;

  private readonly callbacks: GroupAudioCallbacks;

  private peers = new Map<string, PeerRecord>();

  private localStream: MediaStream | null = null;

  private signalTier: SignalTier;

  private bitrate: AudioBitrateBps;

  private disposed = false;

  constructor(options: GroupAudioManagerOptions) {
    this.identity = options.identity;
    this.callbacks = options.callbacks;
    this.signalTier = normalizeSignalTier(options.initialSignalTier);
    this.bitrate = bitrateForSignalTier(this.signalTier);
  }

  async start(): Promise<void> {
    if (this.disposed) return;
    if (!this.localStream) {
      this.localStream = await getOrCreateLocalAudioStream();
      setTrackEnabled(this.localStream, false);
    }
  }

  async ensurePeer(peer: GroupAudioPeer, options?: { createOffer?: boolean }): Promise<void> {
    if (this.disposed || !peer?.userId || peer.userId === this.identity.userId) return;

    await this.start();
    const record = this.getOrCreatePeer(peer);

    if (!options?.createOffer) return;

    const anyPc = record.pc as any;
    if (record.makingOffer || record.remoteDescriptionSet || anyPc.signalingState !== 'stable') {
      return;
    }

    try {
      record.makingOffer = true;
      const offer = await anyPc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      });
      await anyPc.setLocalDescription(offer);
      const sdp = String(anyPc.localDescription?.sdp || offer?.sdp || '');
      if (!sdp) return;
      this.callbacks.sendSignal(peer.userId, { kind: 'offer', sdp });
    } catch (error) {
      this.emitError(peer.userId, error);
    } finally {
      record.makingOffer = false;
    }
  }

  removePeer(peerUserId: string): void {
    const peer = this.peers.get(peerUserId);
    if (!peer) return;
    this.peers.delete(peerUserId);
    closePeer(peer);
  }

  async handleSignal(fromUserId: string, signal: GroupAudioSignal): Promise<void> {
    if (this.disposed || !fromUserId || fromUserId === this.identity.userId) return;
    if (!isGroupAudioSignal(signal)) return;

    await this.start();
    const peer = this.getOrCreatePeer({ userId: fromUserId });
    const anyPc = peer.pc as any;

    try {
      if (signal.kind === 'offer') {
        const isStable = (anyPc.signalingState === 'stable');

        // Perfect Negotiation glare handling: if we have a local offer
        // in flight when a remote offer arrives, the lexicographically
        // smaller userId keeps its offer; the larger rolls back and
        // accepts. (We check signalingState instead of peer.makingOffer
        // because makingOffer is already false by the time the remote
        // offer reaches us via WS relay.)
        if (!isStable && anyPc.signalingState === 'have-local-offer') {
          if (this.identity.userId > fromUserId) {
            // We have the larger userId — roll back and accept.
            // Rollback via setLocalDescription({ type: 'rollback' }) or
            // by setting remote desc first (Chrome-compatible path).
            await anyPc.setRemoteDescription(
              new RTCSessionDescription({ type: 'offer', sdp: signal.sdp })
            );
            peer.remoteDescriptionSet = true;
            peer.makingOffer = false;
            await this.drainIceQueue(peer);
            const answer = await anyPc.createAnswer();
            await anyPc.setLocalDescription(answer);
            const sdp = String(anyPc.localDescription?.sdp || answer?.sdp || '');
            if (sdp) {
              this.callbacks.sendSignal(fromUserId, { kind: 'answer', sdp });
            }
            return;
          }
          // We have the smaller userId — our offer wins. Ignore theirs;
          // they will roll back when they hit this same logic.
          return;
        }

        await anyPc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: signal.sdp }));
        peer.remoteDescriptionSet = true;
        await this.drainIceQueue(peer);

        const answer = await anyPc.createAnswer();
        await anyPc.setLocalDescription(answer);
        const sdp = String(anyPc.localDescription?.sdp || answer?.sdp || '');
        if (sdp) {
          this.callbacks.sendSignal(fromUserId, { kind: 'answer', sdp });
        }
        return;
      }

      if (signal.kind === 'answer') {
        await anyPc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: signal.sdp }));
        peer.remoteDescriptionSet = true;
        await this.drainIceQueue(peer);
        return;
      }

      if (signal.kind === 'ice') {
        if (peer.remoteDescriptionSet) {
          await anyPc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } else {
          peer.iceQueue.push(signal.candidate);
        }
      }
    } catch (error) {
      this.emitError(fromUserId, error);
    }
  }

  async setMicEnabled(enabled: boolean): Promise<void> {
    await this.start();
    setTrackEnabled(this.localStream, enabled);
  }

  async setSignalTier(tier: SignalTier): Promise<void> {
    this.signalTier = normalizeSignalTier(tier);
    this.bitrate = bitrateForSignalTier(this.signalTier);
    const peers = Array.from(this.peers.values());
    await Promise.all(peers.map(async (peer) => {
      try {
        await applySenderBitrate(peer.pc, this.bitrate);
      } catch (error) {
        this.emitError(peer.userId, error);
      }
    }));
  }

  getBitrate(): AudioBitrateBps {
    return this.bitrate;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.peers.forEach((peer) => closePeer(peer));
    this.peers.clear();

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // no-op
        }
      });
      this.localStream = null;
    }
  }

  private getOrCreatePeer(peer: GroupAudioPeer): PeerRecord {
    const existing = this.peers.get(peer.userId);
    if (existing) {
      existing.name = peer.name ?? existing.name;
      return existing;
    }

    const pc = createPeerConnection();

    const record: PeerRecord = {
      userId: peer.userId,
      name: peer.name,
      pc,
      iceQueue: [],
      makingOffer: false,
      remoteDescriptionSet: false,
    };

    (pc as any).onicecandidate = (event: any) => {
      if (!event?.candidate) return;
      this.callbacks.sendSignal(peer.userId, {
        kind: 'ice',
        candidate: event.candidate,
      });
    };

    (pc as any).ontrack = (event: any) => {
      const stream = event?.streams?.[0];
      if (!stream) return;
      record.remoteStream = stream;
      this.callbacks.onRemoteStream?.(peer.userId, stream);
      stream.getAudioTracks().forEach((track) => {
        this.callbacks.onSpeakingTrack?.(peer.userId, !!track.enabled);
      });
    };

    (pc as any).onconnectionstatechange = () => {
      const state = String((pc as any).connectionState || 'unknown');
      this.callbacks.onPeerState?.(peer.userId, state);
    };

    if (this.localStream) {
      const audioTrack = this.localStream.getAudioTracks()[0];
      if (audioTrack) {
        record.senderTrack = audioTrack;
        pc.addTrack(audioTrack, this.localStream);
      }
    }

    preferOpus(pc);
    applySenderBitrate(pc, this.bitrate).catch((error) => {
      this.emitError(peer.userId, error);
    });

    this.peers.set(peer.userId, record);
    return record;
  }

  private async drainIceQueue(peer: PeerRecord): Promise<void> {
    if (!peer.iceQueue.length) return;

    const queue = peer.iceQueue.splice(0, peer.iceQueue.length);
    await Promise.all(queue.map(async (candidate) => {
      try {
        await (peer.pc as any).addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        this.emitError(peer.userId, error);
      }
    }));
  }

  private emitError(peerUserId: string | null, rawError: unknown): void {
    const error = rawError instanceof Error ? rawError : new Error(String(rawError));
    this.callbacks.onError?.(peerUserId, error);
  }
}
