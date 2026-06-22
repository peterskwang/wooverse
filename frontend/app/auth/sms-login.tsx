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

const STORAGE_KEYS = {
  token: 'token',
  userId: 'userId',
  displayName: 'displayName',
  email: 'email',
  groupId: 'groupId'
};

type Step = 'request' | 'verify';

function normalizeChinaPhone(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');

  if (trimmed.startsWith('+')) {
    return `+${digits}`;
  }

  if (digits.startsWith('86') && digits.length === 13) {
    return `+${digits}`;
  }

  if (digits.length === 11 && digits.startsWith('1')) {
    return `+86${digits}`;
  }

  return `+86${digits}`;
}

function isChinaMobilePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '').replace(/^86/, '');
  return /^1[3-9]\d{9}$/.test(digits);
}

function extractJwt(payload: Record<string, any>): string | null {
  return payload.token || payload.jwt || payload.access_token || null;
}

const SmsLoginScreen = () => {
  const router = useRouter();
  const [step, setStep] = useState<Step>('request');
  const [phoneInput, setPhoneInput] = useState('');
  const [normalizedPhone, setNormalizedPhone] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rateLimitMessage, setRateLimitMessage] = useState<string | null>(null);

  const canSubmitCode = useMemo(() => /^\d{6}$/.test(code), [code]);

  const handleRequestCode = useCallback(async () => {
    setError(null);
    setNotice(null);
    setRateLimitMessage(null);

    const formatted = normalizeChinaPhone(phoneInput);
    if (!isChinaMobilePhone(formatted)) {
      setError('Enter a valid China mobile number (e.g. +8613812345678).');
      return;
    }

    try {
      setLoading(true);
      await api.post('/api/auth/sms/request', { phone: formatted });
      setNormalizedPhone(formatted);
      setStep('verify');
      setNotice(`SMS code sent to ${formatted}`);
    } catch (e: any) {
      const status = e?.response?.status;
      const retryAfter = e?.response?.data?.retry_after;
      if (status === 429) {
        const waitText = retryAfter ? ` Try again in ${retryAfter}s.` : '';
        setRateLimitMessage(`Too many SMS requests.${waitText}`);
      } else {
        const message = e?.response?.data?.error || e?.message || 'Failed to request SMS code';
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }, [phoneInput]);

  const handleVerifyCode = useCallback(async () => {
    setError(null);
    setNotice(null);
    setRateLimitMessage(null);

    if (!canSubmitCode) {
      setError('Enter the 6-digit SMS code.');
      return;
    }

    try {
      setLoading(true);
      const response = await api.post('/api/auth/sms/verify', {
        phone: normalizedPhone || normalizeChinaPhone(phoneInput),
        code
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
      const status = e?.response?.status;
      if (status === 429) {
        setRateLimitMessage('Too many attempts. Please wait before trying again.');
      } else {
        const message = e?.response?.data?.error || e?.message || 'SMS verification failed';
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }, [canSubmitCode, code, normalizedPhone, phoneInput, router]);

  const disabled = loading;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Pressable onPress={() => router.back()} style={styles.backButton} disabled={disabled}>
        <Text style={styles.backText}>← Back</Text>
      </Pressable>

      <Text style={styles.title}>SMS Login</Text>
      <Text style={styles.subtitle}>
        {step === 'request' ? 'Enter your China mobile number' : `Code sent to ${normalizedPhone}`}
      </Text>

      {step === 'request' ? (
        <View>
          <TextInput
            value={phoneInput}
            onChangeText={setPhoneInput}
            placeholder="+86 13812345678"
            placeholderTextColor="#4a6278"
            keyboardType="phone-pad"
            autoCapitalize="none"
            style={styles.input}
            editable={!disabled}
          />
          <Pressable
            onPress={handleRequestCode}
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed, disabled && styles.disabled]}
            disabled={disabled}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Request SMS Code</Text>
            )}
          </Pressable>
        </View>
      ) : (
        <View>
          <TextInput
            value={code}
            onChangeText={(next) => setCode(next.replace(/\D/g, '').slice(0, 6))}
            placeholder="6-digit code"
            placeholderTextColor="#4a6278"
            keyboardType="number-pad"
            style={styles.input}
            editable={!disabled}
            maxLength={6}
          />

          <Pressable
            onPress={handleVerifyCode}
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed, disabled && styles.disabled]}
            disabled={disabled}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Verify and Login</Text>
            )}
          </Pressable>

          <Pressable
            onPress={handleRequestCode}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
            disabled={disabled}
          >
            <Text style={styles.secondaryButtonText}>Resend code</Text>
          </Pressable>
        </View>
      )}

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      {rateLimitMessage ? <Text style={styles.rateLimit}>{rateLimitMessage}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
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
  button: {
    marginTop: 16,
    backgroundColor: '#1e88e5',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center'
  },
  secondaryButton: {
    marginTop: 12,
    alignItems: 'center'
  },
  secondaryButtonText: {
    color: '#9fb4cc',
    fontWeight: '600'
  },
  buttonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700'
  },
  buttonPressed: {
    opacity: 0.85
  },
  disabled: {
    opacity: 0.6
  },
  notice: {
    marginTop: 14,
    color: '#8dddb1',
    textAlign: 'center'
  },
  rateLimit: {
    marginTop: 14,
    color: '#ffd166',
    textAlign: 'center'
  },
  error: {
    marginTop: 14,
    color: '#ff8a80',
    textAlign: 'center'
  }
});

export default SmsLoginScreen;

