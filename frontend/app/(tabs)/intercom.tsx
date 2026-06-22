import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';

import wsClient from '../services/ws';
import bleBridge from '../services/ble';

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
  const [isRecording, setIsRecording] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);

  const recordingRef = useRef<Audio.Recording | null>(null);
  const playbackQueue = useRef(Promise.resolve());
  const pulseScale = useRef(new Animated.Value(1)).current;

  const { userId, groupId, name: displayName } = identity;

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
          name: (values.displayName as string) || ''
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
    if (!userId) return;
    setMembers((prev) => ({
      ...prev,
      [userId]: {
        id: userId,
        name: displayName || prev[userId]?.name || 'You',
        isTalking: prev[userId]?.isTalking ?? false
      }
    }));
  }, [displayName, userId]);

  useEffect(() => {
    return () => {
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => null);
      }
    };
  }, []);

  const enqueuePlayback = useCallback((base64Data: string) => {
    if (!base64Data) return;
    playbackQueue.current = playbackQueue.current.then(async () => {
      const cacheDir = FileSystem.cacheDirectory ?? '';
      const tempFile = `${cacheDir}ptt-${Date.now()}-${Math.random().toString(36).slice(2)}.aac`;
      try {
        await FileSystem.writeAsStringAsync(tempFile, base64Data, {
          encoding: FileSystem.EncodingType.Base64
        });
        // Switch audio session to playback mode before playing
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
          interruptionModeIOS: InterruptionModeIOS.DoNotMix,
          interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
          shouldDuckAndroid: true,
          playThroughEarpieceAndroid: false,
          staysActiveInBackground: false,
        });
        const { sound } = await Audio.Sound.createAsync(
          { uri: tempFile },
          { shouldPlay: true }  // play immediately on load
        );
        await new Promise<void>((resolve) => {
          sound.setOnPlaybackStatusUpdate((status) => {
            if (!status.isLoaded) return;
            if (status.didJustFinish) {  // only resolve when actually finished
              sound.setOnPlaybackStatusUpdate(null);
              resolve();
            }
          });
        });
        await sound.unloadAsync();
      } catch (error) {
        console.warn('Failed to play audio chunk', error);
      } finally {
        await FileSystem.deleteAsync(tempFile, { idempotent: true }).catch(() => null);
      }
    });
  }, []);

  const handleMessage = useCallback((message: any) => {
    if (!message?.type) return;
    const { userId: senderId, name } = message;

    switch (message.type) {
      case 'member_joined':
        if (!senderId) return;
        setMembers((prev) => ({
          ...prev,
          [senderId]: {
            id: senderId,
            name: name || prev[senderId]?.name || 'Teammate',
            isTalking: prev[senderId]?.isTalking ?? false
          }
        }));
        break;
      case 'member_left':
        if (!senderId) return;
        setMembers((prev) => {
          const next = { ...prev };
          delete next[senderId];
          return next;
        });
        setActiveSpeaker((current) => (current && current.id === senderId ? null : current));
        break;
      case 'ptt_start':
        if (!senderId) return;
        setMembers((prev) => ({
          ...prev,
          [senderId]: {
            id: senderId,
            name: name || prev[senderId]?.name || 'Teammate',
            isTalking: true
          }
        }));
        setActiveSpeaker({ id: senderId, name: name || 'Teammate', isTalking: true });
        break;
      case 'ptt_end':
        if (!senderId) return;
        setMembers((prev) => {
          if (!prev[senderId]) return prev;
          return {
            ...prev,
            [senderId]: {
              ...prev[senderId],
              isTalking: false
            }
          };
        });
        setActiveSpeaker((current) => (current && current.id === senderId ? null : current));
        break;
      case 'audio_chunk':
        if (typeof message.data === 'string') {
          enqueuePlayback(message.data);
        }
        break;
      default:
        break;
    }
  }, [enqueuePlayback]);

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
          Animated.timing(pulseScale, { toValue: 1, duration: 500, useNativeDriver: true })
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

  const startRecording = useCallback(async () => {
    if (isRecording || !groupId || connectionStatus !== 'connected') return;
    try {
      setPermissionError(null);
      const permission = await Audio.requestPermissionsAsync();
      if (permission.status !== 'granted') {
        setPermissionError('Microphone permission denied');
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        interruptionModeIOS: InterruptionModeIOS.DoNotMix,
        interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
        staysActiveInBackground: false
      });

      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync({
        isMeteringEnabled: false,
        android: {
          extension: '.aac',
          outputFormat: Audio.AndroidOutputFormat.AAC_ADTS,
          audioEncoder: Audio.AndroidAudioEncoder.AAC,
          sampleRate: 16000,
          numberOfChannels: 1,
          bitRate: 32000,
        },
        ios: {
          extension: '.aac',
          outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
          audioQuality: Audio.IOSAudioQuality.MEDIUM,
          sampleRate: 16000,
          numberOfChannels: 1,
          bitRate: 32000,
          linearPCMBitDepth: 16,
          linearPCMIsBigEndian: false,
          linearPCMIsFloat: false,
        },
        web: {
          mimeType: 'audio/webm',
          bitsPerSecond: 32000,
        },
      });
      await recording.startAsync();
      recordingRef.current = recording;
      setIsRecording(true);

      wsClient.send({ type: 'ptt_start' });
      if (userId) {
        setMembers((prev) => ({
          ...prev,
          [userId]: {
            id: userId,
            name: displayName || prev[userId]?.name || 'You',
            isTalking: true
          }
        }));
        setActiveSpeaker({ id: userId, name: displayName || 'You', isTalking: true });
      }
    } catch (error) {
      console.error('Failed to start recording', error);
      setPermissionError('Unable to access microphone');
    }
  }, [connectionStatus, displayName, groupId, isRecording, userId]);

  const stopRecording = useCallback(async () => {
    const activeRecording = recordingRef.current;
    if (!activeRecording && !isRecording) return;

    try {
      if (activeRecording) {
        await activeRecording.stopAndUnloadAsync();
        const uri = activeRecording.getURI();
        if (uri) {
          const base64 = await FileSystem.readAsStringAsync(uri, {
            encoding: FileSystem.EncodingType.Base64
          });
          if (base64) {
            wsClient.send({ type: 'audio_chunk', data: base64 });
            bleBridge.mirrorPttChunk(base64);
          }
          await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => null);
        }
      }
    } catch (error) {
      console.error('Failed to stop recording', error);
    } finally {
      recordingRef.current = null;
      setIsRecording(false);
      // Restore audio session to playback mode so incoming audio can be heard
      Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        interruptionModeIOS: InterruptionModeIOS.DoNotMix,
        interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
        staysActiveInBackground: false,
      }).catch(() => null);
      wsClient.send({ type: 'ptt_end' });
      if (userId) {
        setMembers((prev) => {
          if (!prev[userId]) return prev;
          return {
            ...prev,
            [userId]: {
              ...prev[userId],
              isTalking: false
            }
          };
        });
        setActiveSpeaker((current) => (current && current.id === userId ? null : current));
      }
    }
  }, [isRecording, userId]);

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

      {/* PTT controls fixed to bottom — never scrolls off-screen (#34) */}
      <View style={styles.controls}>
        <Text style={styles.status}>{statusText}</Text>
        <Pressable
          onPressIn={startRecording}
          onPressOut={stopRecording}
          disabled={buttonDisabled}
          style={({ pressed }) => [
            styles.pttButton,
            (isRecording || pressed) && styles.pttButtonActive,
            buttonDisabled && styles.pttButtonDisabled
          ]}
        >
          <Text style={styles.pttLabel}>{isRecording ? 'RELEASE TO SEND' : 'HOLD TO TALK'}</Text>
        </Pressable>
        {permissionError ? <Text style={styles.errorText}>{permissionError}</Text> : null}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#06121f'
  },
  scrollArea: {
    flex: 1
  },
  scrollContent: {
    padding: 16,
    gap: 16,
    paddingBottom: 100 // space for bottom PTT bar
  },
  infoBanner: {
    backgroundColor: '#0d2034',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderLeftWidth: 3,
    borderLeftColor: '#1e88e5'
  },
  infoText: {
    color: '#9fb4cc',
    fontSize: 13
  },
  card: {
    backgroundColor: '#10243b',
    borderRadius: 16,
    padding: 16
  },
  heading: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12
  },
  memberRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1e3a5f'
  },
  memberInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  onlineDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#4caf50'
  },
  memberName: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600'
  },
  memberStatus: {
    color: '#9fb4cc',
    fontSize: 14
  },
  waveform: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 4
  },
  waveBar: {
    width: 6,
    height: 12,
    borderRadius: 3,
    backgroundColor: '#ff9800'
  },
  waveBarTall: {
    height: 20
  },
  emptyText: {
    color: '#7f8ea3',
    textAlign: 'center',
    marginTop: 8
  },
  speakerCard: {
    backgroundColor: '#0d2034',
    borderRadius: 16,
    padding: 16
  },
  speakerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16
  },
  pulseCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#ff9800',
    shadowColor: '#ff9800',
    shadowOpacity: 0.7,
    shadowRadius: 14
  },
  speakerName: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700'
  },
  controls: {
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingBottom: 16,
    backgroundColor: '#06121f',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#1e3a5f'
  },
  status: {
    color: '#9fb4cc'
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
    shadowRadius: 20
  },
  pttButtonActive: {
    backgroundColor: '#1565c0'
  },
  pttButtonDisabled: {
    opacity: 0.4
  },
  pttLabel: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 18
  },
  errorText: {
    color: '#ff8a80'
  }
});

export default IntercomScreen;
