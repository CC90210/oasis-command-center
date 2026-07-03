"use client";

/**
 * CCContacts — the Contacts & Lists section. Inner sub-tabs for the full contact
 * data model: Contacts (search/CRUD/engagement), Lists, Tags, Custom fields, and
 * Segments (with a condition builder). Each sub-view talks to its own
 * /api/campaigns/constant-contact/* route.
 */

import { useState } from "react";
import { CCContactsTab } from "./CCContactsTab";
import { CCListsTab } from "./CCListsTab";
import { CCTagsTab } from "./CCTagsTab";
import { CCFieldsTab } from "./CCFieldsTab";
import { CCSegmentsTab } from "./CCSegmentsTab";

type Sub = "contacts" | "lists" | "tags" | "fields" | "segments";
const SUBS: { key: Sub; label: string }[] = [
  { key: "contacts", label: "Contacts" },
  { key: "lists", label: "Lists" },
  { key: "tags", label: "Tags" },
  { key: "fields", label: "Custom fields" },
  { key: "segments", label: "Segments" },
];

export function CCContacts() {
  const [sub, setSub] = useState<Sub>("contacts");
  return (
    <div className="space-y-4">
      <div className="inline-flex flex-wrap gap-1.5">
        {SUBS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSub(s.key)}
            className={`rounded-full border px-2.5 py-1 text-[11px] ${sub === s.key ? "border-accent/40 bg-accent/10 text-accent" : "border-bg-border text-fg-muted hover:text-fg"}`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {sub === "contacts" && <CCContactsTab />}
      {sub === "lists" && <CCListsTab />}
      {sub === "tags" && <CCTagsTab />}
      {sub === "fields" && <CCFieldsTab />}
      {sub === "segments" && <CCSegmentsTab />}
    </div>
  );
}
