import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Layout from '../components/Layout';
import { adminApi, AdminGroup, getAdminPassword, getBackendUrl } from '../api/adminApi';

interface ChannelQueueEntry {
  user_id: string;
  name?: string;
  position?: number;
}

interface ChannelHolder {
  user_id: string;
  name?: string;
  granted_at?: string;
  expires_at?: string;
}

interface AdminChannel {
  id: string;
  name?: string;
  is_default?: boolean;
  created_at?: string;
  queue_length?: number;
  queue?: ChannelQueueEntry[];
  token_holder?: ChannelHolder | null;
}

function getWsUrl() {
  return getBackendUrl().replace(/^http/, 'ws') + '/ws';
}

export default function ChannelsPage() {
  const [groups, setGroups] = useState<AdminGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [channels, setChannels] = useState<AdminChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const reconnectTimer = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const selectedGroupIdRef = useRef('');

  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) || null,
    [groups, selectedGroupId]
  );

  const requestChannels = useCallback((groupId: string) => {
    if (!groupId) return;
    wsRef.current?.send(JSON.stringify({ type: 'admin_channels_list', groupId }));
  }, []);

  const sendAdminAction = useCallback((payload: Record<string, any>) => {
    wsRef.current?.send(JSON.stringify(payload));
  }, []);

  const loadGroups = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const data = await adminApi.getGroups();
      setGroups(data);
      if (!selectedGroupId && data.length > 0) {
        setSelectedGroupId(data[0].id);
      }
    } catch (e: any) {
      setError(e.message || 'Failed to load groups');
    } finally {
      setLoading(false);
    }
  }, [selectedGroupId]);

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  useEffect(() => {
    selectedGroupIdRef.current = selectedGroupId;
  }, [selectedGroupId]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closedByEffect = false;
    let reconnectDelay = 1000;

    const connect = () => {
      if (closedByEffect) return;
      setWsStatus('connecting');
      ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectDelay = 1000;
        setWsStatus('connected');
        ws?.send(JSON.stringify({ type: 'admin_join', adminPassword: getAdminPassword() }));
        if (selectedGroupIdRef.current) {
          requestChannels(selectedGroupIdRef.current);
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'admin_channels_snapshot' || msg.type === 'channels_snapshot') {
            if (msg.group_id === selectedGroupIdRef.current) {
              setChannels(Array.isArray(msg.channels) ? msg.channels : []);
            }
          }
        } catch {
          // Ignore malformed payloads.
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
      wsRef.current = null;
      if (reconnectTimer.current) {
        window.clearTimeout(reconnectTimer.current);
      }
      ws?.close();
    };
  }, [requestChannels]);

  useEffect(() => {
    if (wsStatus !== 'connected' || !selectedGroupId) return;
    requestChannels(selectedGroupId);
  }, [requestChannels, selectedGroupId, wsStatus]);

  return (
    <Layout>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-2xl font-bold text-white">
          Channel Controls
          <span className="ml-3 text-lg font-normal text-slate-400">({channels.length})</span>
        </h2>
        <button
          onClick={() => {
            loadGroups();
            if (selectedGroupId) requestChannels(selectedGroupId);
          }}
          className="rounded-lg bg-[#1e3a5f] px-4 py-2 text-sm text-white transition-colors hover:bg-[#1e88e5]"
        >
          Refresh
        </button>
      </div>

      <div className="mb-4 flex items-center gap-4 text-xs">
        <span
          className={`inline-flex h-2 w-2 rounded-full ${
            wsStatus === 'connected' ? 'bg-green-400' : wsStatus === 'connecting' ? 'bg-yellow-400' : 'bg-red-400'
          }`}
        />
        <span className="text-slate-400">Admin channel socket {wsStatus}</span>
      </div>

      {loading ? <p className="text-slate-400">Loading groups...</p> : null}
      {error ? <p className="mb-4 text-red-400">{error}</p> : null}

      {!loading && (
        <div className="mb-6 rounded-xl border border-[#1e3a5f] bg-[#06121f] p-4">
          <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-400">Group</label>
          <select
            value={selectedGroupId}
            onChange={(event) => setSelectedGroupId(event.target.value)}
            className="w-full rounded-lg border border-[#1e3a5f] bg-[#081a2c] px-3 py-2 text-sm text-white outline-none focus:border-[#1e88e5]"
          >
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name} ({group.member_count} members)
              </option>
            ))}
          </select>
          {selectedGroup ? (
            <p className="mt-2 text-xs text-slate-400">Managing: {selectedGroup.name}</p>
          ) : null}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-[#1e3a5f]">
        <table className="w-full text-sm">
          <thead className="bg-[#0d2034]">
            <tr>
              <th className="px-4 py-3 text-left font-semibold text-slate-400">Channel</th>
              <th className="px-4 py-3 text-left font-semibold text-slate-400">Token Holder</th>
              <th className="px-4 py-3 text-left font-semibold text-slate-400">Queue</th>
              <th className="px-4 py-3 text-left font-semibold text-slate-400">Created</th>
              <th className="px-4 py-3 text-right font-semibold text-slate-400">Actions</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((channel, index) => (
              <tr
                key={channel.id}
                className={`border-t border-[#1e3a5f] ${index % 2 === 0 ? 'bg-[#06121f]' : 'bg-[#081a2c]'}`}
              >
                <td className="px-4 py-3">
                  <p className="font-semibold text-white">{channel.name || channel.id}</p>
                  <p className="font-mono text-xs text-slate-400">{channel.id}</p>
                </td>
                <td className="px-4 py-3">
                  {channel.token_holder?.user_id ? (
                    <div className="space-y-2">
                      <p className="font-semibold text-[#64ffda]">{channel.token_holder.name || channel.token_holder.user_id}</p>
                      <p className="font-mono text-xs text-slate-400">{channel.token_holder.user_id}</p>
                      <button
                        onClick={() =>
                          sendAdminAction({
                            type: 'admin_channel_mute',
                            groupId: selectedGroupId,
                            channelId: channel.id,
                            userId: channel.token_holder?.user_id,
                          })
                        }
                        className="rounded bg-amber-700 px-2 py-1 text-xs font-semibold text-white hover:bg-amber-600"
                      >
                        Mute Holder
                      </button>
                    </div>
                  ) : (
                    <span className="text-slate-500">None</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {channel.queue && channel.queue.length > 0 ? (
                    <div className="space-y-2">
                      {channel.queue.map((entry) => (
                        <div key={`${channel.id}-${entry.user_id}`} className="flex items-center justify-between gap-3 rounded bg-[#0d2034] px-2 py-1">
                          <div>
                            <p className="text-xs font-semibold text-white">
                              #{entry.position || '?'} {entry.name || entry.user_id}
                            </p>
                            <p className="font-mono text-[11px] text-slate-400">{entry.user_id}</p>
                          </div>
                          <button
                            onClick={() =>
                              sendAdminAction({
                                type: 'admin_channel_mute',
                                groupId: selectedGroupId,
                                channelId: channel.id,
                                userId: entry.user_id,
                              })
                            }
                            className="rounded bg-amber-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-amber-600"
                          >
                            Mute
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <span className="text-slate-500">Empty</span>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-400">
                  {channel.created_at ? new Date(channel.created_at).toLocaleString() : '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() =>
                        sendAdminAction({
                          type: 'admin_channel_rotate',
                          groupId: selectedGroupId,
                          channelId: channel.id,
                        })
                      }
                      className="rounded-lg bg-[#1e3a5f] px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[#1e88e5]"
                    >
                      Force Rotate
                    </button>
                    <button
                      onClick={() =>
                        sendAdminAction({
                          type: 'admin_channel_delete',
                          groupId: selectedGroupId,
                          channelId: channel.id,
                        })
                      }
                      disabled={channel.id === 'general'}
                      className="rounded-lg bg-red-700 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {channels.length === 0 && !loading ? (
          <p className="py-8 text-center text-slate-400">No channels found for this group.</p>
        ) : null}
      </div>
    </Layout>
  );
}
