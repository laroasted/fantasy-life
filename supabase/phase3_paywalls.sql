-- Phase 3: commissioner paywall toggle
--
-- Lets the commissioner "paywall" any league member's scoreboard row with a
-- custom message. Blocked in src/components/Scoreboard.jsx (blur + PayPal
-- button); edited in src/components/SeasonSettings.jsx (Paywall tab).
--
-- paywalls shape: { [member_id]: { enabled: boolean, message: string, updated_at: text } }

alter table public.seasons
  add column if not exists paywalls jsonb not null default '{}'::jsonb;

-- Commissioner writes go through the existing "commissioners can update
-- seasons" policy from phase1 (it already covers every column, paywalls
-- included). Anonymous visitors are never granted UPDATE on seasons —
-- instead, a visitor who pays unlocks their own row through this single
-- security-definer function, which can only ever flip one member's
-- `enabled` flag to false. It cannot touch scores, locks, or any other
-- member's row, so it's safe to expose to anon/authenticated.
create or replace function public.unlock_paywall(p_year integer, p_member_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.seasons
  set paywalls = jsonb_set(
    coalesce(paywalls, '{}'::jsonb),
    array[p_member_id],
    coalesce(paywalls -> p_member_id, '{}'::jsonb) || jsonb_build_object(
      'enabled', false,
      'updated_at', to_jsonb(now())
    ),
    true
  )
  where year = p_year
    and paywalls -> p_member_id ->> 'enabled' = 'true';
end;
$$;

revoke all on function public.unlock_paywall(integer, text) from public;
grant execute on function public.unlock_paywall(integer, text) to anon, authenticated;
