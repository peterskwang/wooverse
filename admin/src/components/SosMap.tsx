'use client';

import React from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup } from 'react-leaflet';
import type { AdminSosEvent } from '../api/adminApi';

interface SosMapProps {
  events: AdminSosEvent[];
  resolvingIds: Set<string>;
  onResolve: (id: string) => void;
  mapKey: string;
  defaultCenter: [number, number];
}

export default function SosMap({ events, resolvingIds, onResolve, mapKey, defaultCenter }: SosMapProps) {
  const positions = events.map((e) => [Number(e.lat), Number(e.lng)] as [number, number]);

  return (
    <MapContainer
      key={mapKey}
      center={positions[0] || defaultCenter}
      zoom={12}
      bounds={positions}
      style={{ height: '360px', width: '100%' }}
      className="rounded-lg"
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {events.map((event) => (
        <CircleMarker
          key={event.id}
          center={[Number(event.lat), Number(event.lng)]}
          radius={10}
          pathOptions={{ color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.75 }}
        >
          <Popup>
            <div className="space-y-1">
              <p className="font-semibold">{event.user_name}</p>
              <p className="text-xs font-mono">
                {Number(event.lat).toFixed(5)}, {Number(event.lng).toFixed(5)}
              </p>
              <p className="text-xs text-slate-600">
                {new Date(event.triggered_at).toLocaleString()}
              </p>
              <button
                onClick={() => onResolve(event.id)}
                disabled={resolvingIds.has(event.id)}
                className="mt-1 bg-green-700 hover:bg-green-600 disabled:bg-slate-500 text-white text-xs px-3 py-1 rounded font-semibold"
              >
                {resolvingIds.has(event.id) ? 'Resolving...' : 'Resolve'}
              </button>
            </div>
          </Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
