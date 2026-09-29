# Business Ledger (`lib/ledger`)

One append-only, tenant-scoped record of what the business and its agents did
(`outcome_events`, migration `database/turso/bravo__190_ledger_core.sql`). KPI
tiles, the Feed and the learning loops read it. Plan: OASIS OS v2 §F2.

| File | Job |
|---|---|
| `catalog.ts` | Every event key: version, department, owning module, allowed producers, subjects, required join keys, payload schema, idempotency key. |
| `emit.ts` | `emit()` / `emitIfChanged()` return an INSERT for the caller's own `db.batch`. `assertNoPayloadConflicts()` runs after the batch. |
| `ingest.ts` | `POST /api/ledger/ingest` for BEA, Maven and Atlas. |
| `read.ts` | `countByKey`, `latestFor`, `coverage` for the metric registry. |
| `purge.ts` | The one delete path: a retired tenant's whole ledger. |

## Rules

1. **Rows are never edited or deleted.** Triggers abort UPDATE and DELETE. A
   correction is a new event with a `causation_id`. The only delete is
   `purgeTenantLedger` for a tenant listed in `lib/tenant/retired.ts`.
2. **One writer per event key.** The catalog names the one module that may emit
   a key. `tests/ledger-core.test.ts` fails when a module that imports
   `lib/ledger/emit` names a key it does not own. Python harnesses never write
   these tables; they POST to the ingest route, and only for keys whose
   `producers` list names them.
3. **Same batch as the business write.** `emit` never runs anything itself. Put
   its statement in the batch that makes the change, so both commit or neither
   does. After a compare-and-swap, use `emitIfChanged`, which inserts only when
   the statement just before it changed exactly one row. See `eventWithLedger`
   in `lib/os/approvals/store.ts`.
4. **Idempotent, loudly.** `UNIQUE(tenant_id, idempotency_key)` with
   `ON CONFLICT DO NOTHING`. When a key can come from outside (a provider id),
   call `assertNoPayloadConflicts(db, batch)` after the batch: the same key with
   different content throws, and the first row stands.
5. **Tenant from the subject, never a default.** `tenantId` is required. There
   is no fallback to OASIS.
6. **Ids and codes only.** A payload field is an id, a code, an integer, a
   boolean or a UTC time. Undeclared fields are refused. An id cannot hold `@`,
   `+` or whitespace, so an email, an E.164 phone or a sentence is refused.
   Names and message bodies stay in entity tables.
7. **Two clocks.** `occurred_at` is the source's time. `recorded_at` is the
   server's time.
8. **A backfill is `inferred`.** Anything reconstructed after the fact says so.

## Adding an event

1. Add an `ev({...})` entry to `catalog.ts` with a `domain.verb` key, version
   1, the department, the owning module (a path that exists), `producers` if a
   Python harness sends it, subjects, required join keys, a payload schema made
   of `id()` / `code([...])` / `int()` / `time()` / `opt(...)`, and the
   idempotency key template.
2. Emit it from that module only, in the same batch as the write it records.
3. Test the chokepoint: the row appears with the write, is absent when the
   write rolls back or its CAS loses, and a failed ledger insert rolls the write
   back.

To change a payload shape, add version 2. Never reshape version 1.

## Calling ingest from Python

```
POST /api/ledger/ingest
x-ledger-producer:  bea | maven | atlas
x-ledger-timestamp: <unix seconds>            (±5 minutes of server time)
x-ledger-signature: hex(HMAC-SHA256(secret, f"{timestamp}.{raw_body}"))
body: {"events": [ ... up to 100 ... ]}
```

The secret is `LEDGER_INGEST_SECRET_<PRODUCER>` (for example
`LEDGER_INGEST_SECRET_BEA`), at least 32 characters, held by the producer and
the Worker only.

```python
import hashlib, hmac, json, time
body = json.dumps({"events": [event]}, separators=(",", ":"))
ts = str(int(time.time()))
sig = hmac.new(secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
headers = {"x-ledger-producer": "bea", "x-ledger-timestamp": ts,
           "x-ledger-signature": sig, "content-type": "application/json"}
```

An event uses the column names: `event_key`, `event_version`, `occurred_at`,
`subject: {type, id}`, `contact_id` / `deal_id` / `customer_id`, `actor:
{type, id}`, `source`, `source_ref`, `idempotency_key`, `confidence`, `payload`,
optional `value_cents` + `currency`, optional trace ids, and optional
`producer_ref` (the script path). Send `tenant_id` only when the subject is not
a lead, contact, deal, customer or approval. For those, the subject's own row
sets the tenant, and a different `tenant_id` is refused.

Responses: `200` means every event was written or already present. `422`
means some events were refused; `results[i]` gives the error, the refusal is in
`ledger_dead_letters`, and the other events were still written. `401` is a bad
signature or stale timestamp, `503` is a producer with no secret configured,
and `400` / `413` are a malformed or oversized body. **Keep and retry anything
that was not a 200.** Re-sending is always safe.
