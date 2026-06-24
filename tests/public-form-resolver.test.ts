import assert from "node:assert/strict";
import { resolvePublicForm } from "../lib/forms/public-resolver";

type Row = Record<string, unknown>;
type TableName = "tenants" | "forms";

const tenants: Row[] = [
  {
    id: "tenant-sunbiz",
    slug: "submissions",
    logo_url: "https://example.com/sunbiz.png",
    custom_fields: { command_center_profile_slug: "sun" },
  },
];

const forms: Row[] = [
  {
    id: "form-full",
    tenant_id: "tenant-sunbiz",
    slug: "full-application",
    name: "SunBiz Funding",
    branding: {},
    steps: [],
    on_complete_stage: "signed_application",
    step_outcomes: {},
    enabled: true,
    redirect_url: null,
  },
  {
    id: "form-disabled",
    tenant_id: "tenant-sunbiz",
    slug: "disabled",
    name: "Disabled",
    branding: {},
    steps: [],
    on_complete_stage: null,
    step_outcomes: {},
    enabled: false,
    redirect_url: null,
  },
];

class FakeQuery {
  private filters: Array<[string, unknown]> = [];

  constructor(private table: TableName) {}

  select() {
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push([column, value]);
    return this;
  }

  async maybeSingle() {
    const rows = this.table === "tenants" ? tenants : forms;
    const data = rows.find((row) =>
      this.filters.every(([column, value]) => {
        if (column === "custom_fields->>command_center_profile_slug") {
          return (row.custom_fields as Row | undefined)?.command_center_profile_slug === value;
        }
        return row[column] === value;
      }),
    );
    return { data: data ?? null, error: null };
  }
}

const db = {
  from(table: TableName) {
    return new FakeQuery(table);
  },
};

async function run() {
  const canonical = await resolvePublicForm(db as never, "submissions", "full-application");
  assert.equal(canonical.ok, true, "canonical tenant slug resolves");
  if (canonical.ok) {
    assert.equal(canonical.tenant_slug, "submissions");
    assert.equal(canonical.form.id, "form-full");
  }

  const alias = await resolvePublicForm(db as never, "sun", "full-application");
  assert.equal(alias.ok, true, "SunBiz public profile slug resolves as an alias");
  if (alias.ok) {
    assert.equal(alias.tenant_slug, "submissions", "alias returns the canonical signed-token tenant slug");
    assert.equal(alias.form.id, "form-full");
  }

  const disabled = await resolvePublicForm(db as never, "sun", "disabled");
  assert.deepEqual(disabled, { ok: false, reason: "not_found" }, "disabled forms stay hidden through alias");

  const missing = await resolvePublicForm(db as never, "sun", "missing");
  assert.deepEqual(missing, { ok: false, reason: "not_found" }, "missing forms stay hidden through alias");

  console.log("public-form-resolver ok");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
