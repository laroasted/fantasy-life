# Commissioner auth phase 1

This phase secures commissioner-only actions in a gradual, easy-to-revert way.

## What changed

- Public visitors can still load the scoreboard, history, and local draft UI.
- Commissioner-only actions now rely on a Supabase Auth session instead of a shared frontend password.
- The draft publish/finalize step and season settings edits are gated behind commissioner sign-in.

## How to configure

### 1. Add commissioner emails in Vercel

Set this environment variable for the frontend:

```bash
REACT_APP_COMMISSIONER_EMAILS=you@example.com,backup@example.com
```

Only authenticated users whose email matches this list will unlock commissioner actions from the UI.

### 2. Enable Supabase email auth

In Supabase Auth, enable either:

- Email OTP / magic link, or
- Email + password

The current UI sends a magic-link email.

### 3. Recommended database hardening

Apply the SQL in `supabase/phase1_commissioner_auth.sql`.

That creates a `profiles` table and sample RLS policies so the same commissioner role can be enforced in the database, not just the UI.

## Rollback

This phase is intentionally isolated:

- remove the header commissioner login UI from `src/App.jsx`
- remove commissioner props from `DraftTool` / `SeasonSettings`
- restore any previous finalize/settings gate if needed

No existing public read flow was removed.

## Next phases

### Phase 2

- move draft state from local component state into Supabase draft session tables
- let everyone view the same live draft room
- keep commissioner as the only one who submits picks at first

### Phase 3

- add player accounts
- map each player to their own member slot
- only allow the current drafter to submit the next pick
- keep commissioner pause / override / correction tools
