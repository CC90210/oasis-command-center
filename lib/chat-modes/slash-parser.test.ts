/**
 * Slash-command parser unit tests.
 *
 * Pure functions, no IO — fast to run, easy to keep green.
 * Designed to catch regressions if anyone tweaks the parser
 * regex or the command list.
 */
import { describe, expect, test } from "vitest";
import {
  ALL_COMMANDS,
  isKnownCommand,
  parseInput,
  renderHelp,
} from "./slash-parser";

describe("parseInput — known commands", () => {
  test("bare /clear", () => {
    expect(parseInput("/clear")).toEqual({
      kind: "command",
      name: "clear",
      args: "",
      raw: "/clear",
    });
  });

  test("/agent atlas — args carried through", () => {
    const r = parseInput("/agent atlas");
    expect(r.kind).toBe("command");
    if (r.kind === "command") {
      expect(r.name).toBe("agent");
      expect(r.args).toBe("atlas");
    }
  });

  test("/model with multi-word arg keeps the rest of the first line", () => {
    const r = parseInput("/model claude-sonnet-4-6 priority=high");
    expect(r.kind).toBe("command");
    if (r.kind === "command") {
      expect(r.name).toBe("model");
      expect(r.args).toBe("claude-sonnet-4-6 priority=high");
    }
  });

  test("case-insensitive command match", () => {
    const r = parseInput("/HELP");
    expect(r.kind).toBe("command");
    if (r.kind === "command") expect(r.name).toBe("help");
  });

  test("leading whitespace is tolerated", () => {
    const r = parseInput("   /plan");
    expect(r.kind).toBe("command");
    if (r.kind === "command") expect(r.name).toBe("plan");
  });

  test("/compact with multi-line hint folds extra lines into args", () => {
    const r = parseInput("/compact\nfocus on revenue this week");
    expect(r.kind).toBe("command");
    if (r.kind === "command") {
      expect(r.name).toBe("compact");
      expect(r.args).toBe("focus on revenue this week");
    }
  });
});

describe("parseInput — falls through as message", () => {
  test("normal message", () => {
    expect(parseInput("hello world")).toEqual({
      kind: "message",
      text: "hello world",
    });
  });

  test("unknown slash command is treated as a message", () => {
    // Important: don't silently drop. /foo is just text to the model.
    const r = parseInput("/foo bar");
    expect(r.kind).toBe("message");
    if (r.kind === "message") expect(r.text).toBe("/foo bar");
  });

  test("path-looking input is NOT a command", () => {
    // A user discussing a file path with the agent.
    const r = parseInput("/path/to/file.ts");
    expect(r.kind).toBe("message");
  });

  test("slash with space is NOT a command", () => {
    // "/ plan" has a space — not a slash command.
    const r = parseInput("/ plan");
    expect(r.kind).toBe("message");
  });

  test("multi-line message starting with text", () => {
    const r = parseInput("look at this:\n/clear is what I'd usually type");
    expect(r.kind).toBe("message");
  });
});

describe("isKnownCommand", () => {
  test("known commands pass", () => {
    for (const cmd of ALL_COMMANDS) {
      expect(isKnownCommand(cmd)).toBe(true);
    }
  });
  test("unknown commands fail", () => {
    expect(isKnownCommand("foo")).toBe(false);
    expect(isKnownCommand("Build")).toBe(false); // case-sensitive at this layer
  });
});

describe("renderHelp", () => {
  test("includes every command", () => {
    const help = renderHelp();
    for (const cmd of ALL_COMMANDS) {
      expect(help).toContain(`/${cmd}`);
    }
  });

  test("starts with a heading line", () => {
    const help = renderHelp();
    expect(help.split("\n")[0]).toMatch(/Slash commands/i);
  });
});
