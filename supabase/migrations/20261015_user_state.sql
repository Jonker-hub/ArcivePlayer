-- Hörstand pro Konto (Supabase Auth, Anmeldung per E-Mail-Code). Ersetzt den Sync-Code.
create table if not exists public.user_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.user_state enable row level security;

create policy "eigener Hörstand lesen" on public.user_state
  for select to authenticated using ((select auth.uid()) = user_id);

-- Schreiben nur über state_put (führt zusammen statt zu überschreiben)
revoke insert, update, delete on table public.user_state from anon, authenticated;

create or replace function public.state_get()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select s.state from public.user_state s where s.user_id = (select auth.uid());
$$;

-- Pro Eintrag gewinnt der neuere (updatedAt), damit kein Gerät den neueren Stand eines anderen überschreibt.
create or replace function public.state_put(p_state jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_old jsonb;
  v_merged jsonb;
begin
  if v_uid is null then raise exception 'Nicht angemeldet'; end if;
  if pg_column_size(p_state) > 2000000 then raise exception 'Zustand zu groß'; end if;
  select state into v_old from public.user_state where user_id = v_uid for update;
  if v_old is null then
    v_merged := p_state;
  else
    v_merged := jsonb_build_object(
      'progress', public.sync_merge_bucket(v_old->'progress', p_state->'progress'),
      'favorites', public.sync_merge_bucket(v_old->'favorites', p_state->'favorites'),
      'lastId', case when coalesce((p_state->>'lastAt')::numeric, 0) >= coalesce((v_old->>'lastAt')::numeric, 0) then p_state->'lastId' else v_old->'lastId' end,
      'lastAt', greatest(coalesce((p_state->>'lastAt')::numeric, 0), coalesce((v_old->>'lastAt')::numeric, 0))
    );
  end if;
  insert into public.user_state (user_id, state, updated_at)
  values (v_uid, v_merged, now())
  on conflict (user_id) do update set state = excluded.state, updated_at = now();
end;
$$;

revoke all on function public.state_get() from public, anon;
revoke all on function public.state_put(jsonb) from public, anon;
grant execute on function public.state_get() to authenticated;
grant execute on function public.state_put(jsonb) to authenticated;

-- Alter Sync per Code wird nicht mehr gebraucht
drop function if exists public.sync_get(text);
drop function if exists public.sync_put(text, jsonb);
drop table if exists public.sync_state;
