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

### 2. Enable Google OAuth in Supabase

In Supabase Auth → Sign In / Providers, enable **Google** and paste in the
Client ID / Client Secret from a Google Cloud OAuth client (Web application
type). The authorized redirect URI on the Google side must be
`https://<project-ref>.supabase.co/auth/v1/callback`.

The current UI sends users through Google's OAuth consent screen
(`signInWithOAuth`) rather than emailing a magic link — this sidesteps
Supabase's default shared-mailer rate limit entirely, since no email is
sent as part of sign-in.

Prior to this, sign-in used Supabase's email OTP/magic-link flow. That was
dropped after hitting two real issues in practice: the shared mailer's low
rate limit, and a session that could get stuck in a corrupted state in the
browser's localStorage after a flaky magic-link exchange.

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
