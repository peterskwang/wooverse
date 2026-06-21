import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';

import api from '../services/api';
import { registerForPushNotifications } from '../services/push';

type WeChatSdk = {
  registerApp?: (appId: string, universalLink?: string) => Promise<boolean> | boolean;
  sendAuthRequest?: (
    scope: string,
    state: string
  ) => Promise<{ code?: string }>;
};

const STORAGE_KEYS = {
  token: 'token',
  userId: 'userId',
  displayName: 'displayName',
  email: 'email',
  groupId: 'groupId'
};

const WECHAT_APP_ID =
  process.env.EXPO_PUBLIC_WECHAT_APP_ID || process.env.WECHAT_APP_ID || '';

function loadWeChatSdk(): WeChatSdk | null {
  try {
    const module = require('react-native-wechat-lib');
    return module?.default || module;
  } catch {
    return null;
  }
}

function extractJwt(payload: Record<string, any>): string | null {
  return payload.token || payload.jwt || payload.access_token || null;
}

async function getOrCreateDeviceId(): Promise<string> {
  const existing = await AsyncStorage.getItem('deviceId');
  if (existing) return existing;
  const next = `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  await AsyncStorage.setItem('deviceId', next);
  return next;
}

const WeChatLoginScreen = () => {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [sdkLoading, setSdkLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sdkAvailable = useMemo(() => !!loadWeChatSdk(), []);

  const handleGetCodeFromSdk = useCallback(async () => {
    setError(null);
    const wechat = loadWeChatSdk();
    if (!wechat?.sendAuthRequest) {
      setError('WeChat SDK is not available on this build.');
      return;
    }

    try {
      setSdkLoading(true);
      if (wechat.registerApp && WECHAT_APP_ID) {
        await wechat.registerApp(WECHAT_APP_ID);
      }
      const auth = await wechat.sendAuthRequest('snsapi_userinfo', 'wooverse_login');
      if (!auth?.code) {
        setError('No OAuth code was returned by WeChat.');
        return;
      }
      setCode(auth.code);
    } catch (e: any) {
      setError(e?.message || 'Failed to request WeChat auth code');
    } finally {
      setSdkLoading(false);
    }
  }, []);

  const handleLogin = useCallback(async () => {
    setError(null);
    if (!code.trim()) {
      setError('Please enter or fetch the WeChat OAuth code.');
      return;
    }

    try {
      setLoading(true);
      const deviceId = await getOrCreateDeviceId();
      const response = await api.post('/api/auth/wechat', {
        code: code.trim(),
        device_id: deviceId,
        name: name.trim() || undefined
      });

      const payload = response.data || {};
      const token = extractJwt(payload);
      const user = payload.user || {};
      const groupId = payload.groupId || payload.group_id || null;

      if (!token) {
        throw new Error('Missing JWT token in response');
      }

      const entries: [string, string][] = [[STORAGE_KEYS.token, token]];
      if (user.id != null) entries.push([STORAGE_KEYS.userId, String(user.id)]);
      if (user.name) entries.push([STORAGE_KEYS.displayName, String(user.name)]);
      if (user.email) entries.push([STORAGE_KEYS.email, String(user.email)]);

      await AsyncStorage.multiSet(entries);
      if (groupId) {
        await AsyncStorage.setItem(STORAGE_KEYS.groupId, String(groupId));
      }

      registerForPushNotifications().catch(() => null);
      router.replace('/(tabs)/map');
    } catch (e: any) {
      const message = e?.response?.data?.error || e?.message || 'WeChat login failed';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [code, name, router]);

  const disabled = loading || sdkLoading;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Pressable onPress={() => router.back()} style={styles.backButton} disabled={disabled}>
        <Text style={styles.backText}>← Back</Text>
      </Pressable>

      <Text style={styles.title}>WeChat Login</Text>
      <Text style={styles.subtitle}>Use WeChat OAuth code to continue</Text>

      {sdkAvailable ? (
        <Pressable
          onPress={handleGetCodeFromSdk}
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
          disabled={disabled}
        >
          {sdkLoading ? (
            <ActivityIndicator color="#1e88e5" />
          ) : (
            <Text style={styles.secondaryButtonText}>Get Code from WeChat</Text>
          )}
        </Pressable>
      ) : (
        <Text style={styles.helperText}>WeChat SDK unavailable. Paste OAuth code manually.</Text>
      )}

      <TextInput
        value={code}
        onChangeText={setCode}
        placeholder="WeChat OAuth code"
        placeholderTextColor="#4a6278"
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
        editable={!disabled}
      />

      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="Display name (optional)"
        placeholderTextColor="#4a6278"
        style={[styles.input, styles.spaced]}
        editable={!disabled}
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable
        onPress={handleLogin}
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed, disabled && styles.disabled]}
        disabled={disabled}
      >
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Login</Text>}
      </Pressable>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: '#0c1d2e'
  },
  backButton: {
    position: 'absolute',
    top: 60,
    left: 24
  },
  backText: {
    color: '#1e88e5',
    fontSize: 16,
    fontWeight: '600'
  },
  title: {
    fontSize: 34,
    fontWeight: '800',
    textAlign: 'center',
    color: '#fff'
  },
  subtitle: {
    marginTop: 8,
    marginBottom: 24,
    textAlign: 'center',
    color: '#9fb4cc'
  },
  helperText: {
    marginBottom: 12,
    color: '#9fb4cc',
    textAlign: 'center'
  },
  input: {
    borderWidth: 1,
    borderColor: '#26445f',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: '#fff',
    backgroundColor: '#13273c'
  },
  spaced: {
    marginTop: 12
  },
  button: {
    marginTop: 24,
    backgroundColor: '#1e88e5',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center'
  },
  secondaryButton: {
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#1e88e5',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center'
  },
  secondaryButtonText: {
    color: '#1e88e5',
    fontWeight: '700'
  },
  buttonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700'
  },
  buttonPressed: {
    opacity: 0.85
  },
  disabled: {
    opacity: 0.6
  },
  error: {
    marginTop: 12,
    color: '#ff8a80',
    textAlign: 'center'
  }
});

export default WeChatLoginScreen;

