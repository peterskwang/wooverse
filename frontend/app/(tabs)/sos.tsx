import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';

import api from '../services/api';
import wsClient from '../services/ws';

const SosScreen = () => {
  const [sending, setSending] = useState(false);
  const [active, setActive] = useState(false);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    let subscription: Location.LocationSubscription | null = null;

    const init = async () => {
      try {
        const stored = await AsyncStorage.getItem('groupId');
        if (mounted) setGroupId(stored);

        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          if (mounted) setLocationError('Location permission denied — needed for SOS');
          return;
        }

        subscription = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, timeInterval: 5000, distanceInterval: 10 },
          (loc) => {
            if (mounted) {
              setCoords({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
              setLocationError(null);
            }
          }
        );
      } catch (error: any) {
        if (mounted) setLocationError(error.message || 'Location unavailable');
      }
    };

    init();
    return () => {
      mounted = false;
      subscription?.remove();
    };
  }, []);

  const triggerSos = useCallback(() => {
    if (!groupId) {
      Alert.alert('No Group', 'Join a group before sending an SOS alert.');
      return;
    }
    if (!coords) {
      Alert.alert('No GPS', 'Waiting for GPS lock. Try again in a moment.');
      return;
    }
    // Capture coordinates at confirm time to avoid stale-closure (#28)
    const latestCoords = coords;
    Alert.alert('Confirm SOS', 'Are you sure you want to send an SOS to your group?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Send SOS', style: 'destructive', onPress: () => sendSos(latestCoords) }
    ]);
  }, [groupId, coords]);

  const sendSos = useCallback(async (latestCoords: { latitude: number; longitude: number }) => {
    if (sending || !groupId) return;
    try {
      setSending(true);
      // Send via HTTP with lat/lng (#28)
      await api.post('/api/sos', {
        group_id: groupId,
        lat: latestCoords.latitude,
        lng: latestCoords.longitude
      });
      // Also broadcast via WebSocket so connected peers get it instantly
      wsClient.send({
        type: 'sos',
        ts: Date.now(),
        payload: {
          lat: latestCoords.latitude,
          lng: latestCoords.longitude
        }
      });
      setActive(true);
    } catch (error: any) {
      console.error('SOS failed', error);
      const message = error?.response?.data?.error || error?.message || 'Could not reach the server.';
      Alert.alert('SOS Failed', message);
    } finally {
      setSending(false);
    }
  }, [sending, groupId]);

  const ready = Boolean(groupId && coords);

  return (
    <View style={styles.container}>
      <Pressable
        onLongPress={triggerSos}
        delayLongPress={1500}
        disabled={sending}
        style={({ pressed }) => [
          styles.sosButton,
          pressed && styles.sosButtonPressed,
          active && styles.activeButton,
          !ready && styles.disabledButton
        ]}
      >
        {sending ? (
          <ActivityIndicator color="#fff" size="large" />
        ) : (
          <Text style={styles.sosLabel}>SOS</Text>
        )}
      </Pressable>
      <Text style={styles.helper}>Long press 1.5s to alert your squad.</Text>
      {!groupId && <Text style={styles.warningText}>Join a group first</Text>}
      {groupId && !coords && !locationError && (
        <Text style={styles.warningText}>Acquiring GPS…</Text>
      )}
      {locationError && <Text style={styles.errorText}>{locationError}</Text>}
      {active && <Text style={styles.activeText}>SOS SENT</Text>}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#06121f',
    paddingHorizontal: 24,
    gap: 16
  },
  sosButton: {
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: '#d32f2f',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#d32f2f',
    shadowOpacity: 0.7,
    shadowRadius: 18
  },
  sosButtonPressed: { backgroundColor: '#b71c1c' },
  activeButton: { backgroundColor: '#7f1d1d' },
  disabledButton: { opacity: 0.5 },
  sosLabel: { color: '#fff', fontSize: 48, fontWeight: '900' },
  helper: { color: '#f8bbd0', textAlign: 'center' },
  warningText: { color: '#ffb74d', textAlign: 'center', fontSize: 14 },
  errorText: { color: '#ff8a80', textAlign: 'center', fontSize: 14 },
  activeText: { color: '#ff8a80', fontWeight: '700', fontSize: 16 }
});

export default SosScreen;
