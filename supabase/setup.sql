-- Gyle: database setup for "Gyle account" storage.
-- Run this once in your Supabase project: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- It is safe to run again.

-- One table holds everything as JSON documents: recipes (BeerJSON), brew logs and settings.
create table if not exists public.documents (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  kind       text        not null check (kind in ('recipes', 'brews', 'settings')),
  id         text        not null,
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, id)
);

-- updated_at is the document's version: bump it on every change.
create or replace function public.gyle_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists documents_touch on public.documents;
create trigger documents_touch before update on public.documents
  for each row execute function public.gyle_touch();

-- Row-level security: a signed-in person can only see and change their own rows.
alter table public.documents enable row level security;

drop policy if exists "own documents" on public.documents;
create policy "own documents" on public.documents
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke all on public.documents from anon;
grant select, insert, update, delete on public.documents to authenticated;

-- Keep-alive for the free plan (optional). A scheduled job calls gyle_heartbeat() every few days;
-- it writes one timestamp, which counts as database activity. It exposes nothing about your data.
create table if not exists public.heartbeat (
  id   boolean primary key default true check (id),
  beat timestamptz not null default now()
);
alter table public.heartbeat enable row level security;  -- no policies: only the function below can touch it

create or replace function public.gyle_heartbeat() returns timestamptz
language sql security definer set search_path = public as $$
  insert into public.heartbeat (id, beat) values (true, now())
  on conflict (id) do update set beat = excluded.beat
  returning beat;
$$;

revoke all on function public.gyle_heartbeat() from public;
grant execute on function public.gyle_heartbeat() to anon, authenticated;

-- Photos for brew logs: a private storage bucket. Each person's photos are in a folder named
-- after their user id, and a signed-in person can only see and change their own folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "own photos" on storage.objects;
create policy "own photos" on storage.objects
  for all to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
