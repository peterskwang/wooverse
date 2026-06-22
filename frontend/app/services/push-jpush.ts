import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { JPUSH_APP_KEY } from '../config/api';
import api from './api';

type JPushLike = {
  setup?: (params?: Record<string, unknown>) => void;
  init?: () => void;
  setLoggerEnable?: (enabled: boolean) => void;
  getRegistrationID?: (callback: (registrationId: string) => void) => void;
  getRegistrationId?: () => Promise<string>;
};

let hasInitialized = false;

function loadJPushSdk(): JPushLike | null {
  try {
    const module = require('jpush-react-native');
    return module?.default || module;
  } catch {
    // Try legacy package name used by some app builds.
  }

  try {
    const module = require('react-native-jpush');
    return module?.default || module;
  } catch {
    return null;
  }
}

function initializeJPushSdk(jpush: JPushLike) {
  if (hasInitialized) return;

  try {
    jpush.setLoggerEnable?.(__DEV__);

    if (jpush.setup) {
      const setupPayload: Record<string, unknown> = {
        production: !__DEV__,
        channel: 'default'
      };
      if (JPUSH_APP_KEY) {
        setupPayload.appKey = JPUSH_APP_KEY;
      }
      jpush.setup(setupPayload);
    } else {
      jpush.init?.();
    }
    hasInitialized = true;
  } catch (error) {
    console.warn('[push-jpush] SDK init failed', error);
  }
}

async function getRegistrationId(jpush: JPushLike): Promise<string | null> {
  if (typeof jpush.getRegistrationId === 'function') {
    const id = await jpush.getRegistrationId();
    return id || null;
  }

  if (typeof jpush.getRegistrationID === 'function') {
    return await new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 5000);
      jpush.getRegistrationID?.((registrationId: string) => {
        clearTimeout(timeout);
        resolve(registrationId || null);
      });
    });
  }

  return null;
}

export async function registerPushToken(): Promise<boolean> {
  const jpush = loadJPushSdk();
  if (!jpush) {
    console.warn('[push-jpush] SDK not installed, using fallback push provider');
    return false;
  }

  try {
    initializeJPushSdk(jpush);
    const registrationId = await getRegistrationId(jpush);

    if (!registrationId) {
      console.warn('[push-jpush] Missing registration_id');
      return false;
    }

    const appVersion =
      Constants.expoConfig?.version || Constants.manifest?.version || '1.0.0';

    await api.post('/api/auth/push-token', {
      provider: 'jpush',
      token: registrationId,
      platform: Platform.OS,
      app_version: appVersion
    });

    await AsyncStorage.setItem('pushToken', registrationId);
    return true;
  } catch (error: any) {
    console.warn('[push-jpush] Token registration failed:', error?.message || error);
    return false;
  }
}

