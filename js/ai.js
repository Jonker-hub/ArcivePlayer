// KI-Suche über die Supabase Edge Function „ai-search“.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const aiAvailable = () => !!(SUPABASE_URL && SUPABASE_ANON_KEY);

const cache = new Map();

export function aiSearch(query) {
  const key = query.trim().toLowerCase();
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/ai-search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ query }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `KI-Suche fehlgeschlagen (${res.status})`);
    return data;
  })();
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  return p;
}
