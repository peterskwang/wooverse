const PRODUCTION_API_URL = 'https://api.wooverse.cn';
const DEVELOPMENT_API_URL = 'http://localhost:8100';

export const EXPO_PUBLIC_API_URL =
  process.env.EXPO_PUBLIC_API_URL ||
  (process.env.NODE_ENV === 'production' ? PRODUCTION_API_URL : DEVELOPMENT_API_URL);

const useJPushRaw = process.env.EXPO_PUBLIC_USE_JPUSH ?? process.env.USE_JPUSH ?? 'true';
export const USE_JPUSH = useJPushRaw.toLowerCase() === 'true';

export const JPUSH_APP_KEY =
  process.env.EXPO_PUBLIC_JPUSH_APP_KEY ?? process.env.JPUSH_APP_KEY ?? '';

