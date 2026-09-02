import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createClient, type Client } from '@libsql/client';

import { createTursoPostgrest } from '../lib/turso-postgrest';

/**
 * `.contains()` on the Turso shim, tested by RUNNING the query.
 *
 * Asserting on generated SQL would have passed for the broken version too — it
 * produced perfectly valid SQL that simply never matched. The only assertion
 * that catches a false negative is "did the row come back", so every case here
 * seeds a real row and reads it back.
 *
 * Both failures below were live on 2026-09-02:
 *   - an opener lost every lead at handoff, because the collaborator read
 *     passed JSON.stringify([id]) and matched nothing;
 *   - lead timelines rendered empty, because object containment was compiled
 *     as array-element matching.
 */

async function seeded(): Promise<{ db: Client; pg: ReturnType<typeof createTursoPostgrest> }> {
  const db = createClient({ url: ':memory:' });
  await db.execute(`CREATE TABLE tenant_records (
      id TEXT PRIMARY KEY, tenant_id TEXT, entity_type TEXT,
      data TEXT, created_at TEXT, updated_at TEXT)`);
  await db.execute(`CREATE TABLE agent_events (id TEXT PRIMARY KEY, payload TEXT)`);
  await db.execute({
    sql: `INSERT INTO tenant_records (id, tenant_id, entity_type, data)
          VALUES ('rec_1','ten_1','lead',?)`,
    args: [JSON.stringify({ name: 'O Salon', collaborators: ['user-a', 'user-b'] })],
  });
  await db.execute({
    sql: `INSERT INTO agent_events (id, payload) VALUES ('evt_1',?), ('evt_2',?)`,
    args: [
      JSON.stringify({ lead_id: 'led_1', kind: 'email_sent' }),
      JSON.stringify({ lead_id: 'led_2', kind: 'email_sent' }),
    ],
  });
  return { db, pg: createTursoPostgrest(db) };
}

describe('turso shim: contains', () => {
  it('matches an array element passed as a real array', async () => {
    const { pg } = await seeded();
    const r = await pg.from('tenant_records').select('id').contains('data->collaborators', ['user-a']);
    assert.equal(r.error, null);
    assert.equal(r.data?.length, 1, 'the collaborator row must come back');
  });

  it('matches when the array arrives JSON-stringified — the live regression', async () => {
    // This exact call shape emptied every opener's board. It must work, because
    // PostgREST's wire format is a string and callers legitimately send one.
    const { pg } = await seeded();
    const r = await pg
      .from('tenant_records')
      .select('id')
      .contains('data->collaborators', JSON.stringify(['user-a']));
    assert.equal(r.error, null);
    assert.equal(r.data?.length, 1, 'a stringified array must not read as one opaque scalar');
  });

  it('does not match a collaborator who is not on the row', async () => {
    const { pg } = await seeded();
    const r = await pg.from('tenant_records').select('id').contains('data->collaborators', ['user-z']);
    assert.equal(r.data?.length, 0, 'containment must still be exclusive');
  });

  it('requires EVERY element of a multi-value array', async () => {
    const { pg } = await seeded();
    const both = await pg.from('tenant_records').select('id').contains('data->collaborators', ['user-a', 'user-b']);
    assert.equal(both.data?.length, 1);
    const one = await pg.from('tenant_records').select('id').contains('data->collaborators', ['user-a', 'user-z']);
    assert.equal(one.data?.length, 0, 'containment is AND, not OR');
  });

  it('matches object containment on a JSON path — the timeline regression', async () => {
    // json_extract found 74 events for a real lead where this returned 0.
    const { pg } = await seeded();
    const r = await pg.from('agent_events').select('id').contains('payload', { lead_id: 'led_1' });
    assert.equal(r.error, null);
    assert.equal(r.data?.length, 1, 'timeline events must be findable by payload key');
    assert.equal(String(r.data?.[0]?.id), 'evt_1', 'and it must be the RIGHT event');
  });

  it('requires every key of a multi-key object', async () => {
    const { pg } = await seeded();
    const hit = await pg.from('agent_events').select('id')
      .contains('payload', { lead_id: 'led_1', kind: 'email_sent' });
    assert.equal(hit.data?.length, 1);
    const miss = await pg.from('agent_events').select('id')
      .contains('payload', { lead_id: 'led_1', kind: 'sms_sent' });
    assert.equal(miss.data?.length, 0, 'a wrong value on any key must exclude the row');
  });

  it('matches a JSON null, and tells it apart from a missing key', async () => {
    // `json_extract(col,'$.k') = ?` with a bound NULL is never true — NULL =
    // NULL is NULL — so a null filter would match nothing while looking like a
    // filter that ran: the same silent false negative this file exists for.
    // json_type also separates a PRESENT null from an ABSENT key, which
    // equality cannot express at all.
    const { db, pg } = await seeded();
    await db.execute({
      sql: `INSERT INTO agent_events (id, payload) VALUES ('evt_null',?), ('evt_absent',?)`,
      args: [JSON.stringify({ lead_id: null }), JSON.stringify({ kind: 'no_lead_key' })],
    });

    const hit = await pg.from('agent_events').select('id').contains('payload', { lead_id: null });
    assert.equal(hit.error, null);
    assert.equal(hit.data?.length, 1, 'a present JSON null must match');
    assert.equal(String(hit.data?.[0]?.id), 'evt_null');

    // The row with no lead_id at all must NOT be swept in by the null filter.
    const ids = (hit.data ?? []).map((r) => String(r.id));
    assert.ok(!ids.includes('evt_absent'), 'a missing key is not a null value');
  });

  it('throws on an unsafe key instead of interpolating it', async () => {
    // Keys become a JSON path inside the SQL text, so they cannot be bound as
    // parameters. It THROWS rather than returning an empty result, and that
    // distinction is the point of this whole change: a refused query must not
    // look like a query that found nothing.
    const { pg } = await seeded();
    assert.throws(
      () => pg.from('agent_events').select('id').contains('payload', { "lead_id') = '' OR 1=1 --": 'x' }),
      /unsafe contains key/,
    );
  });

  it('throws on a value shape it cannot express', async () => {
    // The regression this file exists for was a SILENT false negative. Anything
    // the compiler cannot represent must fail loudly instead of compiling to a
    // query that matches nothing.
    const { pg } = await seeded();
    assert.throws(
      () => pg.from('agent_events').select('id').contains('payload', (() => undefined) as unknown as string),
      /unsupported contains value/,
    );
  });
});
