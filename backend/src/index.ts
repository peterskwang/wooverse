import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';

import { authRoutes } from './auth/auth.routes';
import { userRoutes } from './users/user.routes';
import { deviceRoutes } from './devices/device.routes';
import { pttRoutes } from './ptt/ptt.routes';
import { sosRoutes } from './sos/sos.routes';
import { rescueRoutes } from './rescue/rescue.routes';
import { evidenceRoutes } from './evidence/evidence.routes';
import { adminRoutes } from './admin/admin.routes';
import { wsHandler } from './ws/ws.handler';
import { prisma } from './lib/prisma';
import { validateEnv } from './config/env';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty' }
      : undefined,
  },
});

async function bootstrap() {
  // Validate required env vars at startup
  validateEnv();

  // Plugins
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN ?? '*',
    credentials: true,
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(jwt, {
    secret: process.env.JWT_SECRET!,
    sign: { expiresIn: '1h' },
  });
  await app.register(websocket);
  await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB

  // Health check
  app.get('/health', async () => ({
    status: 'ok',
    service: 'wooverse-backend',
    version: '1.0.0',
    ts: new Date().toISOString(),
  }));

  // Routes
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(userRoutes, { prefix: '/api/users' });
  await app.register(deviceRoutes, { prefix: '/api/devices' });
  await app.register(pttRoutes, { prefix: '/api/ptt' });
  await app.register(sosRoutes, { prefix: '/api/sos' });
  await app.register(rescueRoutes, { prefix: '/api/rescue' });
  await app.register(evidenceRoutes, { prefix: '/api/evidence' });
  await app.register(adminRoutes, { prefix: '/api/admin' });

  // WebSocket hub
  app.get('/ws', { websocket: true }, wsHandler);

  // Start
  const port = parseInt(process.env.PORT ?? '8100');
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`Wooverse backend running on port ${port}`);
}

// Graceful shutdown
const shutdown = async (signal: string) => {
  app.log.info(`${signal} received — shutting down`);
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
