import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import * as AppleAuthentication from 'expo-apple-authentication';

import api from './services/api';
import { registerForPushNotifications } from './services/push';

const STORAGE_KEYS = {
  token: 'token',
  userId: 'userId',
  groupId: 'groupId',
  displayName: 'displayName',
  email: 'email'
};

const LoginScreen = () => {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [appleLoading, setAppleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const storeAuthAndNavigate = useCallback(
    async (token: string, user: { id: number | string; name?: string; email?: string }, groupId?: string) => {
      const entries: [string, string][] = [
        [STORAGE_KEYS.token, token],
        [STORAGE_KEYS.userId, user.id.toString()]
      ];
      if (user.email) entries.push([STORAGE_KEYS.email, user.email]);
      if (user.name) entries.push([STORAGE_KEYS.displayName, user.name]);
      await AsyncStorage.multiSet(entries);
      if (groupId) {
        await AsyncStorage.setItem(STORAGE_KEYS.groupId, groupId);
      }
      registerForPushNotifications().catch(() => null);
      if (groupId) {
        router.replace('/(tabs)/map');
      } else {
        router.replace('/group-setup');
      }
    },
    [router]
  );

  const handleLogin = useCallback(async () => {
    setError(null);
    if (!email.trim() || !password) {
      setError('Email and password are required.');
      return;
    }
    try {
      setLoading(true);
      const response = await api.post('/api/auth/login', {
        email: email.trim().toLowerCase(),
        password
      });
      const { token, user } = response.data;
      const existingGroupId = await AsyncStorage.getItem(STORAGE_KEYS.groupId);
      await storeAuthAndNavigate(token, user, existingGroupId || undefined);
    } catch (err: any) {
      const message = err?.response?.data?.error || err?.message || 'Login failed';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [email, password, storeAuthAndNavigate]);

  const handleAppleSignIn = useCallback(async () => {
    setError(null);
    try {
      setAppleLoading(true);
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME
        ]
      });
      const givenName = credential.fullName?.givenName ?? undefined;
      const response = await api.post('/api/auth/apple', {
        identityToken: credential.identityToken,
        name: givenName
      });
      const { token, user } = response.data;
      const existingGroupId = await AsyncStorage.getItem(STORAGE_KEYS.groupId);
      await storeAuthAndNavigate(token, user, existingGroupId || undefined);
    } catch (err: any) {
      if (err?.code === 'ERR_REQUEST_CANCELED') return;
      const message = err?.response?.data?.error || err?.message || 'Apple Sign In failed';
      setError(message);
    } finally {
      setAppleLoading(false);
    }
  }, [storeAuthAndNavigate]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Wooverse</Text>
      <Text style={styles.subtitle}>Sign in to your account</Text>

      <TextInput
        value={email}
        onChangeText={setEmail}
        placeholder="Email"
        placeholderTextColor="#4a6278"
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
        editable={!loading && !appleLoading}
      />

      <TextInput
        value={password}
        onChangeText={setPassword}
        placeholder="Password"
        placeholderTextColor="#4a6278"
        secureTextEntry
        style={[styles.input, styles.inputSpaced]}
        editable={!loading && !appleLoading}
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable
        onPress={handleLogin}
        style={({ pressed }) => [
          styles.button,
          pressed && styles.buttonPressed,
          loading && styles.buttonDisabled
        ]}
        disabled={loading || appleLoading}
      >
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Login</Text>
        )}
      </Pressable>

      <View style={styles.altAuthRow}>
        <Pressable
          onPress={() => router.push('/auth/wechat-login')}
          style={({ pressed }) => [styles.altAuthButton, pressed && styles.buttonPressed]}
          disabled={loading || appleLoading}
        >
          <Text style={styles.altAuthButtonText}>WeChat Login</Text>
        </Pressable>
        <Pressable
          onPress={() => router.push('/auth/sms-login')}
          style={({ pressed }) => [styles.altAuthButton, pressed && styles.buttonPressed]}
          disabled={loading || appleLoading}
        >
          <Text style={styles.altAuthButtonText}>SMS Login</Text>
        </Pressable>
      </View>

      {Platform.OS === 'ios' && (
        <AppleAuthentication.AppleAuthenticationButton
          buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
          buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
          cornerRadius={12}
          style={styles.appleButton}
          onPress={handleAppleSignIn}
        />
      )}

      <Pressable
        onPress={() => router.push('/signup')}
        style={styles.signupLink}
        disabled={loading || appleLoading}
      >
        <Text style={styles.signupLinkText}>
          Don't have an account? <Text style={styles.signupLinkAccent}>Sign up</Text>
        </Text>
      </Pressable>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: '#0c1d2e'
  },
  title: {
    fontSize: 48,
    fontWeight: '800',
    textAlign: 'center',
    color: '#fff',
    marginBottom: 4
  },
  subtitle: {
    fontSize: 16,
    textAlign: 'center',
    color: '#9fb4cc',
    marginBottom: 32
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
  inputSpaced: {
    marginTop: 12
  },
  button: {
    marginTop: 24,
    backgroundColor: '#1e88e5',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center'
  },
  buttonPressed: {
    opacity: 0.85
  },
  buttonDisabled: {
    opacity: 0.6
  },
  buttonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700'
  },
  altAuthRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12
  },
  altAuthButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#1e88e5',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center'
  },
  altAuthButtonText: {
    color: '#8ec2ff',
    fontSize: 14,
    fontWeight: '700'
  },
  appleButton: {
    width: '100%',
    height: 50,
    marginTop: 16
  },
  signupLink: {
    marginTop: 24,
    alignItems: 'center'
  },
  signupLinkText: {
    color: '#9fb4cc',
    fontSize: 15
  },
  signupLinkAccent: {
    color: '#1e88e5',
    fontWeight: '700'
  },
  error: {
    marginTop: 12,
    color: '#ff8a80',
    textAlign: 'center'
  }
});

export default LoginScreen;
