-- Phase 13: pre-assigned email -> member identity mapping
--
-- Closes the gap phase10's own migration comment flagged: open self-claim
-- was fine while it only affected push targeting, but it's wrong the
-- moment a real roster of emails is known — anyone could claim anyone's
-- name. With the real league roster in hand, claiming becomes automatic
-- instead of a manual picker: sign in with the right Google account and
-- you're claimed as that member before you ever open the account menu.
-- The manual "which of these are you?" picker (claim_member_identity,
-- phase10) stays as a fallback for any email that isn't in this map — a
-- guest, a changed email, someone added later — rather than being removed.
--
-- email_member_map is a tiny reference table, shielded the same way
-- commissioner_emails is (phase11): RLS enabled, zero policies, so
-- nothing can read it directly via PostgREST — only the security-definer
-- function below can see its contents.

create table if not exists public.email_member_map (
  email text primary key,
  member_id text not null references public.members (id) on delete cascade
);

alter table public.email_member_map enable row level security;

-- ACTION REQUIRED: this file intentionally does not include the actual
-- email addresses — seed them yourself in a separate statement, same
-- reasoning as commissioner_emails (phase11): real personal emails don't
-- belong in git history. One row per member, lowercased:
--
-- insert into public.email_member_map (email, member_id) values
--   ('person@example.com', 'member_id_from_the_members_table')
-- on conflict (email) do update set member_id = excluded.member_id;

-- Self-service, automatic version of claim_member_identity (phase10):
-- called on every sign-in (idempotent — a no-op if already claimed, or if
-- there's no mapping for this email) instead of waiting for someone to
-- open the picker. Mirrors claim_member_identity's own shielding
-- reasoning: a tightly scoped security-definer function instead of
-- exposing email_member_map, or a raw UPDATE on profiles, to the browser.
create or replace function public.auto_claim_member_identity()
returns text
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_mapped_member_id text;
  v_current_member_id text;
begin
  if v_uid is null then
    return null;
  end if;

  select member_id into v_current_member_id from public.profiles where id = v_uid;
  if v_current_member_id is not null then
    return v_current_member_id;
  end if;

  select lower(email) into v_email from auth.users where id = v_uid;
  if v_email is null then
    return null;
  end if;

  select member_id into v_mapped_member_id from public.email_member_map where email = v_email;
  if v_mapped_member_id is null then
    return null;
  end if;

  if exists (
    select 1 from public.profiles
    where member_id = v_mapped_member_id and id <> v_uid
  ) then
    return null;
  end if;

  insert into public.profiles (id, email, role, member_id)
  values (v_uid, v_email, 'member', v_mapped_member_id)
  on conflict (id) do update
    set member_id = excluded.member_id;

  return v_mapped_member_id;
end;
$func$;

revoke all on function public.auto_claim_member_identity() from public;
grant execute on function public.auto_claim_member_identity() to authenticated;
