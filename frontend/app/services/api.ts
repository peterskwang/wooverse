import AsyncStorage from '@react-native-async-storage/async-storage';
import axios, { AxiosRequestHeaders } from 'axios';
import { EXPO_PUBLIC_API_URL } from '../config/api';

const api = axios.create({
  baseURL: EXPO_PUBLIC_API_URL,
  timeout: 10000
});

api.interceptors.request.use(async (config) => {
  const token = await AsyncStorage.getItem('token');
  if (token) {
    const headers = (config.headers || {}) as AxiosRequestHeaders;
    headers.Authorization = `Bearer ${token}`;
    config.headers = headers;
  }

  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    console.warn('API error', error.response?.status, error.response?.data);
    return Promise.reject(error);
  }
);

export default api;
