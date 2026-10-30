# OASIS Telegram webhook cutover

This lane is for CC's OASIS bot only. It does not replace or modify the legacy
SunBiz link-code route at `/api/telegram/webhook`.

## Runtime contract

- Queue and binding: `oasis-telegram-agent-jobs` / `TELEGRAM_AGENT_JOBS`.
- Dead-letter queue: `oasis-telegram-agent-jobs-dlq`. A job that exhausts
  retries is quarantined there; it is never silently discarded.
- Ingress: `POST /api/webhooks/oasis-telegram` with Telegram's
  `X-Telegram-Bot-Api-Secret-Token` header.
- Consumer target: signed, in-process
  `POST /api/webhooks/oasis-telegram/jobs`.
- Required secrets: `OASIS_TELEGRAM_BOT_TOKEN`,
  `OASIS_TELEGRAM_CHAT_ID`, `OASIS_TELEGRAM_WEBHOOK_SECRET`, and
  `OASIS_TELEGRAM_JOB_SIGNING_SECRET`.
- Own off-switch: `TELEGRAM_WEBHOOK_ENABLED=on`. Every other value is off.

The route accepts text from the configured private CC chat only. It resolves
the OASIS agents owner and the workspace's exact saved computer pairing, then
queues a `department_task_v2` run with API fallback forced off. A missing or
offline exact pairing gets the fixed reply `No paired computer is online right
now.`

## Single-consumer cutover

1. Create `oasis-telegram-agent-jobs` and
   `oasis-telegram-agent-jobs-dlq`; deploy with the switch off.
2. Verify the signed internal route and queue using synthetic jobs only.
3. Stop the one Windows poller before calling Telegram `setWebhook` for this
   route. Never run polling and a webhook for the same bot together.
4. Set the webhook secret header, verify `getWebhookInfo`, then flip
   `TELEGRAM_WEBHOOK_ENABLED=on` and send one CC-chat canary.

## Rollback

Set `TELEGRAM_WEBHOOK_ENABLED=off` first. Delete the Telegram webhook before
starting exactly one local poller (Mac or Windows). If the cloud queue is being
removed, drain or deliberately quarantine it, then remove both its producer
and consumer entries from `wrangler.jsonc` in the same deploy. Messages that
exhaust retries while the switch is off land in `oasis-telegram-agent-jobs-dlq`;
inspect and replay that queue only after the fault is fixed. The durable
receipts make an intentional replay idempotent.

Receipts use the existing `agent_events.idempotency_key` and status/visibility
columns, so no database migration is required. The receipt is written before
enqueue, the paired-computer run uses stable IDs, and outbound delivery is
marked `sending` before the network call. An ambiguous network result is never
retried, preventing duplicate inference and duplicate Telegram replies.
