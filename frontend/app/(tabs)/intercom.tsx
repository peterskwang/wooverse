import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, AppStateStatus, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';

import wsClient, { MemberSnapshotMessage, PresenceMessage, SignalQuality, WebRtcSignalMessage } from '../services/ws';
import { GroupAudioManager, GroupAudioMode } from '../services/groupAudio';

interface Identity {
  userId: string;
  groupId: string;
  name: string;
}

interface MemberState {
  id: string;
  name: string;
  isTalking: boolean;
}

interface ChannelState {
  id: string;
  name?: string;
  queue_length?: number;
  token_holder?: {
    user_id?: string;
    name?: string;
  } | null;
}

const STORAGE_KEYS = ['userId', 'groupId', 'displayName', 'intercomAlwaysOn'] as const;
const RECENT_RECONNECT_BADGE_MS = 15_000;

const IntercomScreen = () => {
  const [identity, setIdentity] = useState<Identity>({ userId: '', groupId: '', name: '' });
  const [members, setMembers] = useState<Record<string, MemberState>>({});
  const [activeSpeaker, setActiveSpeaker] = useState<MemberState | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'error' | 'closed'>(wsClient.getState());
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const [isTransmitting, setIsTransmitting] = useState(false);
  const [isRequestingToken, setIsRequestingToken] = useState(false);
  const [channelBusy, setChannelBusy] = useState(false);
  const [selectedChannelId, setSelectedChannelId] = useState('general');
  const [channels, setChannels] = useState<ChannelState[]>([{ id: 'general', name: 'General', queue_length: 0 }]);
  const [queuePosition, setQueuePosition] = useState<number | null>(null);
  const [selectedQueueLength, setSelectedQueueLength] = useState(0);
  const [intercomAlwaysOn, setIntercomAlwaysOn] = useState(false);
  const [groupAudioMode, setGroupAudioMode] = useState<GroupAudioMode>('ptt');
  const [fallbackReason, setFallbackReason] = useState<'low_signal' | 'peer_disconnected' | null>(null);
  const [signalQuality, setSignalQuality] = useState<SignalQuality>({
    tier: 'poor',
    rttMs: null,
    reconnectCount: 0,
    lastPongAt: null,
  });
  const [permissionError, setPermissionError] = useState<string | null>(null);

  const groupAudioRef = useRef<GroupAudioManager | null>(null);
  const pendingPttRef = useRef(false);
  const talkIntentRef = useRef(false);
  const recoveryOfferTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const reconnectBadgeUntilRef = useRef(0);
  const pulseScale = useRef(new Animated.Value(1)).current;

  const { userId, groupId, name: displayName } = identity;

  const clearRecoveryTimer = useCallback((peerUserId: string) => {
    const timer = recoveryOfferTimersRef.current[peerUserId];
    if (timer) {
      clearTimeout(timer);
      delete recoveryOfferTimersRef.current[peerUserId];
    }
  }, []);

  const memberIdFromMessage = useCallback((message: any): string | null => {
    const candidate = message?.userId ?? message?.user_id ?? message?.from_user_id;
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
  }, []);

  const channelIdFromMessage = useCallback((message: any): string => {
    const candidate = message?.channelId ?? message?.channel_id;
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    return 'general';
  }, []);

  const upsertMemberFromPresence = useCallback((message: any, isTalking?: boolean) => {
    const memberId = memberIdFromMessage(message);
    if (!memberId) return;

    setMembers((prev) => ({
      ...prev,
      [memberId]: {
        id: memberId,
        name:
          message?.name ||
          prev[memberId]?.name ||
          (memberId === userId ? displayName || 'You' : 'Teammate'),
        isTalking: isTalking ?? prev[memberId]?.isTalking ?? false,
      },
    }));
  }, [displayName, memberIdFromMessage, userId]);

  const initializeGroupAudio = useCallback(async (currentIdentity: Identity): Promise<void> => {
    if (groupAudioRef.current) return;

    const manager = new GroupAudioManager({
      identity: {
        userId: currentIdentity.userId,
        groupId: currentIdentity.groupId,
        name: currentIdentity.name,
      },
      callbacks: {
        sendSignal: (targetUserId, signal) => wsClient.sendWebRtcSignal(targetUserId, signal),
        onModeChanged: (mode) => setGroupAudioMode(mode),
        onFallbackActivated: (reason) => setFallbackReason(reason),
        onFallbackRecovered: () => setFallbackReason(null),
        onError: (_peerUserId, error) => {
          console.warn('[intercom] group audio error:', error.message);
        },
      },
    });

    try {
      await manager.start();
      await manager.setMode(intercomAlwaysOn ? 'always_on' : 'ptt');
      groupAudioRef.current = manager;
      setPermissionError(null);
    } catch (error) {
      manager.dispose();
      const message = error instanceof Error ? error.message : String(error);
      setPermissionError(message || 'Unable to access microphone');
    }
  }, [intercomAlwaysOn]);

  const teardownGroupAudio = useCallback(() => {
    Object.values(recoveryOfferTimersRef.current).forEach((timer) => clearTimeout(timer));
    recoveryOfferTimersRef.current = {};

    const manager = groupAudioRef.current;
    groupAudioRef.current = null;
    manager?.dispose();
  }, []);

  const startTalking = useCallback(async () => {
    if (intercomAlwaysOn && !fallbackReason) return;
    const manager = groupAudioRef.current;
    if (!manager || !groupId || connectionStatus !== 'connected' || isTransmitting || channelBusy) return;

    setPermissionError(null);
    talkIntentRef.current = true;
    pendingPttRef.current = true;
    setIsRequestingToken(true);
    wsClient.send({ type: 'ptt_request', channelId: selectedChannelId, mode: 'ptt' });
  }, [channelBusy, connectionStatus, fallbackReason, groupId, intercomAlwaysOn, isTransmitting, selectedChannelId]);

  const stopTalking = useCallback(async () => {
    const manager = groupAudioRef.current;
    if (!manager && !isTransmitting && !pendingPttRef.current) return;

    talkIntentRef.current = false;
    pendingPttRef.current = false;
    setIsRequestingToken(false);
    if (manager) {
      await manager.setMicEnabled(false).catch(() => null);
    }
    setIsTransmitting(false);
    wsClient.send({ type: 'ptt_release', channelId: selectedChannelId });
    setQueuePosition(null);

    if (userId) {
      setMembers((prev) => {
        if (!prev[userId]) return prev;
        return {
          ...prev,
          [userId]: {
            ...prev[userId],
            isTalking: false,
          },
        };
      });
      setActiveSpeaker((current) => (current && current.id === userId ? null : current));
    }
  }, [isTransmitting, selectedChannelId, userId]);

  const handleMemberSnapshot = useCallback((message: MemberSnapshotMessage) => {
    const manager = groupAudioRef.current;
    const onlineMembers = (message.members || []).filter((member) => member.online);

    setMembers((prev) => {
      const next: Record<string, MemberState> = {};
      onlineMembers.forEach((member) => {
        const memberId = member.user_id || member.userId;
        if (!memberId) return;
        next[memberId] = {
          id: memberId,
          name: member.name || prev[memberId]?.name || (memberId === userId ? displayName || 'You' : 'Teammate'),
          isTalking: prev[memberId]?.isTalking ?? false,
        };
      });

      if (userId && !next[userId]) {
        next[userId] = {
          id: userId,
          name: displayName || prev[userId]?.name || 'You',
          isTalking: prev[userId]?.isTalking ?? false,
        };
      }

      return next;
    });

    onlineMembers.forEach((member) => {
      const memberId = member.user_id || member.userId;
      if (!memberId || memberId === userId || !manager) return;

      manager.ensurePeer({ userId: memberId, name: member.name }, { createOffer: false }).catch((error) => {
        console.warn('[intercom] ensurePeer from snapshot failed:', error);
      });

      clearRecoveryTimer(memberId);
      if (userId < memberId) {
        recoveryOfferTimersRef.current[memberId] = setTimeout(() => {
          manager.ensurePeer({ userId: memberId, name: member.name }, { createOffer: true }).catch((error) => {
            console.warn('[intercom] delayed recovery offer failed:', error);
          });
          clearRecoveryTimer(memberId);
        }, 1200);
      }
    });
  }, [clearRecoveryTimer, displayName, userId]);

  const handlePresence = useCallback((message: PresenceMessage) => {
    const manager = groupAudioRef.current;
    const memberId = memberIdFromMessage(message);
    if (!memberId) return;

    if (message.type === 'member_joined') {
      upsertMemberFromPresence(message, false);
      if (memberId !== userId && manager) {
        // Only create offer if we're lexicographically smaller —
        // the smaller userId takes initiative to avoid glare.
        const createOffer = userId < memberId;
        manager.ensurePeer({ userId: memberId, name: message.name }, { createOffer }).catch((error) => {
          console.warn('[intercom] ensurePeer on join failed:', error);
        });
      }
      return;
    }

    if (message.type === 'member_left') {
      setMembers((prev) => {
        const next = { ...prev };
        delete next[memberId];
        return next;
      });
      setActiveSpeaker((current) => (current && current.id === memberId ? null : current));
      clearRecoveryTimer(memberId);
      manager?.removePeer(memberId);
    }
  }, [clearRecoveryTimer, memberIdFromMessage, upsertMemberFromPresence, userId]);

  const handleWebRtcSignal = useCallback((message: WebRtcSignalMessage) => {
    const manager = groupAudioRef.current;
    if (!manager || !message?.from_user_id || !message.signal) return;

    manager.handleSignal(message.from_user_id, message.signal).catch((error) => {
      console.warn('[intercom] handleSignal failed:', error);
    });
  }, []);

  const handleMessage = useCallback((message: any) => {
    if (!message?.type) return;

    switch (message.type) {
      case 'members_snapshot':
        handleMemberSnapshot(message as MemberSnapshotMessage);
        break;
      case 'member_joined':
      case 'member_left':
        handlePresence(message as PresenceMessage);
        break;
      case 'webrtc_signal':
        handleWebRtcSignal(message as WebRtcSignalMessage);
        break;
      case 'channels_snapshot': {
        const nextChannels = Array.isArray(message.channels) ? message.channels : [];
        if (nextChannels.length > 0) {
          setChannels(nextChannels);
          const exists = nextChannels.some((channel: any) => channel?.id === selectedChannelId);
          if (!exists) {
            setSelectedChannelId('general');
            wsClient.send({ type: 'channel_select', channelId: 'general' });
          }
          const selected = nextChannels.find((channel: any) => channel?.id === selectedChannelId);
          setSelectedQueueLength(Number(selected?.queue_length || 0));
        }
        break;
      }
      case 'channel_deleted': {
        const deletedChannelId = channelIdFromMessage(message);
        if (deletedChannelId === selectedChannelId) {
          setSelectedChannelId('general');
          setQueuePosition(null);
          wsClient.send({ type: 'channel_select', channelId: 'general' });
        }
        break;
      }
      case 'ptt_queued': {
        const messageChannelId = channelIdFromMessage(message);
        if (messageChannelId !== selectedChannelId) break;
        const position = Number(message.position);
        setQueuePosition(Number.isFinite(position) && position > 0 ? position : null);
        setSelectedQueueLength(Number(message.queue_length || 0));
        break;
      }
      case 'ptt_granted':
      case 'ptt_start': {
        const messageChannelId = channelIdFromMessage(message);
        if (messageChannelId !== selectedChannelId) break;
        const senderId = memberIdFromMessage(message);
        if (!senderId) return;

        if (senderId === userId) {
          setQueuePosition(null);
          pendingPttRef.current = false;
          setIsRequestingToken(false);
          if (!talkIntentRef.current) {
            wsClient.send({ type: 'ptt_release', channelId: messageChannelId });
            break;
          }

          const manager = groupAudioRef.current;
          if (manager) {
            manager.setMicEnabled(true)
              .then(() => {
                setIsTransmitting(true);
                setMembers((prev) => ({
                  ...prev,
                  [senderId]: {
                    id: senderId,
                    name: displayName || prev[senderId]?.name || 'You',
                    isTalking: true,
                  },
                }));
                setActiveSpeaker({ id: senderId, name: displayName || 'You', isTalking: true });
              })
              .catch(async (error) => {
                await manager.setMicEnabled(false).catch(() => null);
                wsClient.send({ type: 'ptt_release', channelId: messageChannelId });
                const text = error instanceof Error ? error.message : String(error);
                setPermissionError(text || 'Unable to access microphone');
              });
          }
        }

        upsertMemberFromPresence(message, true);
        setActiveSpeaker({
          id: senderId,
          name: message?.name || (senderId === userId ? displayName || 'You' : 'Teammate'),
          isTalking: true,
        });
        break;
      }
      case 'ptt_released':
      case 'ptt_end': {
        const messageChannelId = channelIdFromMessage(message);
        if (messageChannelId !== selectedChannelId) break;
        const senderId = memberIdFromMessage(message);
        if (!senderId) return;
        setMembers((prev) => {
          if (!prev[senderId]) return prev;
          return {
            ...prev,
            [senderId]: {
              ...prev[senderId],
              isTalking: false,
            },
          };
        });
        setActiveSpeaker((current) => (current && current.id === senderId ? null : current));
        setChannelBusy(false);
        if (senderId === userId) {
          pendingPttRef.current = false;
          talkIntentRef.current = false;
          setIsTransmitting(false);
          setIsRequestingToken(false);
          groupAudioRef.current?.setMicEnabled(false).catch(() => null);
        }
        break;
      }
      case 'ptt_denied': {
        const messageChannelId = channelIdFromMessage(message);
        if (messageChannelId !== selectedChannelId) break;
        pendingPttRef.current = false;
        talkIntentRef.current = false;
        setIsTransmitting(false);
        setIsRequestingToken(false);
        setQueuePosition(null);
        setChannelBusy(message?.reason !== 'muted');
        groupAudioRef.current?.setMicEnabled(false).catch(() => null);
        if (message?.reason === 'muted') {
          setPermissionError('You are muted in this channel by an admin');
        }
        if (message?.reason !== 'muted') {
          setTimeout(() => setChannelBusy(false), 3000);
        }
        break;
      }
      case 'ptt_force_release': {
        const messageChannelId = channelIdFromMessage(message);
        if (messageChannelId !== selectedChannelId) break;
        talkIntentRef.current = false;
        pendingPttRef.current = false;
        setIsTransmitting(false);
        setIsRequestingToken(false);
        setQueuePosition(null);
        groupAudioRef.current?.setMicEnabled(false).catch(() => null);
        break;
      }
      case 'ptt_busy': {
        setChannelBusy(true);
        pendingPttRef.current = false;
        talkIntentRef.current = false;
        setIsRequestingToken(false);
        setQueuePosition(null);
        groupAudioRef.current?.setMicEnabled(false).catch(() => null);
        setIsTransmitting(false);
        setActiveSpeaker(null);
        if (userId) {
          setMembers((prev) => {
            if (!prev[userId]) return prev;
            return {
              ...prev,
              [userId]: {
                ...prev[userId],
                isTalking: false,
              },
            };
          });
        }
        setTimeout(() => setChannelBusy(false), 3000);
        break;
      }
      default:
        break;
    }
  }, [
    channelIdFromMessage,
    displayName,
    handleMemberSnapshot,
    handlePresence,
    handleWebRtcSignal,
    memberIdFromMessage,
    selectedChannelId,
    upsertMemberFromPresence,
    userId,
  ]);

  useEffect(() => {
    let mounted = true;

    const loadIdentity = async () => {
      try {
        const entries = await AsyncStorage.multiGet(STORAGE_KEYS);
        if (!mounted) return;
        const values = Object.fromEntries(entries);
        setIdentity({
          userId: (values.userId as string) || '',
          groupId: (values.groupId as string) || '',
          name: (values.displayName as string) || '',
        });
        setIntercomAlwaysOn(values.intercomAlwaysOn === 'true');
      } catch (error) {
        console.warn('Failed to load intercom identity', error);
      }
    };

    loadIdentity();

    return () => {
      mounted = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      AsyncStorage.getItem('intercomAlwaysOn')
        .then((value) => {
          if (active) {
            setIntercomAlwaysOn(value === 'true');
          }
        })
        .catch(() => null);
      return () => {
        active = false;
      };
    }, [])
  );

  useEffect(() => {
    if (!userId || !groupId) return;
    wsClient.connect(userId, groupId, displayName);
    setSelectedChannelId('general');
    setQueuePosition(null);
    return () => {
      wsClient.disconnect();
    };
  }, [displayName, groupId, userId]);

  useEffect(() => {
    if (connectionStatus !== 'connected' || !groupId) return;
    wsClient.send({ type: 'channels_list' });
    wsClient.send({ type: 'channel_select', channelId: selectedChannelId });
  }, [connectionStatus, groupId, selectedChannelId]);

  useEffect(() => {
    const selected = channels.find((channel) => channel.id === selectedChannelId);
    setSelectedQueueLength(Number(selected?.queue_length || 0));
  }, [channels, selectedChannelId]);

  useEffect(() => {
    if (!userId) return;
    setMembers((prev) => ({
      ...prev,
      [userId]: {
        id: userId,
        name: displayName || prev[userId]?.name || 'You',
        isTalking: prev[userId]?.isTalking ?? false,
      },
    }));
  }, [displayName, userId]);

  useEffect(() => {
    if (!userId || !groupId || connectionStatus !== 'connected') return;
    initializeGroupAudio(identity).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setPermissionError(message || 'Unable to initialize audio');
    });
  }, [connectionStatus, groupId, identity, initializeGroupAudio, userId]);

  useEffect(() => {
    return () => {
      teardownGroupAudio();
    };
  }, [teardownGroupAudio]);

  useEffect(() => {
    const statusListener = (payload: any) => {
      setConnectionStatus((payload?.state as any) || 'closed');
    };

    wsClient.on('status', statusListener);
    wsClient.on('message', handleMessage);

    return () => {
      wsClient.off('status', statusListener);
      wsClient.off('message', handleMessage);
    };
  }, [handleMessage]);

  useEffect(() => {
    const unsubscribe = wsClient.onSignalQuality((quality) => {
      const now = Date.now();
      setSignalQuality((prev) => {
        let reconnectCount = quality.reconnectCount;
        if (quality.reconnectCount > 0) {
          reconnectBadgeUntilRef.current = now + RECENT_RECONNECT_BADGE_MS;
        } else if (prev.reconnectCount > 0 && now < reconnectBadgeUntilRef.current) {
          reconnectCount = prev.reconnectCount;
        } else {
          reconnectBadgeUntilRef.current = 0;
        }

        return { ...quality, reconnectCount };
      });
      groupAudioRef.current?.setSignalTier(quality.tier).catch((error) => {
        console.warn('[intercom] setSignalTier failed:', error);
      });
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const manager = groupAudioRef.current;
    if (!manager) return;

    const alwaysOnActive = intercomAlwaysOn && !fallbackReason && connectionStatus === 'connected' && appState === 'active';
    const nextMode: GroupAudioMode = alwaysOnActive ? 'always_on' : 'ptt';
    manager.setMode(nextMode).catch((error) => {
      console.warn('[intercom] setMode failed:', error);
    });
  }, [appState, connectionStatus, fallbackReason, intercomAlwaysOn]);

  useEffect(() => {
    const handleAppState = (nextState: AppStateStatus) => {
      setAppState(nextState);
      const manager = groupAudioRef.current;
      if (!manager) return;

      if (nextState !== 'active') {
        if (isTransmitting || pendingPttRef.current) {
          stopTalking().catch(() => null);
        }
        manager.setMicEnabled(false).catch(() => null);
        return;
      }

      if (manager.getMode() === 'always_on' && !fallbackReason) {
        manager.setMicEnabled(true).catch(() => null);
      }
    };

    const subscription = AppState.addEventListener('change', handleAppState);
    return () => {
      subscription.remove();
    };
  }, [fallbackReason, isTransmitting, stopTalking]);

  useEffect(() => {
    let animation: Animated.CompositeAnimation | null = null;
    if (activeSpeaker) {
      animation = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseScale, { toValue: 1.1, duration: 500, useNativeDriver: true }),
          Animated.timing(pulseScale, { toValue: 1, duration: 500, useNativeDriver: true }),
        ])
      );
      animation.start();
    } else {
      pulseScale.setValue(1);
    }

    return () => {
      animation?.stop();
    };
  }, [activeSpeaker, pulseScale]);

  const alwaysOnActive = intercomAlwaysOn && !fallbackReason;
  const buttonDisabled = !groupId || connectionStatus !== 'connected' || alwaysOnActive;

  const memberList = useMemo(() => {
    return Object.values(members).sort((a, b) => {
      if (a.id === userId) return -1;
      if (b.id === userId) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [members, userId]);

  const statusText = groupId
    ? connectionStatus === 'connected'
      ? alwaysOnActive
        ? 'Always-on intercom active'
        : `Connected to #${selectedChannelId}`
      : 'Connecting to intercom...'
    : 'Join a group to enable intercom';

  const signalColor = signalQuality.tier === 'excellent'
    ? '#4caf50'
    : signalQuality.tier === 'good'
      ? '#8bc34a'
      : signalQuality.tier === 'fair'
        ? '#ffb300'
        : '#ff7043';

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scrollArea} contentContainerStyle={styles.scrollContent} bounces={false}>
        <View style={styles.infoBanner}>
          <Text style={styles.infoText}>📱 Voice works phone-to-phone · BLE iPod for testing only</Text>
        </View>

        <View style={styles.channelCard}>
          <Text style={styles.heading}>Channels</Text>
          <View style={styles.channelList}>
            {channels.map((channel) => {
              const isActive = channel.id === selectedChannelId;
              const label = channel.name || channel.id;
              const hasQueue = Number(channel.queue_length || 0) > 0;
              return (
                <Pressable
                  key={channel.id}
                  disabled={isTransmitting}
                  onPress={() => {
                    setSelectedChannelId(channel.id);
                    setQueuePosition(null);
                    wsClient.send({ type: 'channel_select', channelId: channel.id });
                  }}
                  style={[styles.channelChip, isActive && styles.channelChipActive, isTransmitting && styles.channelChipDisabled]}
                >
                  <Text style={[styles.channelChipText, isActive && styles.channelChipTextActive]}>{label}</Text>
                  {hasQueue ? (
                    <View style={[styles.queueBadge, isActive && styles.queueBadgeActive]}>
                      <Text style={styles.queueBadgeText}>{Number(channel.queue_length || 0)}</Text>
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.heading}>Group Members</Text>
          <FlatList
            data={memberList}
            keyExtractor={(item) => item.id}
            scrollEnabled={false}
            ListEmptyComponent={<Text style={styles.emptyText}>Waiting for teammates to join...</Text>}
            renderItem={({ item }) => (
              <View style={styles.memberRow}>
                <View style={styles.memberInfo}>
                  <View style={styles.onlineDot} />
                  <Text style={styles.memberName}>{item.name}</Text>
                </View>
                {item.isTalking ? (
                  <View style={styles.waveform}>
                    <View style={styles.waveBar} />
                    <View style={[styles.waveBar, styles.waveBarTall]} />
                    <View style={styles.waveBar} />
                  </View>
                ) : (
                  <Text style={styles.memberStatus}>Ready</Text>
                )}
              </View>
            )}
          />
        </View>

        <View style={styles.speakerCard}>
          <Text style={styles.heading}>Now Talking</Text>
          {activeSpeaker ? (
            <View style={styles.speakerRow}>
              <Animated.View style={[styles.pulseCircle, { transform: [{ scale: pulseScale }] }]} />
              <Text style={styles.speakerName}>{activeSpeaker.name}</Text>
            </View>
          ) : (
            <Text style={styles.emptyText}>Channel is clear</Text>
          )}
        </View>
      </ScrollView>

      <View style={styles.controls}>
        {fallbackReason ? (
          <View style={styles.fallbackBanner}>
            <Text style={styles.fallbackText}>
              Always-on fallback: {fallbackReason === 'low_signal' ? 'signal is weak' : 'peer link unstable'}.
            </Text>
          </View>
        ) : null}
        <View style={styles.signalRow}>
          <View style={[styles.signalDot, { backgroundColor: signalColor }]} />
          <Text style={styles.signalText}>
            Signal {signalQuality.tier.toUpperCase()}
            {signalQuality.rttMs != null ? ` · ${Math.round(signalQuality.rttMs)}ms` : ''}
            {signalQuality.reconnectCount > 0 ? ` · R${signalQuality.reconnectCount}` : ''}
          </Text>
        </View>
        {channelBusy ? (
          <Text style={styles.busyText}>Channel busy — someone else is talking</Text>
        ) : (
          <Text style={styles.status}>
            {statusText}
            {groupAudioMode === 'fallback' ? ' (PTT fallback)' : ''}
          </Text>
        )}
        {queuePosition ? (
          <Text style={styles.queueStatus}>In queue for #{selectedChannelId}: position {queuePosition}</Text>
        ) : selectedQueueLength > 0 ? (
          <Text style={styles.queueStatus}>Queue waiting in #{selectedChannelId}: {selectedQueueLength}</Text>
        ) : null}
        <Pressable
          onPressIn={startTalking}
          onPressOut={stopTalking}
          disabled={buttonDisabled}
          style={({ pressed }) => [
            styles.pttButton,
            (isTransmitting || pressed) && styles.pttButtonActive,
            buttonDisabled && styles.pttButtonDisabled,
          ]}
        >
          <Text style={styles.pttLabel}>
            {alwaysOnActive
              ? 'ALWAYS-ON ENABLED'
              : isTransmitting
                ? 'RELEASE TO SEND'
                : isRequestingToken
                  ? 'REQUESTING TOKEN...'
                  : 'HOLD TO TALK'}
          </Text>
        </Pressable>
        {permissionError ? <Text style={styles.errorText}>{permissionError}</Text> : null}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#06121f',
  },
  scrollArea: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    gap: 16,
    paddingBottom: 100,
  },
  infoBanner: {
    backgroundColor: '#0d2034',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderLeftWidth: 3,
    borderLeftColor: '#1e88e5',
  },
  infoText: {
    color: '#9fb4cc',
    fontSize: 13,
  },
  card: {
    backgroundColor: '#10243b',
    borderRadius: 16,
    padding: 16,
  },
  channelCard: {
    backgroundColor: '#10243b',
    borderRadius: 16,
    padding: 16,
  },
  channelList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  channelChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    backgroundColor: '#0d2034',
    borderWidth: 1,
    borderColor: '#1e3a5f',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  channelChipActive: {
    backgroundColor: '#1e88e5',
    borderColor: '#64b5f6',
  },
  channelChipDisabled: {
    opacity: 0.65,
  },
  channelChipText: {
    color: '#9fb4cc',
    fontWeight: '700',
    fontSize: 13,
  },
  channelChipTextActive: {
    color: '#ffffff',
  },
  queueBadge: {
    minWidth: 18,
    borderRadius: 9,
    backgroundColor: '#26384f',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  queueBadgeActive: {
    backgroundColor: '#0d2034',
  },
  queueBadgeText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '800',
  },
  heading: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
  },
  memberRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1e3a5f',
  },
  memberInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  onlineDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#4caf50',
  },
  memberName: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  memberStatus: {
    color: '#9fb4cc',
    fontSize: 14,
  },
  waveform: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 4,
  },
  waveBar: {
    width: 6,
    height: 12,
    borderRadius: 3,
    backgroundColor: '#ff9800',
  },
  waveBarTall: {
    height: 20,
  },
  emptyText: {
    color: '#7f8ea3',
    textAlign: 'center',
    marginTop: 8,
  },
  speakerCard: {
    backgroundColor: '#0d2034',
    borderRadius: 16,
    padding: 16,
  },
  speakerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  pulseCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#ff9800',
    shadowColor: '#ff9800',
    shadowOpacity: 0.7,
    shadowRadius: 14,
  },
  speakerName: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  controls: {
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingBottom: 16,
    backgroundColor: '#06121f',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#1e3a5f',
  },
  fallbackBanner: {
    backgroundColor: '#3f2a18',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ff9800',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  fallbackText: {
    color: '#ffd180',
    fontSize: 12,
    fontWeight: '600',
  },
  signalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  signalDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  signalText: {
    color: '#9fb4cc',
    fontSize: 12,
    fontWeight: '600',
  },
  status: {
    color: '#9fb4cc',
  },
  queueStatus: {
    color: '#64ffda',
    fontSize: 12,
    fontWeight: '600',
  },
  busyText: {
    color: '#ff9800',
    fontWeight: '600',
    fontSize: 14,
    textAlign: 'center',
  },
  pttButton: {
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: '#1e88e5',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#1e88e5',
    shadowOpacity: 0.6,
    shadowRadius: 20,
  },
  pttButtonActive: {
    backgroundColor: '#1565c0',
  },
  pttButtonDisabled: {
    opacity: 0.4,
  },
  pttLabel: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 18,
  },
  errorText: {
    color: '#ff8a80',
  },
});

export default IntercomScreen;
