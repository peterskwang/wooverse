import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import wsClient, { MemberSnapshotMessage, PresenceMessage, WebRtcSignalMessage } from '../services/ws';
import { GroupAudioManager } from '../services/groupAudio';

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

const STORAGE_KEYS = ['userId', 'groupId', 'displayName'] as const;

const IntercomScreen = () => {
  const [identity, setIdentity] = useState<Identity>({ userId: '', groupId: '', name: '' });
  const [members, setMembers] = useState<Record<string, MemberState>>({});
  const [activeSpeaker, setActiveSpeaker] = useState<MemberState | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'error' | 'closed'>(wsClient.getState());
  const [isTransmitting, setIsTransmitting] = useState(false);
  const [channelBusy, setChannelBusy] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);

  const groupAudioRef = useRef<GroupAudioManager | null>(null);
  const pendingPttRef = useRef(false);
  const recoveryOfferTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
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
        onError: (_peerUserId, error) => {
          console.warn('[intercom] group audio error:', error.message);
        },
      },
    });

    try {
      await manager.start();
      groupAudioRef.current = manager;
      setPermissionError(null);
    } catch (error) {
      manager.dispose();
      const message = error instanceof Error ? error.message : String(error);
      setPermissionError(message || 'Unable to access microphone');
    }
  }, []);

  const teardownGroupAudio = useCallback(() => {
    Object.values(recoveryOfferTimersRef.current).forEach((timer) => clearTimeout(timer));
    recoveryOfferTimersRef.current = {};

    const manager = groupAudioRef.current;
    groupAudioRef.current = null;
    manager?.dispose();
  }, []);

  const startTalking = useCallback(async () => {
    const manager = groupAudioRef.current;
    if (!manager || !groupId || connectionStatus !== 'connected' || isTransmitting || channelBusy) return;

    setPermissionError(null);
    pendingPttRef.current = true;
    wsClient.send({ type: 'ptt_start', mode: 'ptt' });

    try {
      await manager.setMicEnabled(true);
      setIsTransmitting(true);
      if (userId) {
        setMembers((prev) => ({
          ...prev,
          [userId]: {
            id: userId,
            name: displayName || prev[userId]?.name || 'You',
            isTalking: true,
          },
        }));
        setActiveSpeaker({ id: userId, name: displayName || 'You', isTalking: true });
      }
    } catch (error) {
      pendingPttRef.current = false;
      await manager.setMicEnabled(false).catch(() => null);
      wsClient.send({ type: 'ptt_end' });
      const message = error instanceof Error ? error.message : String(error);
      setPermissionError(message || 'Unable to access microphone');
    }
  }, [channelBusy, connectionStatus, displayName, groupId, isTransmitting, userId]);

  const stopTalking = useCallback(async () => {
    const manager = groupAudioRef.current;
    if (!manager && !isTransmitting && !pendingPttRef.current) return;

    pendingPttRef.current = false;
    if (manager) {
      await manager.setMicEnabled(false).catch(() => null);
    }
    setIsTransmitting(false);
    wsClient.send({ type: 'ptt_end' });

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
  }, [isTransmitting, userId]);

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
      case 'ptt_start': {
        const senderId = memberIdFromMessage(message);
        if (!senderId) return;
        upsertMemberFromPresence(message, true);
        setActiveSpeaker({
          id: senderId,
          name: message?.name || (senderId === userId ? displayName || 'You' : 'Teammate'),
          isTalking: true,
        });
        break;
      }
      case 'ptt_end': {
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
        break;
      }
      case 'ptt_busy': {
        setChannelBusy(true);
        pendingPttRef.current = false;
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
  }, [displayName, handleMemberSnapshot, handlePresence, handleWebRtcSignal, memberIdFromMessage, upsertMemberFromPresence, userId]);

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
      } catch (error) {
        console.warn('Failed to load intercom identity', error);
      }
    };

    loadIdentity();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!userId || !groupId) return;
    wsClient.connect(userId, groupId, displayName);
    return () => {
      wsClient.disconnect();
    };
  }, [displayName, groupId, userId]);

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

  const buttonDisabled = !groupId || connectionStatus !== 'connected';

  const memberList = useMemo(() => {
    return Object.values(members).sort((a, b) => {
      if (a.id === userId) return -1;
      if (b.id === userId) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [members, userId]);

  const statusText = groupId
    ? connectionStatus === 'connected'
      ? 'Connected to group intercom'
      : 'Connecting to intercom...'
    : 'Join a group to enable intercom';

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scrollArea} contentContainerStyle={styles.scrollContent} bounces={false}>
        <View style={styles.infoBanner}>
          <Text style={styles.infoText}>📱 Voice works phone-to-phone · BLE iPod for testing only</Text>
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
        {channelBusy ? (
          <Text style={styles.busyText}>Channel busy — someone else is talking</Text>
        ) : (
          <Text style={styles.status}>{statusText}</Text>
        )}
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
          <Text style={styles.pttLabel}>{isTransmitting ? 'RELEASE TO SEND' : 'HOLD TO TALK'}</Text>
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
  status: {
    color: '#9fb4cc',
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
