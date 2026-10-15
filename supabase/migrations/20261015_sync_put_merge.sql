-- Zusammenführen auf dem Server: pro Eintrag gewinnt der neuere (updatedAt), damit kein Gerät
-- einen neueren Stand eines anderen Geräts überschreibt.
create or replace function public.sync_merge_bucket(p_old jsonb, p_new jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from (
    select coalesce(n.key, o.key) as k,
      case
        when n.value is null then o.value
        when o.value is null then n.value
        when coalesce((n.value->>'updatedAt')::numeric, 0) >= coalesce((o.value->>'updatedAt')::numeric, 0) then n.value
        else o.value
      end as v
    from jsonb_each(coalesce(p_old, '{}'::jsonb)) o
    full join jsonb_each(coalesce(p_new, '{}'::jsonb)) n on o.key = n.key
  ) t;
$$;

create or replace function public.sync_put(p_key text, p_state jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash text := encode(extensions.digest(p_key, 'sha256'), 'hex');
  v_old jsonb;
  v_merged jsonb;
begin
  if length(p_key) < 20 then raise exception 'Sync-Code zu kurz'; end if;
  if pg_column_size(p_state) > 2000000 then raise exception 'Zustand zu groß'; end if;
  select state into v_old from public.sync_state where key_hash = v_hash for update;
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
  insert into public.sync_state (key_hash, state, updated_at)
  values (v_hash, v_merged, now())
  on conflict (key_hash) do update set state = excluded.state, updated_at = now();
end;
$$;

revoke all on function public.sync_merge_bucket(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.sync_put(text, jsonb) from public;
grant execute on function public.sync_put(text, jsonb) to anon, authenticated;
