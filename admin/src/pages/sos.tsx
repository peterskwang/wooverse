import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { DivIcon } from 'leaflet';
import Layout from '../components/Layout';
import { adminApi, AdminSosEvent, getAdminPassword, getBackendUrl } from '../api/adminApi';

const MapContainer = dynamic(() => import('react-leaflet').then((mod) => mod.MapContainer), { ssr: false });
const TileLayer = dynamic(() => import('react-leaflet').then((mod) => mod.TileLayer), { ssr: false });
const Marker = dynamic(() => import('react-leaflet').then((mod) => mod.Marker), { ssr: false });
const Popup = dynamic(() => import('react-leaflet').then((mod) => mod.Popup), { ssr: false });

type WsStatus = 'connecting' | 'connected' | 'disconnected';

type SosEvent = AdminSosEvent & {
  acknowledged_at?: string | null;
  acknowledged_by?: string | null;
  sms_fallback_status?: string | null;
  sms_fallback_sent_at?: string | null;
};

function getWsUrl() {
  return getBackendUrl().replace(/^http/, 'ws') + '/ws';
}

function hasCoordinates(event: SosEvent) {
  return event.lat != null && event.lng != null && Number.isFinite(Number(event.lat)) && Number.isFinite(Number(event.lng));
}

function getEventStatus(event: SosEvent) {
  if (event.resolved_at) return 'resolved';
  if (event.acknowledged_at) return 'acknowledged';
  return 'active';
}

function formatElapsed(triggeredAt: string) {
  const elapsedMs = Date.now() - new Date(triggeredAt).getTime();
  const elapsedSec = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(elapsedSec / 60);
  const seconds = elapsedSec % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export default function SosPage() {
  const [events, setEvents] = useState<SosEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting');
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [acknowledgingId, setAcknowledgingId] = useState<string | null>(null);
  const [adminUserId, setAdminUserId] = useState('');
  const reconnectTimer = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const loadEvents = useCallback(async (showLoading = true) => {
    try {
      if (showLoading) setLoading(true);
      setError('');
      const data = await adminApi.getSosEvents();
      setEvents(data as SosEvent[]);
    } catch (e: any) {
      setError(e.message || 'Failed to load SOS events');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setAdminUserId(sessionStorage.getItem('admin_user_id') || '');
    loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    const storedId = sessionStorage.getItem('admin_user_id');
    if (!storedId) {
      setWsStatus('disconnected');
      wsRef.current?.close();
      wsRef.current = null;
      return;
    }

    let closedByEffect = false;
    let reconnectDelay = 1000;

    const connect = () => {
      if (closedByEffect) return;
      const currentId = sessionStorage.getItem('admin_user_id');
      if (!currentId) return;

      setWsStatus('connecting');
      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectDelay = 1000;
        ws.send(JSON.stringify({
          type: 'admin_join',
          adminPassword: getAdminPassword(),
          admin_user_id: currentId,
        }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'joined' && msg.room === 'admin') {
            setWsStatus('connected');
            return;
          }
          if (msg.type === 'error') {
            setWsStatus('disconnected');
            setError(`WS auth failed: ${msg.message || 'check admin password and user ID'}`);
            ws.close();
            return;
          }
          if (
            msg.type === 'sos_alert' ||
            msg.type === 'sos_acknowledged' ||
            msg.type === 'sos_resolved' ||
            msg.type === 'sos_sms_fallback_sent' ||
            msg.type === 'sos_sms_fallback_skipped' ||
            msg.type === 'refresh_sos'
          ) {
            loadEvents(false);
            setAcknowledgingId(null);
            setResolvingId(null);
          } else if (msg.type === 'sos_error') {
            setError(msg.message || 'SOS operation failed');
            setAcknowledgingId(null);
            setResolvingId(null);
          }
        } catch {
          // Keep REST refresh as fallback source of truth.
        }
      };

      ws.onclose = () => {
        setWsStatus('disconnected');
        if (closedByEffect) return;
        const delay = reconnectDelay;
        reconnectDelay = Math.min(reconnectDelay * 2, 10000);
        reconnectTimer.current = window.setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      closedByEffect = true;
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [loadEvents, adminUserId]);

  useEffect(() => {
    if (wsStatus === 'connected') return undefined;
    const pollTimer = window.setInterval(() => {
      loadEvents(false);
    }, 30000);
    return () => window.clearInterval(pollTimer);
  }, [loadEvents, wsStatus]);

  const activeEvents = useMemo(
    () => events.filter((event) => !event.resolved_at).sort((a, b) => +new Date(a.triggered_at) - +new Date(b.triggered_at)),
    [events]
  );
  const historyEvents = useMemo(
    () => [...events].sort((a, b) => +new Date(b.triggered_at) - +new Date(a.triggered_at)),
    [events]
  );
  const activeMapEvents = activeEvents.filter(hasCoordinates);
  const mapCenter = useMemo<[number, number]>(() => {
    if (activeMapEvents.length > 0) {
      return [Number(activeMapEvents[0].lat), Number(activeMapEvents[0].lng)];
    }
    return [45.9237, 6.8694];
  }, [activeMapEvents]);
  const sosIcon = useMemo<DivIcon | undefined>(() => {
    if (typeof window === 'undefined') return undefined;
    const L = require('leaflet');
    return L.divIcon({
      className: '',
      html: '<div class="h-4 w-4 rounded-full bg-red-500 ring-4 ring-red-500/30 shadow-lg shadow-red-500/40"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
  }, []);

  const acknowledgeEvent = async (id: string) => {
    if (!adminUserId) {
      setError('Admin user ID is required for acknowledge');
      return;
    }
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setError('WebSocket disconnected, acknowledge requires live admin connection');
      return;
    }
    setAcknowledgingId(id);
    setError('');
    wsRef.current.send(JSON.stringify({
      type: 'sos_acknowledge',
      sos_id: id,
      admin_user_id: adminUserId,
    }));
  };

  const resolveEvent = async (id: string) => {
    setResolvingId(id);
    setError('');
    try {
      if (adminUserId && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'sos_resolve',
          sos_id: id,
          admin_user_id: adminUserId,
        }));
        return;
      }
      // REST fallback: use the Phase 4 service path with admin identity
      await adminApi.resolveSos(id, adminUserId);
      await loadEvents(false);
    } catch (e: any) {
      setError(e.message || 'Failed to resolve SOS event');
    } finally {
      setResolvingId(null);
    }
  };

  const saveAdminUserId = (value: string) => {
    const trimmed = value.trim();
    const prevId = sessionStorage.getItem('admin_user_id');
    setAdminUserId(trimmed);
    sessionStorage.setItem('admin_user_id', trimmed);
    if (prevId !== trimmed && wsRef.current) {
      wsRef.current.close();
    }
  };

  return (
    <Layout>
      <div className="mb-6 flex items-center justify-between gap-3">
        <h2 className="text-2xl font-bold text-white">
          SOS Triage <span className="text-slate-400 text-lg font-normal">({events.length})</span>
          {activeEvents.length > 0 && (
            <span className="ml-3 rounded-full bg-red-900/60 px-3 py-1 text-sm font-bold text-red-400 animate-pulse">
              {activeEvents.length} ACTIVE
            </span>
          )}
        </h2>
        <button
          onClick={() => loadEvents()}
          className="rounded-lg bg-[#1e3a5f] px-4 py-2 text-sm text-white transition-colors hover:bg-[#1e88e5]"
        >
          Refresh
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3 text-xs">
        <span
          className={`inline-flex h-2 w-2 rounded-full ${
            wsStatus === 'connected' ? 'bg-green-400' : wsStatus === 'connecting' ? 'bg-yellow-400' : 'bg-red-400'
          }`}
        />
        <span className="text-slate-400">
          Live SOS feed {wsStatus}
          {wsStatus !== 'connected' && ' - polling every 30s'}
        </span>
      </div>

      <div className="mb-6 rounded-xl border border-[#1e3a5f] bg-[#06121f] p-4">
        <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-400">Admin User ID</label>
        <input
          value={adminUserId}
          onChange={(event) => saveAdminUserId(event.target.value)}
          placeholder="UUID for acknowledge/resolve attribution"
          className="w-full rounded-md border border-[#1e3a5f] bg-[#081a2c] px-3 py-2 text-sm text-white focus:border-[#1e88e5] focus:outline-none"
        />
      </div>

      {loading && <p className="text-slate-400">Loading...</p>}
      {error && <p className="mb-4 text-red-400">{error}</p>}

      {!loading && !error && (
        <div className="space-y-6">
          <div className="h-[360px] overflow-hidden rounded-xl border border-[#1e3a5f] bg-[#06121f]">
            <MapContainer
              key={`${mapCenter[0]}-${mapCenter[1]}-${activeMapEvents.length}`}
              center={mapCenter}
              zoom={activeMapEvents.length > 0 ? 13 : 5}
              className="h-full w-full"
            >
              <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
              {activeMapEvents.map((event) => (
                <Marker key={event.id} position={[Number(event.lat), Number(event.lng)]} icon={sosIcon}>
                  <Popup>
                    <div className="space-y-1">
                      <p className="font-semibold">{event.user_name}</p>
                      <p className="text-xs">{new Date(event.triggered_at).toLocaleString()}</p>
                      <p className="text-xs">Status: {getEventStatus(event)}</p>
                    </div>
                  </Popup>
                </Marker>
              ))}
            </MapContainer>
          </div>

          <div className="rounded-xl border border-[#1e3a5f]">
            <div className="border-b border-[#1e3a5f] bg-[#0d2034] px-4 py-3 text-sm font-semibold text-white">
              Active Queue
            </div>
            {activeEvents.length === 0 ? (
              <p className="px-4 py-8 text-center text-slate-400">No active SOS alerts.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[#0a1a2b]">
                    <tr>
                      <th className="px-4 py-3 text-left font-semibold text-slate-400">User</th>
                      <th className="px-4 py-3 text-left font-semibold text-slate-400">Triggered</th>
                      <th className="px-4 py-3 text-left font-semibold text-slate-400">Elapsed</th>
                      <th className="px-4 py-3 text-left font-semibold text-slate-400">GPS</th>
                      <th className="px-4 py-3 text-left font-semibold text-slate-400">Ack</th>
                      <th className="px-4 py-3 text-left font-semibold text-slate-400">Fallback</th>
                      <th className="px-4 py-3 text-right font-semibold text-slate-400">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeEvents.map((event, index) => (
                      <tr key={event.id} className={`border-t border-[#1e3a5f] ${index % 2 === 0 ? 'bg-[#06121f]' : 'bg-[#081a2c]'}`}>
                        <td className="px-4 py-3 font-semibold text-white">{event.user_name}</td>
                        <td className="px-4 py-3 text-slate-300">{new Date(event.triggered_at).toLocaleString()}</td>
                        <td className="px-4 py-3 font-mono text-red-300">{formatElapsed(event.triggered_at)}</td>
                        <td className="px-4 py-3 text-xs">
                          {hasCoordinates(event) ? (
                            <a
                              href={`https://uri.amap.com/marker?position=${Number(event.lng)},${Number(event.lat)}&name=SOS`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-[#64ffda] underline"
                            >
                              {Number(event.lat).toFixed(5)}, {Number(event.lng).toFixed(5)}
                            </a>
                          ) : (
                            <span className="text-slate-500">No location</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs">
                          {event.acknowledged_at ? (
                            <span className="text-amber-300">
                              {new Date(event.acknowledged_at).toLocaleTimeString()}
                              {event.acknowledged_by ? ` by ${event.acknowledged_by}` : ''}
                            </span>
                          ) : (
                            <span className="text-slate-500">Pending</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-300">{event.sms_fallback_status || 'pending'}</td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => acknowledgeEvent(event.id)}
                              disabled={Boolean(event.acknowledged_at || event.resolved_at) || acknowledgingId === event.id}
                              className="rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                            >
                              {acknowledgingId === event.id ? 'Acknowledging...' : event.acknowledged_at ? 'Acknowledged' : 'Acknowledge'}
                            </button>
                            <button
                              onClick={() => resolveEvent(event.id)}
                              disabled={Boolean(event.resolved_at) || resolvingId === event.id}
                              className="rounded-lg bg-red-700 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                            >
                              {resolvingId === event.id ? 'Resolving...' : 'Resolve'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="overflow-x-auto rounded-xl border border-[#1e3a5f]">
            <div className="border-b border-[#1e3a5f] bg-[#0d2034] px-4 py-3 text-sm font-semibold text-white">
              Alert History
            </div>
            <table className="w-full text-sm">
              <thead className="bg-[#0a1a2b]">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold text-slate-400">User</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-400">Triggered</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-400">Status</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-400">Resolved</th>
                </tr>
              </thead>
              <tbody>
                {historyEvents.map((event, index) => (
                  <tr key={event.id} className={`border-t border-[#1e3a5f] ${index % 2 === 0 ? 'bg-[#06121f]' : 'bg-[#081a2c]'}`}>
                    <td className="px-4 py-3 font-semibold text-white">{event.user_name}</td>
                    <td className="px-4 py-3 text-slate-300">{new Date(event.triggered_at).toLocaleString()}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded px-2 py-1 text-xs font-semibold ${
                          getEventStatus(event) === 'resolved'
                            ? 'bg-green-900/40 text-green-400'
                            : getEventStatus(event) === 'acknowledged'
                              ? 'bg-amber-900/40 text-amber-300'
                              : 'bg-red-900/50 text-red-400'
                        }`}
                      >
                        {getEventStatus(event)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-300">
                      {event.resolved_at ? new Date(event.resolved_at).toLocaleString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {historyEvents.length === 0 && <p className="py-8 text-center text-slate-400">No SOS events recorded.</p>}
          </div>
        </div>
      )}
    </Layout>
  );
}
