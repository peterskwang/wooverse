import { FastifyRequest } from 'fastify';
import { WebSocket } from 'ws';
import { registerSocket, wsBroadcastToResort } from './ws.hub';

interface WsAuthQuery {
  token?: string;
  userId?: string;
  resortId?: string;
}

export async function wsHandler(ws: WebSocket, req: FastifyRequest) {
  const query = req.query as WsAuthQuery;

  // Minimal auth — in prod verify JWT from query.token
  const userId = query.userId ?? 'anonymous';
  const resortId = query.resortId;

  registerSocket(ws, userId, resortId);

  ws.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleWsMessage(ws, userId, resortId, msg);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
    }
  });

  ws.send(JSON.stringify({ type: 'connected', userId, resortId }));
}

function handleWsMessage(
  ws: WebSocket,
  userId: string,
  resortId: string | undefined,
  msg: { type: string; [key: string]: unknown },
) {
  switch (msg.type) {
    case 'patrol_position': {
      // Patrol app sends position updates
      if (resortId) {
        wsBroadcastToResort(resortId, {
          type: 'patrol_position_update',
          userId,
          lat: msg.lat,
          lng: msg.lng,
          altitude: msg.altitude,
          ts: new Date().toISOString(),
        });
      }
      break;
    }
    case 'work_order_status': {
      if (resortId) {
        wsBroadcastToResort(resortId, {
          type: 'work_order_status_update',
          workOrderId: msg.workOrderId,
          status: msg.status,
          updatedBy: userId,
          ts: new Date().toISOString(),
        });
      }
      break;
    }
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;
    default:
      break;
  }
}
