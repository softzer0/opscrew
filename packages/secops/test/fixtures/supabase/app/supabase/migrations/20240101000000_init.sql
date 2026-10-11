-- Initial schema.
create table public.profiles (
  id uuid primary key references auth.users (id),
  email text not null,
  phone text,
  display_name text
);
alter table public.profiles enable row level security;

create table todos (
  id bigserial primary key,
  user_id uuid not null,
  title text not null
);

CREATE TABLE IF NOT EXISTS "public"."Orders" (
  "id" bigint PRIMARY KEY,
  "total" numeric
);

create table private.audit_log (id bigserial primary key, entry text);

create temporary table scratch (id int);

/* create table public.commented_out (id int); */
-- create table public.also_commented (id int);

create table public.posts (
  id bigserial primary key,
  user_id uuid not null,
  body text
);

create table public.dropped_later (id int);
drop table if exists public.dropped_later;

create policy "profiles are public" on public.profiles
  for select using (true);

create policy "service role manages profiles" on public.profiles
  for all to service_role using (true) with check (true);

create policy "anyone can add todos" on public.todos
  for insert with check (true);

create policy "posts are public" on public.posts for select using (true);

create policy "owners update posts" on public.posts
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant insert, update on table public.todos to anon;
grant select on public.posts to anon, authenticated;

insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true);
insert into storage.buckets (id, name, public) values ('invoices', 'invoices', false);

create function public.note() returns text language plpgsql as $$
begin
  -- create table public.inside_function (id int);
  return 'create table public.in_string (id int); grant all on public.posts to anon;';
end;
$$;
