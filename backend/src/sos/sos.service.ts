import { prisma } from '../lib/prisma';

// Haversine distance in km
function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Find nearest active patrol in resort based on last known GPS position
export async function matchNearestPatrol(resortId: string, lat: number, lng: number) {
  // Get latest position per patrol in last 30 min
  const cutoff = new Date(Date.now() - 30 * 60 * 1000);
  const positions = await prisma.patrolPosition.findMany({
    where: { resortId, recordedAt: { gte: cutoff } },
    orderBy: { recordedAt: 'desc' },
    include: { user: true },
  });

  // Deduplicate — keep latest per user
  const latestByUser = new Map<string, typeof positions[0]>();
  for (const pos of positions) {
    if (!latestByUser.has(pos.userId)) latestByUser.set(pos.userId, pos);
  }

  let nearest: { pos: typeof positions[0]; distanceKm: number } | null = null;
  for (const pos of latestByUser.values()) {
    const dist = haversine(lat, lng, pos.lat, pos.lng);
    if (!nearest || dist < nearest.distanceKm) {
      nearest = { pos, distanceKm: dist };
    }
  }

  return nearest ? nearest.pos.user : null;
}
