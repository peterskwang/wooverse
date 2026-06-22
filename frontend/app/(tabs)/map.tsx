import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WebView } from 'react-native-webview';

import api from '../services/api';
import {
  Coordinates,
  startLocationTracking,
  stopLocationTracking
} from '../services/location';
import runEngine, { RunSnapshot } from '../services/runEngine';
import wsClient from '../services/ws';

interface Teammate {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

const MAP_HTML = `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="initial-scale=1, maximum-scale=1" />
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <style>
      html, body, #map { height: 100%; margin: 0; padding: 0; background: #02101f; }
      .teammate-label {
        background: rgba(255,152,0,0.9);
        color: #02101f;
        border-radius: 12px;
        padding: 4px 10px;
        font-size: 12px;
        font-weight: 700;
        white-space: nowrap;
        border: none;
        box-shadow: none;
      }
    </style>
  </head>
  <body>
    <div id="map"></div>
    <script>
      var map = L.map('map', { zoomControl: true }).setView([22.3193, 114.1694], 12);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19
      }).addTo(map);

      var userMarker = null;
      var teammateMarkers = {};

      var userIcon = L.divIcon({
        html: '<div style="width:14px;height:14px;border-radius:7px;background:#64ffda;border:2px solid #02101f;"></div>',
        className: '',
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      });

      function updateUserLocation(coords) {
        if (!coords || typeof coords.latitude !== 'number') return;
        var latlng = [coords.latitude, coords.longitude];
        if (!userMarker) {
          userMarker = L.marker(latlng, { icon: userIcon }).addTo(map);
        } else {
          userMarker.setLatLng(latlng);
        }
        map.setView(latlng, map.getZoom());
      }

      function updateTeammates(list) {
        if (!Array.isArray(list)) return;
        var seen = {};
        list.forEach(function(m) {
          if (!m || typeof m.latitude !== 'number' || typeof m.longitude !== 'number') return;
          var id = m.id || m.user_id;
          if (!id) return;
          seen[id] = true;
          var latlng = [m.latitude, m.longitude];
          var label = m.name || 'Teammate';
          if (!teammateMarkers[id]) {
            var icon = L.divIcon({ html: '<div class="teammate-label">' + label + '</div>', className: '', iconAnchor: [0, 0] });
            teammateMarkers[id] = L.marker(latlng, { icon: icon }).addTo(map);
          } else {
            teammateMarkers[id].setLatLng(latlng);
          }
        });
        Object.keys(teammateMarkers).forEach(function(key) {
          if (!seen[key]) {
            map.removeLayer(teammateMarkers[key]);
            delete teammateMarkers[key];
          }
        });
      }

      function onMessage(event) {
        var data = event.data;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch(e) { return; } }
        if (!data || !data.type) return;
        if (data.type === 'setUserLocation') updateUserLocation(data.coords);
        if (data.type === 'setTeammates') updateTeammates(data.teammates);
      }
      window.addEventListener('message', onMessage);
      document.addEventListener('message', onMessage);
    </script>
  </body>
</html>
`;

const formatDuration = (s: number): string => {
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

interface SummaryRowProps {
  label: string;
  value: string;
}

const SummaryRow = ({ label, value }: SummaryRowProps) => (
  <View style={styles.summaryRow}>
    <Text style={styles.summaryLabel}>{label}</Text>
    <Text style={styles.summaryValue}>{value}</Text>
  </View>
);

const MapScreen = () => {
  const [coords, setCoords] = useState<Coordinates | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [runSnap, setRunSnap] = useState<RunSnapshot | null>(null);
  const [teammates, setTeammates] = useState<Teammate[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [sosSending, setSosSending] = useState(false);
  const [sosSent, setSosSent] = useState(false);
  const [sosModal, setSosModal] = useState<{ username: string; lat: number; lng: number; triggered_at?: string } | null>(null);
  const webViewRef = useRef<WebView>(null);
  const pulseScale = useRef(new Animated.Value(1)).current;

  const postToMap = useCallback((msg: object) => {
    webViewRef.current?.postMessage(JSON.stringify(msg));
  }, []);

  useEffect(() => {
    if (coords) {
      postToMap({ type: 'setUserLocation', coords: { latitude: coords.latitude, longitude: coords.longitude } });
    }
  }, [coords, postToMap]);

  useEffect(() => {
    postToMap({ type: 'setTeammates', teammates });
  }, [teammates, postToMap]);

  useEffect(() => {
    if (!sosSent) {
      pulseScale.setValue(1);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseScale, { toValue: 1.08, duration: 500, useNativeDriver: true }),
        Animated.timing(pulseScale, { toValue: 1, duration: 500, useNativeDriver: true })
      ])
    );
    animation.start();
    const timeout = setTimeout(() => setSosSent(false), 3000);
    return () => {
      animation.stop();
      clearTimeout(timeout);
    };
  }, [pulseScale, sosSent]);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    let mounted = true;

    const loadGroup = async () => {
      try {
        const storedGroupId = await AsyncStorage.getItem('groupId');
        const storedUserId = await AsyncStorage.getItem('userId');
        if (mounted) {
          setGroupId(storedGroupId);
          setUserId(storedUserId);
          setLoading(false);
        }
        if (storedGroupId) {
          await fetchTeammates(storedGroupId, storedUserId);
          interval = setInterval(() => fetchTeammates(storedGroupId, storedUserId), 10000);
        }
      } catch (error) {
        console.error('Failed to load group', error);
      }
    };

    loadGroup();
    return () => {
      mounted = false;
      if (interval) clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    runEngine.onUpdate(setRunSnap);
  }, []);

  useEffect(() => {
    let mounted = true;
    startLocationTracking((latest) => {
      if (mounted) {
        setCoords(latest);
        runEngine.feed(latest, groupId).catch((err) =>
          console.warn('[Map] runEngine.feed error:', err)
        );
      }
    }).catch((error) => {
      setLocationError(error.message || 'Location unavailable');
    });
    return () => {
      mounted = false;
      stopLocationTracking();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  useEffect(() => {
    const handler = (message: any) => {
      if (message?.type === 'sos_alert') {
        setSosModal({
          username: message.username || 'Teammate',
          lat: Number(message.lat),
          lng: Number(message.lng),
          triggered_at: message.triggered_at
        });
      }
    };
    wsClient.on('message', handler);
    return () => {
      wsClient.off('message', handler);
    };
  }, []);

  useEffect(() => {
    const unsubscribe = wsClient.onLocation((message) => {
      const incomingUserId = message.user_id || message.userId;
      const lat = Number(message.lat);
      const lng = Number(message.lng);
      if (!incomingUserId || incomingUserId === userId || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        return;
      }

      setTeammates((prev) => {
        const existing = prev.find((m) => m.id === incomingUserId);
        const updated: Teammate = {
          id: incomingUserId,
          name: existing?.name || 'Teammate',
          latitude: lat,
          longitude: lng,
        };
        if (!existing) {
          return [...prev, updated];
        }
        return prev.map((m) => (m.id === incomingUserId ? { ...m, ...updated } : m));
      });
    });

    return unsubscribe;
  }, [userId]);

  const fetchTeammates = async (activeGroupId: string, currentUserId?: string | null) => {
    try {
      const response = await api.get(`/api/groups/${activeGroupId}/members`);
      const raw: any[] = response.data?.members || response.data?.teammates || response.data || [];
      // Normalise backend field names (lat/lng) to frontend interface (latitude/longitude)
      const list: Teammate[] = Array.isArray(raw)
        ? raw
            .map((m) => ({
              id: m.user_id || m.userId || m.id,
              name: m.name,
              latitude: Number(m.latitude ?? m.lat),
              longitude: Number(m.longitude ?? m.lng),
            }))
            .filter((m) => m.id && Number.isFinite(Number(m.latitude)) && Number.isFinite(Number(m.longitude)))
            .filter((m) => m.id !== currentUserId)
        : [];
      setTeammates(list);
      setFetchError(null);
    } catch (error: any) {
      console.warn('Failed to fetch teammate locations', error);
      setFetchError(error?.response?.data?.message || 'Unable to load teammate locations');
    }
  };

  const handleSosLongPress = useCallback(async () => {
    if (!groupId) {
      Alert.alert('Join a group', 'Join a group before sending an SOS alert.');
      return;
    }
    if (!coords) {
      Alert.alert('Location unavailable', 'Wait for GPS lock before sending SOS.');
      return;
    }
    if (sosSending) return;
    try {
      setSosSending(true);
      await api.post('/api/sos', {
        group_id: groupId,
        lat: coords.latitude,
        lng: coords.longitude
      });
      setSosSent(true);
    } catch (error: any) {
      console.error('SOS dispatch failed', error);
      const message = error?.response?.data?.error || error?.message || 'Unable to reach the server';
      Alert.alert('SOS Failed', message);
    } finally {
      setSosSending(false);
    }
  }, [coords, groupId, sosSending]);

  const teammateData = useMemo(() => teammates.filter(Boolean), [teammates]);
  const sosAnimatedStyle = sosSent ? { transform: [{ scale: pulseScale }] } : undefined;

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
        <Text style={styles.statusText}>Loading group info...</Text>
      </View>
    );
  }

  if (!groupId) {
    return (
      <View style={styles.centered}>
        <Text style={styles.statusText}>Create or join a group first.</Text>
      </View>
    );
  }

  return (
    <>
      <View style={styles.container}>
      <View style={styles.mapContainer}>
        <WebView
          ref={webViewRef}
          source={{ html: MAP_HTML }}
          style={styles.webView}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          originWhitelist={['*']}
          onError={(e) => console.warn('[MapWebView] error', e.nativeEvent)}
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Your Position</Text>
        {coords ? (
          <Text style={styles.coords}>
            {coords.latitude.toFixed(5)}, {coords.longitude.toFixed(5)}
          </Text>
        ) : (
          <Text style={styles.statusText}>{locationError || 'Requesting GPS...'}</Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Teammates</Text>
        {fetchError ? <Text style={styles.error}>{fetchError}</Text> : null}
        <FlatList
          data={teammateData}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={<Text style={styles.statusText}>No teammates reported yet.</Text>}
          renderItem={({ item }) => (
            <View style={styles.teammateRow}>
              <Text style={styles.teammateName}>{item.name || 'Unknown'}</Text>
              <Text style={styles.teammateCoords}>
                {item.latitude?.toFixed(4)}, {item.longitude?.toFixed(4)}
              </Text>
            </View>
          )}
        />
      </View>

      {/* Run HUD overlay — shown during ACTIVE run */}
      {runSnap?.state === 'ACTIVE' && (
        <View style={styles.runHUD}>
          <View style={styles.hudRow}>
            <Text style={styles.hudLabel}>SPEED</Text>
            <Text style={styles.hudValue}>{runSnap.maxSpeedKmh.toFixed(0)}</Text>
            <Text style={styles.hudUnit}>km/h</Text>
          </View>
          <View style={styles.hudRow}>
            <Text style={styles.hudLabel}>↓ DROP</Text>
            <Text style={styles.hudValue}>{runSnap.verticalMeters.toFixed(0)}</Text>
            <Text style={styles.hudUnit}>m</Text>
          </View>
          <View style={styles.hudRow}>
            <Text style={styles.hudLabel}>TIME</Text>
            <Text style={styles.hudValue}>{formatDuration(runSnap.durationSeconds)}</Text>
          </View>
        </View>
      )}

      <View style={styles.sosWrapper}>
        <Pressable
          onLongPress={handleSosLongPress}
          delayLongPress={1500}
          style={({ pressed }) => [styles.sosButton, pressed && styles.sosButtonPressed]}
        >
          <Animated.View
            style={[styles.sosCircle, (sosSent || sosSending) && styles.sosCircleActive, sosAnimatedStyle]}
          >
            {sosSending ? <ActivityIndicator color="#fff" /> : <Text style={styles.sosLabel}>SOS</Text>}
          </Animated.View>
        </Pressable>
        <Text style={styles.helper}>Long press to alert your squad.</Text>
        {sosSent ? <Text style={styles.sosStatusText}>SOS SENT</Text> : null}
      </View>
    </View>

      {/* Post-run summary modal */}
      <Modal
        animationType="slide"
        transparent
        visible={runSnap?.state === 'ENDED'}
        onRequestClose={() => {}}
      >
        <View style={styles.summaryBackdrop}>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryTitle}>🎿 Run Complete!</Text>
            {runSnap && (
              <>
                <SummaryRow label="Duration" value={formatDuration(runSnap.durationSeconds)} />
                <SummaryRow label="Vertical" value={`${runSnap.verticalMeters.toFixed(0)} m`} />
                <SummaryRow
                  label="Distance"
                  value={`${(runSnap.distanceMeters / 1000).toFixed(2)} km`}
                />
                <SummaryRow label="Top Speed" value={`${runSnap.maxSpeedKmh.toFixed(1)} km/h`} />
                <SummaryRow label="Avg Speed" value={`${runSnap.avgSpeedKmh.toFixed(1)} km/h`} />
              </>
            )}
            <Pressable style={styles.summaryDoneBtn} onPress={() => { /* runEngine auto-resets after 2 s */ }}>
              <Text style={styles.summaryDoneBtnText}>Done</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal
        animationType="fade"
        transparent
        visible={Boolean(sosModal)}
        onRequestClose={() => setSosModal(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>SOS Alert</Text>
            {sosModal ? (
              <>
                <Text style={styles.modalSubtitle}>{sosModal.username} needs assistance.</Text>
                <Text style={styles.modalCoords}>
                  {Number.isFinite(sosModal.lat) ? sosModal.lat.toFixed(4) : '--'},
                  {Number.isFinite(sosModal.lng) ? sosModal.lng.toFixed(4) : '--'}
                </Text>
                <Pressable style={styles.modalButton} onPress={() => setSosModal(null)}>
                  <Text style={styles.modalButtonText}>Got it</Text>
                </Pressable>
              </>
            ) : null}
          </View>
        </View>
      </Modal>
    </>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#06121f' },
  mapContainer: { height: 300 },
  webView: { flex: 1 },
  card: { backgroundColor: '#0f2238', borderRadius: 16, padding: 16, margin: 12, marginTop: 0 },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#fff', marginBottom: 8 },
  coords: { fontSize: 16, color: '#64ffda' },
  teammateRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1e3a5f' },
  teammateName: { color: '#fff', fontSize: 16, fontWeight: '600' },
  teammateCoords: { color: '#90caf9', fontSize: 14 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#06121f' },
  statusText: { marginTop: 8, color: '#9fb4cc', textAlign: 'center' },
  error: { color: '#ff8a80', marginBottom: 8 },
  sosWrapper: { alignItems: 'center', paddingVertical: 24 },
  sosButton: { padding: 12 },
  sosButtonPressed: { opacity: 0.9 },
  sosCircle: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: '#b71c1c',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#b71c1c',
    shadowOpacity: 0.6,
    shadowRadius: 18
  },
  sosCircleActive: { backgroundColor: '#d32f2f' },
  sosLabel: { color: '#fff', fontSize: 28, fontWeight: '800' },
  helper: { marginTop: 12, color: '#f8bbd0', textAlign: 'center' },
  sosStatusText: { marginTop: 6, color: '#ff8a80', fontWeight: '700' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center' },
  modalCard: { width: '80%', backgroundColor: '#0f2238', borderRadius: 16, padding: 24, alignItems: 'center', gap: 12 },
  modalTitle: { fontSize: 20, fontWeight: '800', color: '#fff' },
  modalSubtitle: { color: '#ffb74d', textAlign: 'center' },
  modalCoords: { color: '#64ffda', fontSize: 16, fontWeight: '600' },
  modalButton: { marginTop: 8, backgroundColor: '#1e88e5', paddingHorizontal: 28, paddingVertical: 12, borderRadius: 30 },
  modalButtonText: { color: '#fff', fontWeight: '700' },
  // Run HUD
  runHUD: {
    position: 'absolute',
    top: 12,
    right: 12,
    backgroundColor: 'rgba(6,18,31,0.85)',
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 14,
    zIndex: 10,
  },
  hudRow: { flexDirection: 'row', alignItems: 'baseline', marginBottom: 4 },
  hudLabel: { color: '#64ffda', fontSize: 10, fontWeight: '700', width: 46 },
  hudValue: { color: '#64ffda', fontSize: 18, fontWeight: '800', marginHorizontal: 4 },
  hudUnit: { color: '#64ffda', fontSize: 11 },
  // Post-run summary
  summaryBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'center', alignItems: 'center' },
  summaryCard: { width: '80%', backgroundColor: '#0f2238', borderRadius: 20, padding: 24, alignItems: 'stretch', gap: 10 },
  summaryTitle: { fontSize: 22, fontWeight: '800', color: '#fff', textAlign: 'center', marginBottom: 8 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1e3a5f' },
  summaryLabel: { color: '#9fb4cc', fontSize: 14 },
  summaryValue: { color: '#64ffda', fontSize: 14, fontWeight: '700' },
  summaryDoneBtn: { marginTop: 12, backgroundColor: '#1e88e5', paddingVertical: 12, borderRadius: 30, alignItems: 'center' },
  summaryDoneBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});

export default MapScreen;
