import React, { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Layout from '../components/Layout';
import { adminApi, AdminSosEvent } from '../api/adminApi';
import 'leaflet/dist/leaflet.css';

const SosMap = dynamic(() => import('../components/SosMap'), { ssr: false });

type WsStatus = 'connecting' | 'connected' | 'disconnected';

const DEFAULT_CENTER: [number, number] = [25.033, 121.5654];

export default function SosPage() {
  const [events, setEvents] = useState<AdminSosEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [resolvingIds, setResolvingIds] = useState<Set<string>>(new Set());
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting');

  const loadEvents = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const data = await adminApi.getSosEvents();
      setEvents(data);
    } catch (e: any) {
      setError(e.message || 'Failed to load SOS events');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleResolve = useCallback(
    async (id: string) => {
      if (resolvingIds.has(id)) return;
      setResolvingIds((prev) => new Set(prev).add(id));
      try {
        await adminApi.resolveSos(id);
        await loadEvents();
      } catch (e: any) {
        setError(e.message || 'Failed to resolve SOS event');
      } finally {
        setResolvingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [loadEvents, resolvingIds]
  );

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    let cancelled = false;

    import('leaflet').then((leafletModule: any) => {
      if (cancelled) return;
      const L = leafletModule.default || leafletModule;
      delete (L.Icon.Default.prototype as any)._getIconUrl;
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
        iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
        shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
      });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;

    const connect = () => {
      const baseWsUrl = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8100';
      const wsUrl = baseWsUrl.endsWith('/ws') ? baseWsUrl : `${baseWsUrl}/ws`;
      setWsStatus('connecting');
      socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        setWsStatus('connected');
        socket?.send(JSON.stringify({ type: 'admin_join' }));
      };

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (['sos_alert', 'sos_resolved', 'refresh_sos'].includes(msg.type)) {
            loadEvents();
          }
        } catch {
          // Ignore malformed WS payloads.
        }
      };

      socket.onclose = () => {
        if (closed) return;
        setWsStatus('disconnected');
        reconnectTimer = setTimeout(connect, 3000);
      };

      socket.onerror = () => {
        socket?.close();
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [loadEvents]);

  const activeEvents = useMemo(() => events.filter((e) => !e.resolved_at), [events]);
  const activeMappableEvents = useMemo(
    () => activeEvents.filter((e) => e.lat != null && e.lng != null),
    [activeEvents]
  );

  const mapKey = useMemo(
    () => activeMappableEvents.map((e) => e.id).join(','),
    [activeMappableEvents]
  );

  return (
    <Layout>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-white">
          SOS Events{' '}
          <span className="text-slate-400 text-lg font-normal">({events.length})</span>
          {activeEvents.length > 0 && (
            <span className="ml-3 bg-red-900/60 text-red-400 text-sm font-bold px-3 py-1 rounded-full animate-pulse">
              {activeEvents.length} ACTIVE
            </span>
          )}
        </h2>
        <div className="flex items-center gap-3">
          <span
            className={`text-xs px-3 py-1 rounded-full font-semibold ${
              wsStatus === 'connected'
                ? 'bg-green-900/50 text-green-300'
                : wsStatus === 'connecting'
                ? 'bg-yellow-900/50 text-yellow-300'
                : 'bg-red-900/50 text-red-300'
            }`}
          >
            WS {wsStatus}
          </span>
          <button
            onClick={loadEvents}
            className="text-sm bg-[#1e3a5f] hover:bg-[#1e88e5] text-white px-4 py-2 rounded-lg transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="mb-6 rounded-xl border border-[#1e3a5f] bg-[#06121f] p-3">
        {activeMappableEvents.length === 0 ? (
          <div className="h-[360px] rounded-lg border border-dashed border-[#1e3a5f] flex items-center justify-center text-slate-400 text-sm">
            No active SOS coordinates to map.
          </div>
        ) : (
          <SosMap
            events={activeMappableEvents}
            resolvingIds={resolvingIds}
            onResolve={handleResolve}
            mapKey={mapKey}
            defaultCenter={DEFAULT_CENTER}
          />
        )}
      </div>

      {loading && <p className="text-slate-400">Loading...</p>}
      {error && <p className="text-red-400">{error}</p>}
      {!loading && !error && (
        <div className="overflow-x-auto rounded-xl border border-[#1e3a5f]">
          <table className="w-full text-sm">
            <thead className="bg-[#0d2034]">
              <tr>
                <th className="px-4 py-3 text-left text-slate-400 font-semibold">User</th>
                <th className="px-4 py-3 text-left text-slate-400 font-semibold">Coordinates</th>
                <th className="px-4 py-3 text-left text-slate-400 font-semibold">Triggered</th>
                <th className="px-4 py-3 text-left text-slate-400 font-semibold">Status</th>
                <th className="px-4 py-3 text-left text-slate-400 font-semibold">Actions</th>
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
                    {event.lat != null && event.lng != null
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
                  <td className="px-4 py-3">
                    {event.resolved_at ? (
                      <span className="text-slate-500 text-xs">—</span>
                    ) : (
                      <button
                        onClick={() => handleResolve(event.id)}
                        disabled={resolvingIds.has(event.id)}
                        className="bg-green-700 hover:bg-green-600 disabled:bg-slate-500 text-white text-xs px-3 py-1 rounded font-semibold"
                      >
                        {resolvingIds.has(event.id) ? 'Resolving...' : 'Resolve'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {events.length === 0 && (
            <p className="text-slate-400 text-center py-8">No SOS events recorded.</p>
          )}
        </div>
      )}
    </Layout>
  );
}
