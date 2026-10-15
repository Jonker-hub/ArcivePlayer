-- Hörstand-Sync ohne Konto: Geräte teilen sich einen geheimen Sync-Code.
-- Gespeichert wird nur der SHA-256-Hash des Codes; Zugriff ausschließlich über die beiden Funktionen.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.sync_state (
  key_hash text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.sync_state enable row level security;
revoke all on table public.sync_state from anon, authenticated;

create or replace function public.sync_get(p_key text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select s.state from public.sync_state s
  where length(p_key) >= 20
    and s.key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex');
$$;

create or replace function public.sync_put(p_key text, p_state jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if length(p_key) < 20 then raise exception 'Sync-Code zu kurz'; end if;
  if pg_column_size(p_state) > 2000000 then raise exception 'Zustand zu groß'; end if;
  insert into public.sync_state (key_hash, state, updated_at)
  values (encode(extensions.digest(p_key, 'sha256'), 'hex'), p_state, now())
  on conflict (key_hash) do update set state = excluded.state, updated_at = now();
end;
$$;

revoke all on function public.sync_get(text) from public;
revoke all on function public.sync_put(text, jsonb) from public;
grant execute on function public.sync_get(text) to anon, authenticated;
grant execute on function public.sync_put(text, jsonb) to anon, authenticated;
