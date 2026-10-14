"use client";

import { useState } from "react";
import { ActionButton } from "./ActionButton";
import { ActionForm } from "./ActionForm";
import { quietButton } from "./ui";

type Customer = {
  id: string;
  name: string;
  email: string;
  company: string;
  address: string;
  archived: number;
};

export function CustomersManager({ entity, contacts }: { entity: string; contacts: Customer[] }) {
  const active = contacts.filter((customer) => customer.archived === 0);
  const archived = contacts.filter((customer) => customer.archived === 1);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <section className="space-y-2" aria-labelledby="active-customers-heading">
        <h3 id="active-customers-heading" className="text-xs font-bold uppercase tracking-[0.12em] text-fg-muted">
          Active ({active.length})
        </h3>
        {active.length === 0 && <p className="text-sm text-fg-muted">No active customers yet.</p>}
        <div className="divide-y divide-bg-border/60">
          {active.map((customer) => {
            const editing = editingId === customer.id;
            const editId = `customer-edit-${customer.id}`;
            return (
              <div key={customer.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 text-sm">
                    <div className="font-semibold text-fg">{customer.name}</div>
                    <div className="truncate text-fg-muted">{customer.email || "no billing email"}{customer.company ? ` · ${customer.company}` : ""}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={quietButton}
                      aria-label={`Edit ${customer.name}`}
                      aria-expanded={editing}
                      aria-controls={editId}
                      onClick={() => setEditingId(editing ? null : customer.id)}
                    >
                      {editing ? "Close" : "Edit"}
                    </button>
                    <ActionButton
                      action="contact.archive"
                      payload={{ contact_id: customer.id }}
                      label="Archive"
                      ariaLabel={`Archive ${customer.name}`}
                      confirm={`Archive ${customer.name}? This removes the customer from new-invoice choices while preserving existing invoices and Stripe linkage.`}
                    />
                  </div>
                </div>
                {editing && (
                  <div id={editId} className="mt-3 rounded-md border border-bg-border bg-bg-deep p-3">
                    <ActionForm
                      action="contact.update"
                      hidden={{ contact_id: customer.id }}
                      submitLabel="Save customer"
                      resetOnSuccess={false}
                      columns={2}
                      fields={[
                        { name: "name", label: "Name", required: true, defaultValue: customer.name },
                        { name: "email", label: "Billing email", type: "email", defaultValue: customer.email },
                        { name: "company", label: "Company", defaultValue: customer.company },
                        { name: "address", label: "Address", defaultValue: customer.address, span: 2 },
                      ]}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="space-y-3 border-t border-bg-border pt-4" aria-labelledby="add-customer-heading">
        <h3 id="add-customer-heading" className="text-xs font-bold uppercase tracking-[0.12em] text-fg-muted">Add customer</h3>
        <ActionForm
          action="contact.create"
          hidden={{ entity, kind: "customer" }}
          submitLabel="Add customer"
          columns={2}
          fields={[
            { name: "name", label: "Name", required: true },
            { name: "email", label: "Billing email", type: "email" },
            { name: "company", label: "Company" },
            { name: "address", label: "Address", span: 2 },
          ]}
        />
      </section>

      <details className="border-t border-bg-border pt-4">
        <summary className="cursor-pointer text-xs font-bold uppercase tracking-[0.12em] text-fg-muted">Archived ({archived.length})</summary>
        <div className="mt-2 divide-y divide-bg-border/60">
          {archived.length === 0 && <p className="py-2 text-sm text-fg-muted">No archived customers.</p>}
          {archived.map((customer) => (
            <div key={customer.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <div className="min-w-0">
                <div className="font-semibold text-fg">{customer.name}</div>
                <div className="truncate text-fg-muted">{customer.email || "no billing email"}</div>
              </div>
              <ActionButton
                action="contact.restore"
                payload={{ contact_id: customer.id }}
                label="Restore"
                ariaLabel={`Restore ${customer.name}`}
              />
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
