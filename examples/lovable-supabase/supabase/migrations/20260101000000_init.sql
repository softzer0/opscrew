-- Planted problems for OpsCrew tests: `profiles` has no row-level security and a permissive
-- update policy; `habits` is configured correctly.
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text not null,
  full_name text
);

create policy "Anyone can update profiles"
  on public.profiles for update
  using (true);

create table public.habits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  title text not null
);

alter table public.habits enable row level security;

create policy "Users read their own habits"
  on public.habits for select
  using (auth.uid() = user_id);
