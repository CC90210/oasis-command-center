# Drip engine — controlled live test (2026-07-10)

After the audit + remediation (PR #17, per-rep routing + copy + C1/C2/H3/H5/H6 fixes),
running a controlled live test of all enabled sequences against throwaway test leads
(SMS → the team TT line, email → the operator inbox) — no real merchants.

`BRAVO_FORCE_DRY_RUN` is temporarily 0 for this deploy so the test leads send for real.
Real-lead enrollment stays OFF (`DRIPS_ENROLL_STAGES=__none__`) and only the seeded test
rows are queued, so nothing but the test leads can send. Reverted to the parked state
(sequences disabled) immediately after.
