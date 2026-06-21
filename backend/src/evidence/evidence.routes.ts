import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import dayjs from 'dayjs';
import OSS from 'ali-oss';

const ossClient = new OSS({
  region: process.env.OSS_REGION ?? 'oss-cn-shanghai',
  accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID ?? '',
  accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET ?? '',
  bucket: process.env.OSS_BUCKET ?? '',
  endpoint: process.env.OSS_ENDPOINT ?? '',
});

const CreateEvidenceSchema = z.object({
  workOrderId: z.string().uuid(),
  type: z.enum(['VIDEO', 'GPS_TRACK', 'AUDIO']),
  ossKey: z.string(),
  durationSec: z.number().optional(),
  recordedAt: z.string().datetime().optional(),
});

export async function evidenceRoutes(app: FastifyInstance) {
  // POST /api/evidence — record evidence entry after upload
  app.post('/', { onRequest: [app.authenticate] }, async (req, reply) => {
    const body = CreateEvidenceSchema.parse(req.body);

    const evidence = await prisma.evidence.create({
      data: {
        ...body,
        recordedAt: body.recordedAt ? new Date(body.recordedAt) : null,
        retainedUntil: dayjs().add(180, 'day').toDate(),
      },
    });

    // TODO: Write blockchain timestamp
    // blockchainTimestamp = await writeBlockchainTimestamp(evidence.id, evidence.ossKey)

    return reply.send(evidence);
  });

  // GET /api/evidence/work-order/:id — all evidence for a work order
  app.get('/work-order/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const evidence = await prisma.evidence.findMany({
      where: { workOrderId: id },
      orderBy: { recordedAt: 'desc' },
    });
    return reply.send(evidence);
  });

  // GET /api/evidence/:id/download-url — get presigned OSS download URL
  app.get('/:id/download-url', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ev = await prisma.evidence.findUnique({ where: { id } });
    if (!ev) return reply.code(404).send({ error: 'Evidence not found' });

    const url = ossClient.signatureUrl(ev.ossKey, { expires: 3600 });
    return reply.send({ url, expiresIn: 3600 });
  });
}
