-- Futures grid bot state. Deliberately its own table rather than another
-- column on runner_state: the grid has a config and a runtime state that
-- change on different cadences from the heartbeat, and one row per
-- (user, symbol) lets several grids run without contending on one row.
create table if not exists public.futures_grid_state (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  symbol text not null,
  config jsonb not null,
  runtime_state jsonb not null,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, symbol)
);

create index if not exists futures_grid_state_user_idx
  on public.futures_grid_state (user_id);

create index if not exists futures_grid_state_active_idx
  on public.futures_grid_state (user_id, active);

grant select, insert, update, delete on public.futures_grid_state to authenticated;
grant all on public.futures_grid_state to service_role;

alter table public.futures_grid_state
  enable row level security;

drop policy if exists "futures_grid_state_owner_select" on public.futures_grid_state;

create policy "futures_grid_state_owner_select"
on public.futures_grid_state
for select
using (auth.uid() = user_id);

drop policy if exists "futures_grid_state_owner_insert" on public.futures_grid_state;

create policy "futures_grid_state_owner_insert"
on public.futures_grid_state
for insert
with check (auth.uid() = user_id);

drop policy if exists "futures_grid_state_owner_update" on public.futures_grid_state;

create policy "futures_grid_state_owner_update"
on public.futures_grid_state
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "futures_grid_state_owner_delete" on public.futures_grid_state;

create policy "futures_grid_state_owner_delete"
on public.futures_grid_state
for delete
using (auth.uid() = user_id);
