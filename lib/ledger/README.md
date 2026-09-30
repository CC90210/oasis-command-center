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

1. **Rows are never edited or deleted.** Triggers abort UPDATE and DELETE, and
   turn an `INSERT OR REPLACE` / `REPLACE INTO` on a stored id or key into a
   no-op (SQLite runs no DELETE trigger for a REPLACE's delete). A correction
   is a new event with a `causation_id`. The only delete is
   `purgeTenantLedger` for a tenant listed in `lib/tenant/retired.ts`.
2. **One writer per event key.** The catalog names the one module that may emit
   a key natively, and `emit` refuses any other `producer` for it.
   `tests/ledger-core.test.ts` also fails when a module that imports
   `lib/ledger/emit` names a key it does not own. Python harnesses never write
   these tables; they POST to the ingest route, and only for keys whose
   `producers` list names them. A key with more than one writer (the app and a
   harness, or several harnesses) must declare `writers`: one idempotency-key
   pattern per writer, enforced on every emit. Either both writers build the
   same key from the provider's own id (`msg:{provider}:{id}`, so a send both
   of them see lands once), or each owns a disjoint slice (`form:` is the
   app's lead capture, `email:` / `ig:` / `import:` are BEA's).
3. **Same batch as the business write.** `emit` never runs anything itself. Put
   its statement in the batch that makes the change, so both commit or neither
   does. After a compare-and-swap, use `emitIfChanged`, which inserts only when
   the statement just before it changed exactly one row. See `eventWithLedger`
   in `lib/os/approvals/store.ts`.
4. **Idempotent, loudly.** `UNIQUE(tenant_id, idempotency_key)` with
   `ON CONFLICT DO NOTHING`. When a key can come from outside (a provider id),
   call `assertNoPayloadConflicts(db, batch)` after the batch: the same key with
   a different fact throws, and the first row stands. The fact
   (`FACT_COLUMNS` in `emit.ts`) is the key, version, `occurred_at`, subject,
   join keys, department, actor, approval / routine run / touch ids, value and
   payload. Source, `source_ref`, confidence, traces and the server's own id
   and time describe the recording, not the fact, and are left out.
5. **Tenant from the subject, never a default.** `tenantId` is required. There
   is no fallback to OASIS.
6. **Ids and codes only.** A payload field is an id, a code, an integer, a
   boolean or a time. Undeclared fields are refused. An id cannot hold `@`,
   `+` or whitespace, so an email, an E.164 phone or a sentence is refused, and
   it cannot be a phone number in any other shape (`5145550199`,
   `514-555-0199`), a postal code or a Title-case name pair (`Jean.Tremblay`).
   A provider id that is a bare 10-digit number goes in namespaced
   (`tg:5165125484`). Names and message bodies stay in entity tables.
7. **Two clocks.** `occurred_at` is the source's time. `recorded_at` is the
   server's time. Every timestamp carries its zone (`Z` or `+hh:mm`); a naive
   one is refused, never read in the server's local time.
8. **A backfill is `inferred`.** Anything reconstructed after the fact says so.
9. **Amounts are never negative.** The key says which way money moved:
   `refund.issued`, not a negative `payment.received`.

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

The signature covers the raw bytes as sent, so any JSON spacing works
(`json.dumps` defaults included); sign exactly the bytes you send.
`occurred_at` and every time field need a zone:
`datetime.now(timezone.utc).isoformat()`, never `datetime.utcnow().isoformat()`.

An event uses the column names: `event_key`, `event_version`, `occurred_at`,
`subject: {type, id}`, `contact_id` / `deal_id` / `customer_id`, `actor:
{type, id}`, `source`, `source_ref`, `idempotency_key`, `confidence`, `payload`,
optional `value_cents` + `currency`, optional trace ids, and optional
`producer_ref` (the script path). Send `tenant_id` only when the subject is not
a lead, contact, deal, customer or approval. For those, the subject's own row
sets the tenant, and a different `tenant_id` is refused. The department is the
catalog's (a different `department_key` is refused), and a harness may not
record an event as a human's (`actor.type: "human"`) or as `human_confirmed`:
a person's own action reaches the ledger through the app that signed them in.

Responses: `200` means every event was written or already present. `422`
means some events were refused; `results[i]` gives the error, the refusal is in
`ledger_dead_letters`, and the other events were still written. `401` is a bad
signature or stale timestamp, `503` is a producer with no secret configured,
and `400` / `413` are a malformed or oversized body. **Keep and retry anything
that was not a 200.** Re-sending is always safe.
