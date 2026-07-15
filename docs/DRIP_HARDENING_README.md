# Drip engine hardening — env knobs & rollout

Fixes the two gaps the go-live engine shipped with: (1) no send caps / ignored
pause toggle, (2) weak email auth (missing DKIM). Full rationale:
`docs/EMAIL_DRIP_OPTIMIZATION_PLAN_2026-07-14.md` (JARVIS). All new behavior is
env-gated and fails SOFT — with nothing set, defaults are safe steady-state.

## New env vars (Vercel project)

| Var | Default | What it does |
|-----|---------|--------------|
| `DRIPS_EMAIL_DAILY_CAP` | `150` | Max REAL drip emails / rolling 24h (one mailbox). Ramp this during warm-up. |
| `DRIPS_EMAIL_HOURLY_CAP` | `25` | Max REAL drip emails / rolling 60min (spreads sends, looks human). |
| `DRIPS_PER_LEAD_WEEKLY_EMAIL_CAP` | `2` | Max drip emails to ONE lead / rolling 7d. |
| `DRIPS_ENROLL_DAILY_CAP` | `50` | Max NEW leads enrolled / rolling 24h across ALL sequences. Ramp this too. |
| `DRIPS_CIRCUIT_OPEN` | *(off)* | `1` = hold ALL real sends this run (kill switch). |
| `DRIP_AUTH_GATE` | `warn` | `warn` = send + flag if DKIM missing; `enforce` = hold email until DKIM verified; `off`. |
| `DRIP_SENDING_DOMAIN` | `sunbizfunding.com` | Domain the auth pre-flight checks. |
| `DRIP_DKIM_SELECTOR` | `google` | DKIM selector to look up (match the Google Admin selector). |

Caps govern EMAIL only (the single-mailbox bottleneck). SMS stays bounded by
`DRIPS_ENROLL_LIMIT` upstream. Existing gates unchanged: `DRIPS_LIVE` (go-live),
`BRAVO_FORCE_DRY_RUN` (global hard kill), `DRIPS_ENROLL_STAGES` / `DRIPS_ENROLL_LIMIT`.

## 6-week warm-up ramp (set these two, step weekly)

| Week | `DRIPS_EMAIL_DAILY_CAP` | `DRIPS_ENROLL_DAILY_CAP` |
|------|------|------|
| 1 (days 1-3 / 4-7) | 25 → 40 | 15 |
| 2 | 60 | 20 |
| 3 | 90 | 30 |
| 4 | 120 | 40 |
| 5-6+ (steady) | 150 | 50 |

Advance a step only if Postmaster spam rate < 0.10% and bounce < 2%.

## Order of operations

1. **DKIM first** — `docs/DKIM_DNS_HANDOFF_FOR_CC.md` → CC. Verify with
   `node scripts/verify-email-auth.mjs` (must be ALL GREEN).
2. Set week-1 caps, keep `DRIP_AUTH_GATE=warn`.
3. Walk the ramp weekly.
4. Kill switch if anything looks wrong: set `DRIPS_CIRCUIT_OPEN=1` (or the
   existing `BRAVO_FORCE_DRY_RUN=1`).

## Fast-follow (not in this change)

- DB-backed circuit breaker the `drip-watchdog.mjs` trips automatically on a
  bounce/spam spike (today the breaker is the env flag above; watchdog still
  only alerts).
- Bounce/complaint ingestion from Postmaster/the mailbox to drive auto-pause.
