# Ten-Check Build Acceptance Standard

An outward-facing build is complete only after ten explicit acceptance checks pass. Compilation and unit tests are necessary but not sufficient.

1. Permanent synthetic fixture exists and is isolated.
2. Authorization, tenancy, and destination allowlist are correct.
3. Required configuration resolves without exposing secrets.
4. Inputs and persisted state are valid.
5. Core business logic produces the expected result.
6. User-visible rendering is correct.
7. Identity, branding, compliance, and safety guards are correct.
8. Fallback, failure, retry, and idempotency behavior is correct.
9. A safe production-shaped provider/runtime canary is accepted when applicable.
10. A durable receipt/state transition is verified and temporary artifacts are cleaned up.

Rules:

- Maintain clearly labelled reusable test customer/merchant and counterparty/lender fixtures where the domain has them.
- Route external canaries only to owner-controlled endpoints.
- Keep fixtures out of real campaigns, queues, analytics, payments, and customer operations.
- Never substitute a real customer or third party for a test fixture.
- A failed, skipped, assumed, or unverified check means the build is not complete.
- Do not claim 100% functionality while a known limitation remains.

SunBiz Shopping Out uses `scripts/shopout-email-canary.ts`, the permanent `SunBiz Template Test LLC` application, and the `[TEST] Adon Gmail - Template Canary` lender.
Run it only through `node C:\\Users\\echel\\JARVIS\\scripts\\run_oasis_acceptance.mjs scripts/shopout-email-canary.ts --send`; that runner supplies the required `react-server` condition and passes production credentials in memory.
