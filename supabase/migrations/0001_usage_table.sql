-- Usage tracking: one row per signed-in user, tracking how many patterns
-- they've generated and whether they're a paying subscriber.
--
-- SECURITY MODEL (the whole point of this file):
-- This table decides who gets premium access, so it has to be impossible
-- for a signed-in user to edit their own row directly -- no hidden form
-- field, no crafted API call, nothing should be able to set is_premium to
-- true for free. Two things together make that true:
--
--   1. Row Level Security is on, and the ONLY privilege granted to the
--      "authenticated" role (signed-in users) is SELECT on their own row.
--      There is no insert/update/delete grant for that role at all -- in
--      Postgres, a grant has to exist before a policy is even evaluated,
--      so this alone blocks every direct write, independent of RLS.
--
--   2. The only two things that ever change a row are:
--        a. handle_new_user(), a trigger that fires automatically when
--           someone signs up, creating their row with pattern_count = 0
--           and is_premium = false.
--        b. increment_pattern_count(), an RPC the app calls after a
--           successful pattern generation. It's SECURITY DEFINER (runs
--           with the function owner's privileges, so it CAN write despite
--           the missing grant above) but it takes no parameters and only
--           ever updates auth.uid()'s own row by exactly +1 -- there's no
--           argument to pass a different user, and no way to touch
--           is_premium through it.
--
-- Net effect: no client-side code path, however it's invoked, can ever
-- grant premium access. That has to happen a different way later (a
-- Stripe webhook, running server-side with the service role key) -- which
-- is exactly the point of locking this table down this tightly now.
--
-- Written to be safe to run more than once (uses "if not exists" /
-- "or replace" / "drop ... if exists" throughout), in case it's ever
-- pasted into the SQL Editor twice by accident.
--
-- How to run this: open the Supabase dashboard for this project -> SQL
-- Editor -> New query -> paste this whole file -> Run. (The project needs
-- to be un-paused first, if it's currently paused.)

create table if not exists public.usage (
  user_id uuid primary key references auth.users (id) on delete cascade,
  pattern_count integer not null default 0,
  is_premium boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.usage enable row level security;

-- Required before the SELECT policy below means anything -- without this
-- grant, a signed-in user can't even attempt a SELECT on this table, full
-- stop. Deliberately the ONLY grant on this table for "authenticated":
-- no insert, update, or delete grant exists anywhere in this file.
grant select on public.usage to authenticated;

drop policy if exists "Users can view their own usage row" on public.usage;
create policy "Users can view their own usage row"
  on public.usage
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Creates a usage row the moment someone signs up, so the rest of the app
-- never has to handle "signed-in user with no usage row yet" as a case.
-- `set search_path = ''` is the current Supabase-recommended hardening for
-- SECURITY DEFINER functions -- it stops anyone from tricking this
-- function into resolving an unqualified table name to something other
-- than what it's supposed to touch. Because of that, every reference
-- inside the function body below is fully schema-qualified on purpose
-- (public.usage, not just usage).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.usage (user_id)
  values (new.id);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- The ONLY way a signed-in user's pattern_count can go up. SECURITY
-- DEFINER lets it bypass the missing insert/update grant above, but it
-- only ever touches auth.uid()'s own row (not a parameter the caller
-- controls), and there's no is_premium argument to even attempt passing.
create or replace function public.increment_pattern_count()
returns void
language plpgsql
security definer set search_path = ''
as $$
begin
  update public.usage
  set pattern_count = pattern_count + 1,
      updated_at = now()
  where user_id = auth.uid();
end;
$$;

-- Lets a signed-in user actually call the RPC above (the function's own
-- SECURITY DEFINER handles the table write; this just allows invoking it).
grant execute on function public.increment_pattern_count() to authenticated;
