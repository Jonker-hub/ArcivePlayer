// Supabase Edge Function „ai-search“: nimmt eine Suchanfrage entgegen und lässt Claude im
// Internet Archive suchen. Der Anthropic-API-Key liegt als Secret ANTHROPIC_API_KEY im Projekt.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.134.0";
import { aiSearch } from "./core.js";

const ALLOWED_ORIGINS = [
  "https://jonker-hub.github.io",
  "http://localhost:8000",
  "http://localhost:8765",
];

// Einfache Bremse gegen Missbrauch (pro Instanz): max. 20 Suchen pro IP und Stunde.
const hits = new Map<string, number[]>();
const LIMIT = 20;
const WINDOW_MS = 60 * 60 * 1000;

const client = new Anthropic(); // liest ANTHROPIC_API_KEY

function cors(origin: string | null) {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "Nur POST" }, 405, origin);
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return json({ error: "Herkunft nicht erlaubt" }, 403, origin);

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= LIMIT) return json({ error: "Zu viele KI-Suchen. Bitte später erneut versuchen." }, 429, origin);
  recent.push(now);
  hits.set(ip, recent);

  let query = "";
  try {
    query = String((await req.json()).query || "").trim();
  } catch {
    return json({ error: "Ungültige Anfrage" }, 400, origin);
  }
  if (query.length < 2 || query.length > 300) return json({ error: "Suchbegriff zu kurz oder zu lang" }, 400, origin);

  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    return json({ error: "KI-Suche noch nicht eingerichtet (Secret ANTHROPIC_API_KEY fehlt)." }, 503, origin);
  }

  try {
    const result = await aiSearch(client, query);
    return json(result, 200, origin);
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: "Die KI ist gerade ausgelastet. Gleich nochmal versuchen." }, 503, origin);
    if (e instanceof Anthropic.AuthenticationError) return json({ error: "KI nicht eingerichtet (API-Key fehlt oder ist ungültig)." }, 500, origin);
    if (e instanceof Anthropic.APIError) return json({ error: `KI-Fehler (${e.status})` }, 502, origin);
    return json({ error: String((e as Error).message || e) }, 500, origin);
  }
});
