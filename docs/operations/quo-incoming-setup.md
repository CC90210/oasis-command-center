# Quo incoming-text setup

An actual workspace owner opens Settings > Connections > Quo, saves the API
key if needed, loads the authorized number list, selects a sender, and chooses
Connect incoming texts. Broad administrator grants and deactivated owner seats
do not authorize this action.

The server uses the existing tenant credential resolver. OASIS's deployment key
is available only under its existing OASIS-only fallback policy. No key, signing
secret or raw provider response is returned to the browser. The provider calls
are versioned `GET /phone-numbers?include=restrictions`, `GET /webhooks`, then one
`POST /webhooks` for `message.received`, the selected phone resource, and this
tenant's fixed public callback URL. There are no SMS sends, test deliveries,
webhook deletions or signing-key rotations in setup.

The selected sender, API key and returned webhook fields commit together as
encrypted tenant credentials. An encrypted internal `quo_setup_operation` row
serializes registration across requests. Settings edits during setup are detected
and preserved. The operation state is not an editable integration schema.

Setup does not mark STOP handling ready. The existing intake must receive a valid
signed incoming message for the exact organization, phone ID and recipient number.
The owner can text the chosen Quo number from their own phone, then use Check
incoming delivery. The provider's canonical test sample uses sample identifiers;
it is not assumed to prove this account/number binding. Existing consent,
quiet-hours, suppression and live-send gates continue to apply.

## Interrupted registration

- Before the provider write starts, failed discovery changes nothing. The source
  credential snapshot and registration claim are checked in one transaction,
  so a concurrent settings edit during discovery leaves no permanent claim.
- Once the durable `creating` record exists, no automatic expiry allows another
  registration. An interrupted provider POST may have succeeded.
- A successfully returned signing key is stored in an encrypted `registered`
  candidate before the final credential transaction. If that final transaction
  fails, Finish saving setup resumes the stored candidate without another POST.
  The saved sender and recovery action remain available during a Quo outage;
  reopening setup and finishing this candidate make no provider requests.
- If the provider result or candidate persistence is uncertain, the UI requires
  support review. Do not delete the operation or blindly retry registration. A
  signing key that never reached durable storage cannot be recovered by guessing;
  inspect provider registration metadata and obtain explicit approval for any
  replacement/rotation. No such repair mutation is automatic here.
- A later manual key/number edit reports setup drift. It does not overwrite the
  new settings, enable texting, or silently register an additional webhook.

The first release intentionally has no automatic replacement or rotation path.
Existing manually configured callbacks are preserved for review.

## Offline verification

`npm run test:connections` includes `tests/quo-setup.test.ts`. It uses real SQLite
and encryption with intercepted HTTP. Fixtures cover owner and tenant isolation,
pagination, concurrent requests, uncertain provider results, rollback and resume,
credential edits during reads/writes, and the separate signed-delivery gate.

Primary provider contracts:
- https://www.quo.com/docs/2026-03-30/phone-numbers/list-phone-numbers
- https://www.quo.com/docs/2026-03-30/webhooks/lists-all-webhooks
- https://www.quo.com/docs/2026-03-30/webhooks/create-a-new-webhook
- https://www.quo.com/docs/2026-03-30/webhook-events/send-a-test-event-to-a-webhook
