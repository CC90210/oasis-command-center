import { describe, expect, test } from "vitest";
import {
  composeSystemPrompt,
  filterToolsForMode,
  normalizeMode,
  PLAN_MODE_PROMPT_OVERLAY,
  PLAN_MODE_TOOL_ALLOWLIST,
} from "./plan-mode";

const SAMPLE_TOOLS = [
  // Reads — should survive plan mode
  { name: "list_records" },
  { name: "get_record" },
  { name: "search_records" },
  { name: "http_get" },
  { name: "read_file" },
  { name: "list_skills" },
  // Writes — should be filtered out in plan mode
  { name: "create_record" },
  { name: "update_record" },
  { name: "delete_record" },
  { name: "write_file" },
  { name: "bash" },
  { name: "send_email" },
  { name: "send_sms" },
  { name: "http_post" },
  { name: "run_script" },
];

describe("filterToolsForMode", () => {
  test("build mode returns the full list unchanged", () => {
    const out = filterToolsForMode(SAMPLE_TOOLS, "build");
    expect(out).toEqual(SAMPLE_TOOLS);
  });

  test("plan mode strips write tools", () => {
    const out = filterToolsForMode(SAMPLE_TOOLS, "plan");
    const names = out.map((t) => t.name);
    // Reads kept
    expect(names).toContain("list_records");
    expect(names).toContain("read_file");
    expect(names).toContain("http_get");
    // Writes gone
    expect(names).not.toContain("create_record");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("send_email");
    expect(names).not.toContain("http_post");
  });

  test("plan mode allowlist is a STRICT subset of the input tool names", () => {
    const out = filterToolsForMode(SAMPLE_TOOLS, "plan");
    for (const tool of out) {
      expect(PLAN_MODE_TOOL_ALLOWLIST.has(tool.name)).toBe(true);
    }
  });

  test("unknown tool in plan mode is filtered out (default-deny)", () => {
    const out = filterToolsForMode([{ name: "future_brand_new_tool" }], "plan");
    expect(out).toEqual([]);
  });

  test("filter returns a new array, not the same reference (safe to mutate)", () => {
    const tools = [{ name: "list_records" }];
    const out = filterToolsForMode(tools, "build");
    expect(out).not.toBe(tools);
    expect(out).toEqual(tools);
  });
});

describe("composeSystemPrompt", () => {
  test("build mode returns base prompt unchanged", () => {
    expect(composeSystemPrompt("You are Bravo.", "build")).toBe("You are Bravo.");
  });

  test("plan mode appends the plan overlay", () => {
    const out = composeSystemPrompt("You are Bravo.", "plan");
    expect(out.startsWith("You are Bravo.")).toBe(true);
    expect(out).toContain("PLAN MODE ACTIVE");
    expect(out).toContain("/build");
    expect(out).toContain(PLAN_MODE_PROMPT_OVERLAY);
  });

  test("plan overlay explicitly prohibits the dangerous primitives", () => {
    expect(PLAN_MODE_PROMPT_OVERLAY).toMatch(/Write or edit any file/i);
    expect(PLAN_MODE_PROMPT_OVERLAY).toMatch(/shell command/i);
    expect(PLAN_MODE_PROMPT_OVERLAY).toMatch(/email or SMS/i);
    // The "escape plan mode" guard — critical to preserving the contract.
    expect(PLAN_MODE_PROMPT_OVERLAY).toMatch(/do NOT escape plan mode/i);
  });
});

describe("normalizeMode", () => {
  test("\"plan\" → plan", () => {
    expect(normalizeMode("plan")).toBe("plan");
  });
  test("\"build\" → build", () => {
    expect(normalizeMode("build")).toBe("build");
  });
  test("anything else collapses to build (fail-open)", () => {
    expect(normalizeMode("foo")).toBe("build");
    expect(normalizeMode(null)).toBe("build");
    expect(normalizeMode(undefined)).toBe("build");
    expect(normalizeMode(42)).toBe("build");
  });
});
