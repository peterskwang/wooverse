import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { USE_JPUSH } from '../config/api';
import api from './api';
import { registerPushToken } from './push-jpush';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function registerForPushNotifications(): Promise<void> {
  try {
    if (USE_JPUSH) {
      const jpushRegistered = await registerPushToken();
      if (jpushRegistered) {
        console.log('[push] Registered with JPush provider');
        return;
      }
    }

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.warn('[push] Permission not granted');
      return;
    }

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('sos-alerts', {
        name: 'SOS Alerts',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF0000',
        sound: 'default',
      });
    }

    const tokenData = await Notifications.getExpoPushTokenAsync();
    const token = tokenData.data;

    await api.post('/api/auth/push-token', {
      provider: 'expo',
      token,
      platform: Platform.OS,
    });

    await AsyncStorage.setItem('pushToken', token);
    console.log('[push] Token registered:', token.slice(0, 20) + '...');
  } catch (e: any) {
    console.warn('[push] Registration failed:', e?.message);
  }
}

export function setupNotificationListeners(
  onSosNotification: (data: { username: string; lat: number; lng: number }) => void
): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data;
    if (data?.type === 'sos_alert') {
      onSosNotification({
        username: data.username || 'Teammate',
        lat: Number(data.lat),
        lng: Number(data.lng),
      });
    }
  });

  return () => subscription.remove();
}
