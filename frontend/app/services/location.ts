import * as Location from 'expo-location';

import wsClient from './ws';

export interface Coordinates {
  latitude: number;
  longitude: number;
  altitude: number | null;   // metres ASL, null if unavailable
  speed: number | null;     // m/s from GPS, null if unavailable
}

let locationSubscription: Location.LocationSubscription | null = null;
let lastWsLocationSentAt = 0;

const MIN_WS_LOCATION_INTERVAL_MS = 3000;

export const requestPermissions = async () => {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== Location.PermissionStatus.GRANTED) {
    throw new Error('Location permission denied');
  }
};

export const startLocationTracking = async (onUpdate?: (coords: Coordinates) => void) => {
  await requestPermissions();

  if (locationSubscription) {
    locationSubscription.remove();
    locationSubscription = null;
  }

  locationSubscription = await Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: 5000,
      distanceInterval: 10
    },
    (location) => {
      const coords: Coordinates = {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        altitude: location.coords.altitude ?? null,
        speed: location.coords.speed ?? null,
      };

      onUpdate?.(coords);

      const now = Date.now();
      if (wsClient.isConnected() && now - lastWsLocationSentAt >= MIN_WS_LOCATION_INTERVAL_MS) {
        lastWsLocationSentAt = now;
        const payload: Record<string, any> = {
          type: 'location',
          lat: coords.latitude,
          lng: coords.longitude,
          sent_at: now,
          ts: now,
        };
        if (coords.altitude != null) {
          payload.altitude_m = coords.altitude;
        }
        if (coords.speed != null) {
          payload.speed_ms = coords.speed;
        }
        wsClient.send(payload);
      }
    }
  );

  return locationSubscription;
};

export const stopLocationTracking = () => {
  if (locationSubscription) {
    locationSubscription.remove();
    locationSubscription = null;
  }
  lastWsLocationSentAt = 0;
};
