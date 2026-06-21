import { z } from 'zod';

const envSchema = z.object({
  // Required
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  REDIS_HOST: z.string().min(1, 'REDIS_HOST is required'),

  // Optional with defaults
  PORT: z.string().optional().default('8100'),
  NODE_ENV: z.enum(['development', 'production', 'test']).optional().default('development'),
  LOG_LEVEL: z.string().optional().default('info'),
  CORS_ORIGIN: z.string().optional().default('*'),
  REDIS_PORT: z.string().optional().default('6379'),

  // Conditional (warn if unset)
  TRTC_SDK_APP_ID: z.string().optional().default(''),
  TRTC_SECRET_KEY: z.string().optional().default(''),
  ALIYUN_ACCESS_KEY_ID: z.string().optional().default(''),
  ALIYUN_ACCESS_KEY_SECRET: z.string().optional().default(''),
  OSS_BUCKET: z.string().optional().default(''),
  OSS_ENDPOINT: z.string().optional().default(''),
  OSS_REGION: z.string().optional().default(''),
  PUSH_APP_KEY: z.string().optional().default(''),
  SMS_SIGN_NAME: z.string().optional().default(''),
  SMS_OTP_TEMPLATE: z.string().optional().default(''),
  SMS_ALERT_TEMPLATE: z.string().optional().default(''),
  WECHAT_APP_ID: z.string().optional().default(''),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const missing = result.error.issues
      .filter((i) => i.code === 'too_small' && i.minimum === 1)
      .map((i) => i.path.join('.'));

    const msg =
      missing.length > 0
        ? `Missing required env vars: ${missing.join(', ')}`
        : `Env validation failed: ${result.error.message}`;

    throw new Error(`[ENV] ${msg}`);
  }

  // Warn on optional but important vars
  const warnKeys: (keyof Env)[] = [
    'TRTC_SDK_APP_ID',
    'TRTC_SECRET_KEY',
    'ALIYUN_ACCESS_KEY_ID',
    'ALIYUN_ACCESS_KEY_SECRET',
    'OSS_BUCKET',
    'OSS_ENDPOINT',
  ];

  for (const key of warnKeys) {
    if (!result.data[key]) {
      console.warn(`[ENV] Warning: ${key} is not set — some features may be unavailable`);
    }
  }

  return result.data;
}
