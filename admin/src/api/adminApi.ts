const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8100';

export function getAdminPassword(): string {
  if (typeof window === 'undefined') return '';
  return sessionStorage.getItem('admin_password') || '';
}

export function getBackendUrl(): string {
  return BACKEND_URL;
}

async function adminFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const password = getAdminPassword();
  const response = await fetch(`${BACKEND_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Password': password,
      ...(options.headers || {}),
    },
  });
  if (response.status === 401) {
    sessionStorage.removeItem('admin_password');
    window.location.href = '/';
    throw new Error('Unauthorized');
  }
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error((err as any).error || `HTTP ${response.status}`);
  }
  return response.json();
}

export interface AdminUser {
  id: string;
  device_id: string;
  name: string;
  created_at: string;
  banned_at: string | null;
}

export interface AdminGroup {
  id: string;
  name: string;
  invite_code: string;
  owner_id: string;
  max_members: number;
  member_count: number;
  created_at: string;
  closed_at: string | null;
}

export interface AdminSosEvent {
  id: string;
  user_id: string;
  user_name: string;
  group_id: string | null;
  lat: number | null;
  lng: number | null;
  triggered_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

export const adminApi = {
  getUsers: () => adminFetch<AdminUser[]>('/api/admin/users'),
  getGroups: () => adminFetch<AdminGroup[]>('/api/admin/groups'),
  getSosEvents: () => adminFetch<AdminSosEvent[]>('/api/admin/sos'),
  resolveSos: (id: string) =>
    adminFetch<AdminSosEvent & { resolved_by_admin: boolean }>(`/api/admin/sos/${id}/resolve`, { method: 'PATCH' }),
  banUser: (id: string) =>
    adminFetch<{ ok: boolean; banned_at: string }>(`/api/admin/users/${id}/ban`, { method: 'POST' }),
  deleteGroup: (id: string) =>
    adminFetch<{ ok: boolean }>(`/api/admin/groups/${id}`, { method: 'DELETE' }),
};
