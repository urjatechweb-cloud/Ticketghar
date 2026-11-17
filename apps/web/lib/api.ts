/** API base: server components use API_URL (internal), the browser uses NEXT_PUBLIC_API_URL. */
export const API_URL =
  (typeof window === 'undefined' ? process.env.API_URL : undefined) ??
  process.env.NEXT_PUBLIC_API_URL ??
  'http://localhost:4000';

export const WHATSAPP_NUMBER = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER ?? '9779856023233';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = Array.isArray(body.message) ? body.message.join(', ') : body.message ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return body as T;
}

export interface Listing {
  id: string;
  category: string;
  title: string;
  location: string;
  description: string;
  price_paisa: number;
  attributes: { minAge?: number; weightKg?: [number, number]; durationMin?: number };
  operator: string;
  next_available?: string | null;
  verified?: boolean;
}

export interface Slot {
  id: string;
  starts_at: string;
  seats_left: number;
  weather_status: 'open' | 'cancelled';
}

export const npr = (paisa: number) => `Rs ${(paisa / 100).toLocaleString('en-IN')}`;

export const nptDate = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu', ...opts });

export const CATEGORY_LABEL: Record<string, string> = {
  bungee: 'Bungee',
  zipline: 'Zipline',
  paragliding: 'Paragliding',
  rafting: 'Rafting',
  ultralight: 'Ultralight',
  boating: 'Boating',
};
