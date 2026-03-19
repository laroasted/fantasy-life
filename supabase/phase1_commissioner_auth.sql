create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text unique,
  role text not null default 'member' check (role in ('member', 'commissioner', 'admin')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy if not exists "profiles are readable by authenticated users"
on public.profiles
for select
to authenticated
using (true);

create policy if not exists "users can insert their own profile"
on public.profiles
for insert
to authenticated
with check (auth.uid() = id);

create policy if not exists "users can update their own profile"
on public.profiles
for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

-- Example read policies for public scoreboard tables.
-- Keep or adjust depending on which tables should stay public.
alter table public.seasons enable row level security;
alter table public.members enable row level security;
alter table public.picks enable row level security;

create policy if not exists "public can read seasons"
on public.seasons
for select
to anon, authenticated
using (true);

create policy if not exists "public can read members"
on public.members
for select
to anon, authenticated
using (true);

create policy if not exists "public can read picks"
on public.picks
for select
to anon, authenticated
using (true);

-- Commissioner/admin write policy examples.
create policy if not exists "commissioners can update seasons"
on public.seasons
for update
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role in ('commissioner', 'admin')
  )
)
with check (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role in ('commissioner', 'admin')
  )
);

-- Seed the first commissioner profile after that user signs in once:
-- insert into public.profiles (id, email, role)
-- values ('<auth-user-uuid>', 'you@example.com', 'commissioner')
-- on conflict (id) do update set role = excluded.role, email = excluded.email;
