import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { DivIcon } from 'leaflet';
import Layout from '../components/Layout';
import { adminApi, AdminSosEvent, getAdminPassword, getBackendUrl } from '../api/adminApi';

const MapContainer = dynamic(() => import('react-leaflet').then((mod) => mod.MapContainer), { ssr: false });
const TileLayer = dynamic(() => import('react-leaflet').then((mod) => mod.TileLayer), { ssr: false });
const Marker = dynamic(() => import('react-leaflet').then((mod) => mod.Marker), { ssr: false });
const Popup = dynamic(() => import('react-leaflet').then((mod) => mod.Popup), { ssr: false });

function getWsUrl() {
  return getBackendUrl().replace(/^http/, 'ws') + '/ws';
}

function hasCoordinates(event: AdminSosEvent) {
  return event.lat != null && event.lng != null && Number.isFinite(Number(event.lat)) && Number.isFinite(Number(event.lng));
}

export default function SosPage() {
  const [events, setEvents] = useState<AdminSosEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const reconnectTimer = useRef<number | null>(null);

  const loadEvents = useCallback(async (showLoading = true) => {
    try {
      if (showLoading) setLoading(true);
      setError('');
      const data = await adminApi.getSosEvents();
      setEvents(data);
    } catch (e: any) {
      setError(e.message || 'Failed to load SOS events');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closedByEffect = false;
    let reconnectDelay = 1000;

    const connect = () => {
      if (closedByEffect) return;
      setWsStatus('connecting');
      ws = new WebSocket(getWsUrl());

      ws.onopen = () => {
        reconnectDelay = 1000;
        setWsStatus('connected');
        ws?.send(JSON.stringify({ type: 'admin_join', adminPassword: getAdminPassword() }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'sos_alert' || msg.type === 'sos_resolved' || msg.type === 'refresh_sos') {
            loadEvents(false);
          }
        } catch {
          // Ignore malformed WS payloads; REST refresh remains the source of truth.
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
        ws?.close();
      };
    };

    connect();

    return () => {
      closedByEffect = true;
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
      ws?.close();
    };
  }, [loadEvents]);

  useEffect(() => {
    if (wsStatus === 'connected') return undefined;

    const pollTimer = window.setInterval(() => {
      loadEvents(false);
    }, 30000);

    return () => window.clearInterval(pollTimer);
  }, [loadEvents, wsStatus]);

  const activeEvents = events.filter((e) => !e.resolved_at);
  const activeMapEvents = activeEvents.filter(hasCoordinates);
  const activeCount = activeEvents.length;
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

  const resolveEvent = async (id: string) => {
    try {
      setResolvingId(id);
      setError('');
      await adminApi.resolveSos(id);
      await loadEvents(false);
    } catch (e: any) {
      setError(e.message || 'Failed to resolve SOS event');
    } finally {
      setResolvingId(null);
    }
  };

  return (
    <Layout>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-white">
          SOS Events{' '}
          <span className="text-slate-400 text-lg font-normal">({events.length})</span>
          {activeCount > 0 && (
            <span className="ml-3 bg-red-900/60 text-red-400 text-sm font-bold px-3 py-1 rounded-full animate-pulse">
              {activeCount} ACTIVE
            </span>
          )}
        </h2>
        <button
          onClick={() => loadEvents()}
          className="text-sm bg-[#1e3a5f] hover:bg-[#1e88e5] text-white px-4 py-2 rounded-lg transition-colors"
        >
          Refresh
        </button>
      </div>
      <div className="mb-4 flex items-center gap-3 text-xs">
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
      {loading && <p className="text-slate-400">Loading...</p>}
      {error && <p className="text-red-400">{error}</p>}
      {!loading && !error && (
        <div className="space-y-6">
          <div className="h-[360px] overflow-hidden rounded-xl border border-[#1e3a5f] bg-[#06121f]">
            <MapContainer
              key={`${mapCenter[0]}-${mapCenter[1]}-${activeMapEvents.length}`}
              center={mapCenter}
              zoom={activeMapEvents.length > 0 ? 13 : 5}
              className="h-full w-full"
            >
              <TileLayer
                attribution="&copy; OpenStreetMap contributors"
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {activeMapEvents.map((event) => (
                <Marker
                  key={event.id}
                  position={[Number(event.lat), Number(event.lng)]}
                  icon={sosIcon}
                >
                  <Popup>
                    <div className="space-y-2">
                      <p className="font-semibold">{event.user_name}</p>
                      <p>{new Date(event.triggered_at).toLocaleString()}</p>
                      <button
                        onClick={() => resolveEvent(event.id)}
                        disabled={resolvingId === event.id}
                        className="rounded bg-red-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
                      >
                        {resolvingId === event.id ? 'Resolving...' : 'Resolve'}
                      </button>
                    </div>
                  </Popup>
                </Marker>
              ))}
            </MapContainer>
          </div>
          <div className="overflow-x-auto rounded-xl border border-[#1e3a5f]">
            <table className="w-full text-sm">
              <thead className="bg-[#0d2034]">
                <tr>
                  <th className="px-4 py-3 text-left text-slate-400 font-semibold">User</th>
                  <th className="px-4 py-3 text-left text-slate-400 font-semibold">Coordinates</th>
                  <th className="px-4 py-3 text-left text-slate-400 font-semibold">Triggered</th>
                  <th className="px-4 py-3 text-left text-slate-400 font-semibold">Status</th>
                  <th className="px-4 py-3 text-right text-slate-400 font-semibold">Action</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event, i) => (
                  <tr
                    key={event.id}
                    className={`border-t border-[#1e3a5f] ${i % 2 === 0 ? 'bg-[#06121f]' : 'bg-[#081a2c]'}`}
                  >
                    <td className="px-4 py-3 text-white font-semibold">{event.user_name}</td>
                    <td className="px-4 py-3 font-mono text-[#64ffda] text-xs">
                      {hasCoordinates(event)
                        ? `${Number(event.lat).toFixed(5)}, ${Number(event.lng).toFixed(5)}`
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-slate-400">
                      {new Date(event.triggered_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      {event.resolved_at ? (
                        <span className="bg-green-900/40 text-green-400 px-2 py-1 rounded text-xs font-semibold">
                          Resolved {new Date(event.resolved_at).toLocaleDateString()}
                        </span>
                      ) : (
                        <span className="bg-red-900/50 text-red-400 px-2 py-1 rounded text-xs font-semibold animate-pulse">
                          ACTIVE
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => resolveEvent(event.id)}
                        disabled={Boolean(event.resolved_at) || resolvingId === event.id}
                        className="rounded-lg bg-red-700 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                      >
                        {resolvingId === event.id ? 'Resolving...' : event.resolved_at ? 'Resolved' : 'Resolve'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {events.length === 0 && (
              <p className="text-slate-400 text-center py-8">No SOS events recorded.</p>
            )}
          </div>
        </div>
      )}
    </Layout>
  );
}
