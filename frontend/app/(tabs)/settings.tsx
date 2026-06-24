import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import * as Clipboard from 'expo-clipboard';
import * as Location from 'expo-location';

import api from '../services/api';
import bleBridge, { WooverseDevice } from '../services/ble';
import {
  isBackgroundLocationRunning,
  startBackgroundLocationTask,
  stopBackgroundLocationTask
} from '../services/backgroundLocation';

const SettingsScreen = () => {
  const router = useRouter();

  const [displayName, setDisplayName] = useState('');
  const [editedName, setEditedName] = useState('');
  const [alwaysOn, setAlwaysOn] = useState(false);
  const [intercomAlwaysOn, setIntercomAlwaysOn] = useState(false);
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [pairedDevice, setPairedDevice] = useState<WooverseDevice | null>(null);
  const [bleConnected, setBleConnected] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState<WooverseDevice[]>([]);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [currentGroup, setCurrentGroup] = useState<{ name: string; invite_code: string } | null>(null);
  const [groupLoading, setGroupLoading] = useState(false);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const [[, name], [, alwaysOnVal], [, intercomAlwaysOnVal]] = await AsyncStorage.multiGet(['displayName', 'alwaysOn', 'intercomAlwaysOn']);
        setDisplayName(name || '');
        setEditedName(name || '');
        const running = await isBackgroundLocationRunning();
        setAlwaysOn(running);
        setIntercomAlwaysOn(intercomAlwaysOnVal === 'true');
        if (alwaysOnVal === 'true' && !running) {
          await AsyncStorage.setItem('alwaysOn', 'false');
        }
      } catch (error) {
        console.warn('Failed to load settings', error);
      }
    };
    loadSettings();
  }, []);

  useEffect(() => {
    const loadGroupInfo = async () => {
      try {
        setGroupLoading(true);
        const response = await api.get('/api/groups/mine');
        const groups = response.data;
        if (Array.isArray(groups) && groups.length > 0) {
          const group = groups[0];
          setCurrentGroup({ name: group.name, invite_code: group.invite_code });
        } else {
          setCurrentGroup(null);
        }
      } catch (error) {
        console.warn('[settings] Failed to load group info', error);
      } finally {
        setGroupLoading(false);
      }
    };
    loadGroupInfo();
  }, []);

  useEffect(() => {
    const unsubscribe = bleBridge.subscribe((status) => {
      setPairedDevice(status.pairedDevice || null);
      setBleConnected(status.connected);
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  const handleSaveName = useCallback(async () => {
    const trimmed = editedName.trim();
    if (!trimmed) {
      Alert.alert('Display name cannot be empty');
      return;
    }
    try {
      setSaving(true);
      setSaveSuccess(false);
      await api.patch('/api/auth/users/me', { name: trimmed });
      await AsyncStorage.setItem('displayName', trimmed);
      setDisplayName(trimmed);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (error: any) {
      Alert.alert('Failed to save', error?.response?.data?.error || error?.message || 'Server error');
    } finally {
      setSaving(false);
    }
  }, [editedName]);

  const handleToggleAlwaysOn = useCallback(async (value: boolean) => {
    if (value) {
      try {
        const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
        if (fgStatus !== 'granted') {
          Alert.alert('Permission Required', 'Location permission is required for Always-On Mode.');
          return;
        }

        const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
        if (bgStatus !== 'granted') {
          Alert.alert(
            'Background Permission Denied',
            'Wooverse needs "Always" location access for Always-On Mode. Enable it in Settings > Wooverse > Location > Always.'
          );
          return;
        }

        await startBackgroundLocationTask();
        setAlwaysOn(true);
        await AsyncStorage.setItem('alwaysOn', 'true');
      } catch (error: any) {
        console.error('[settings] Failed to start background GPS:', error?.message);
        Alert.alert('Error', 'Could not start background location tracking.');
      }
    } else {
      try {
        await stopBackgroundLocationTask();
      } catch (error) {
        console.warn('[settings] Failed to stop background GPS:', error);
      }
      setAlwaysOn(false);
      await AsyncStorage.setItem('alwaysOn', 'false');
    }
  }, []);

  const handleToggleIntercomAlwaysOn = useCallback(async (value: boolean) => {
    setIntercomAlwaysOn(value);
    await AsyncStorage.setItem('intercomAlwaysOn', value ? 'true' : 'false');
  }, []);

  const handleLeaveGroup = useCallback(() => {
    Alert.alert(
      'Leave Group',
      'You will leave this group but your account stays active. You can join or create a new group anytime.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: async () => {
            try {
              setLeaving(true);
              const groupId = await AsyncStorage.getItem('groupId');
              if (groupId) {
                try {
                  await api.post(`/api/groups/${groupId}/leave`);
                } catch (error) {
                  console.warn('Leave group API failed (proceeding anyway)', error);
                }
              }
              try {
                await stopBackgroundLocationTask();
              } catch (error) {
                console.warn('[settings] Stop BG GPS on leave failed:', error);
              }
              await AsyncStorage.multiRemove(['groupId', 'alwaysOn']);
              router.replace('/group-setup');
            } catch (error: any) {
              Alert.alert('Error', error?.message || 'Failed to leave group');
            } finally {
              setLeaving(false);
            }
          }
        }
      ]
    );
  }, [router]);

  const handleScanForDevices = useCallback(async () => {
    setScanning(true);
    setPairError(null);
    try {
      const devices = await bleBridge.scanForDevices(5000);
      setScanResults(devices);
      if (!devices.length) {
        setPairError('No Wooverse devices found nearby.');
      }
    } catch (error: any) {
      setPairError(error?.message || 'Scan failed');
    } finally {
      setScanning(false);
    }
  }, []);

  const handleConnectDevice = useCallback(async (device: WooverseDevice) => {
    setConnectingId(device.id);
    setPairError(null);
    try {
      await bleBridge.connectToDevice(device);
      setScanResults([]);
    } catch (error: any) {
      setPairError(error?.message || 'Failed to pair with device');
    } finally {
      setConnectingId(null);
    }
  }, []);

  const handleUnpair = useCallback(async () => {
    setConnectingId('disconnect');
    try {
      await bleBridge.disconnect();
    } catch (error: any) {
      setPairError(error?.message || 'Failed to disconnect');
    } finally {
      setConnectingId(null);
    }
  }, []);

  const handleCopyGroupCode = useCallback(async () => {
    if (!currentGroup) return;
    await Clipboard.setStringAsync(currentGroup.invite_code);
    Alert.alert('Copied!', `Code ${currentGroup.invite_code} copied.`);
  }, [currentGroup]);

  const handleShareGroupCode = useCallback(async () => {
    if (!currentGroup) return;
    await Share.share({
      message: `Join my Wooverse group "${currentGroup.name}" with code: ${currentGroup.invite_code}`
    });
  }, [currentGroup]);

  const handleLogout = useCallback(() => {
    Alert.alert(
      'Logout',
      'Are you sure you want to log out?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Logout',
          style: 'destructive',
          onPress: async () => {
            try {
              await stopBackgroundLocationTask().catch(() => null);
              await AsyncStorage.multiRemove(['token', 'userId', 'groupId', 'displayName', 'email']);
              router.replace('/login');
            } catch (error: any) {
              Alert.alert('Error', error?.message || 'Failed to logout');
            }
          }
        }
      ]
    );
  }, [router]);

  const nameChanged = editedName.trim() !== displayName;
  const appVersion = Constants.expoConfig?.version || Constants.manifest?.version || '1.0.0';

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Display Name</Text>
        <TextInput
          value={editedName}
          onChangeText={setEditedName}
          style={styles.input}
          placeholder="Enter display name"
          placeholderTextColor="#4a6278"
          autoCapitalize="words"
          editable={!saving}
        />
        {nameChanged ? (
          <Pressable
            onPress={handleSaveName}
            disabled={saving}
            style={({ pressed }) => [styles.saveButton, pressed && styles.saveButtonPressed, saving && styles.saveButtonDisabled]}
          >
            {saving ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.saveButtonText}>Save</Text>
            )}
          </Pressable>
        ) : null}
        {saveSuccess ? <Text style={styles.successText}>Saved!</Text> : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Preferences</Text>
        <View style={styles.row}>
          <View>
            <Text style={styles.rowLabel}>Always-On Mode</Text>
            <Text style={styles.rowSub}>
              {alwaysOn ? 'Broadcasting location in background' : 'GPS stops when app is backgrounded'}
            </Text>
          </View>
          <Switch
            value={alwaysOn}
            onValueChange={handleToggleAlwaysOn}
            trackColor={{ false: '#26445f', true: '#1e88e5' }}
            thumbColor={alwaysOn ? '#64ffda' : '#9fb4cc'}
          />
        </View>
        <View style={styles.row}>
          <View>
            <Text style={styles.rowLabel}>Intercom Always-On</Text>
            <Text style={styles.rowSub}>
              {intercomAlwaysOn ? 'Hands-free voice when signal is stable' : 'Push-to-talk intercom mode'}
            </Text>
          </View>
          <Switch
            value={intercomAlwaysOn}
            onValueChange={handleToggleIntercomAlwaysOn}
            trackColor={{ false: '#26445f', true: '#1e88e5' }}
            thumbColor={intercomAlwaysOn ? '#64ffda' : '#9fb4cc'}
          />
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Bluetooth Intercom</Text>
        <View>
          <Text style={styles.rowLabel}>
            {pairedDevice ? `Paired with ${pairedDevice.name}` : 'No iPod paired yet'}
          </Text>
          <Text style={styles.rowSub}>{bleConnected ? 'Connected and ready' : 'Not connected'}</Text>
        </View>
        <Pressable
          onPress={handleScanForDevices}
          disabled={scanning}
          style={({ pressed }) => [styles.saveButton, pressed && styles.saveButtonPressed, scanning && styles.saveButtonDisabled]}
        >
          {scanning ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveButtonText}>Scan for Devices</Text>}
        </Pressable>
        {pairError ? <Text style={styles.errorText}>{pairError}</Text> : null}
        {scanResults.length ? (
          <View style={styles.deviceList}>
            {scanResults.map((device) => (
              <Pressable
                key={device.id}
                style={({ pressed }) => [styles.deviceRow, pressed && styles.deviceRowPressed]}
                onPress={() => handleConnectDevice(device)}
              >
                <View>
                  <Text style={styles.deviceName}>{device.name || 'Wooverse Device'}</Text>
                  {device.rssi != null ? (
                    <Text style={styles.deviceMeta}>Signal {device.rssi} dBm</Text>
                  ) : null}
                  {device.simulated ? <Text style={styles.deviceMeta}>Simulator</Text> : null}
                </View>
                {connectingId === device.id ? <ActivityIndicator color="#64ffda" /> : null}
              </Pressable>
            ))}
          </View>
        ) : null}
        {pairedDevice ? (
          <Pressable
            onPress={handleUnpair}
            style={({ pressed }) => [styles.leaveButton, pressed && styles.leaveButtonPressed, connectingId === 'disconnect' && styles.saveButtonDisabled]}
          >
            {connectingId === 'disconnect' ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.leaveButtonText}>Unpair</Text>
            )}
          </Pressable>
        ) : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Current Group</Text>
        {groupLoading ? (
          <ActivityIndicator color="#1e88e5" />
        ) : currentGroup ? (
          <>
            <Text style={styles.rowLabel}>{currentGroup.name}</Text>
            <View style={styles.codeRow}>
              <Text style={styles.inviteCode}>{currentGroup.invite_code}</Text>
              <Pressable onPress={handleCopyGroupCode} style={styles.codeAction}>
                <Text style={styles.codeActionText}>Copy</Text>
              </Pressable>
              <Pressable onPress={handleShareGroupCode} style={styles.codeAction}>
                <Text style={styles.codeActionText}>Share</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <Text style={styles.rowSub}>Not in a group</Text>
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Group</Text>
        <Pressable
          onPress={handleLeaveGroup}
          disabled={leaving}
          style={({ pressed }) => [styles.leaveButton, pressed && styles.leaveButtonPressed, leaving && styles.saveButtonDisabled]}
        >
          {leaving ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.leaveButtonText}>Leave Group</Text>
          )}
        </Pressable>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>About</Text>
        <Text style={styles.versionText}>Wooverse v{appVersion}</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Account</Text>
        <Pressable
          onPress={handleLogout}
          style={({ pressed }) => [styles.leaveButton, pressed && styles.leaveButtonPressed]}
        >
          <Text style={styles.leaveButtonText}>Logout</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#06121f' },
  container: { padding: 16, gap: 16 },
  section: { backgroundColor: '#10243b', borderRadius: 16, padding: 16, gap: 12 },
  sectionTitle: { color: '#9fb4cc', fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  input: {
    borderWidth: 1,
    borderColor: '#26445f',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: '#fff',
    backgroundColor: '#0d1f30'
  },
  saveButton: {
    backgroundColor: '#1e88e5',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center'
  },
  saveButtonPressed: { opacity: 0.85 },
  saveButtonDisabled: { opacity: 0.5 },
  saveButtonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  successText: { color: '#4caf50', textAlign: 'center' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowLabel: { color: '#fff', fontSize: 16 },
  rowSub: { color: '#7f8ea3', fontSize: 13, marginTop: 2 },
  errorText: { color: '#ff8a80', textAlign: 'center' },
  deviceList: { gap: 8 },
  deviceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#1e3a5f',
    borderRadius: 12
  },
  deviceRowPressed: { backgroundColor: '#0d1f30' },
  deviceName: { color: '#fff', fontSize: 16, fontWeight: '600' },
  deviceMeta: { color: '#7f8ea3', fontSize: 12 },
  codeRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  inviteCode: { color: '#64ffda', fontSize: 24, fontWeight: '900', letterSpacing: 6, flex: 1 },
  codeAction: {
    backgroundColor: '#13273c',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#26445f'
  },
  codeActionText: { color: '#1e88e5', fontWeight: '700' },
  leaveButton: {
    backgroundColor: '#b71c1c',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center'
  },
  leaveButtonPressed: { opacity: 0.85 },
  leaveButtonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  versionText: { color: '#7f8ea3', fontSize: 14 }
});

export default SettingsScreen;
