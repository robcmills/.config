import { describe, expect, test } from "bun:test";
import {
  closeCcInstance,
  getCcLastAssistantMessage,
  luaCallExpression,
  openCcInstance,
  sendCcPrompt,
} from "../src/cc-rpc.ts";
import type { CommandResult, CommandRunner } from "../src/types.ts";

function recorder(reply: Partial<CommandResult> | ((args: string[]) => Partial<CommandResult>)) {
  const calls: string[][] = [];
  const run: CommandRunner = async (args) => {
    calls.push(args);
    const partial = typeof reply === "function" ? reply(args) : reply;
    return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...partial };
  };
  return { calls, run };
}

/** Recover the JSON handed to `_A` from a luaeval expression. */
function argumentJson(expression: string): unknown {
  const match = expression.match(/^luaeval\("(.*)", '(.*)'\)$/s);
  if (!match) throw new Error(`not a luaeval expression: ${expression}`);
  return JSON.parse(match[2]!.replaceAll("''", "'"));
}

describe("luaCallExpression", () => {
  test("passes the argument as JSON in a Vimscript single-quoted string", () => {
    const expression = luaCallExpression("return _A", { text: "it's \"quoted\"\nline2 \\ back" });
    expect(expression.startsWith(`luaeval("return _A", '`)).toBe(true);
    expect(argumentJson(expression)).toEqual({ text: "it's \"quoted\"\nline2 \\ back" });
    // Nothing from the argument leaks into the Lua source.
    expect(expression.match(/^luaeval\("(.*?)", '/)![1]).toBe("return _A");
  });

  test("refuses Lua that would break out of the Vimscript double-quoted string", () => {
    expect(() => luaCallExpression('print("x")', {})).toThrow();
    expect(() => luaCallExpression("print('a\\nb')", {})).toThrow();
  });
});

describe("open", () => {
  test("sends only defined options and returns bufnr and pid", async () => {
    const { calls, run } = recorder({ stdout: JSON.stringify({ bufnr: 12, pid: 4242 }) + "\n" });
    const result = await openCcInstance("/sock", { cwd: "/x", prompt: "hi", model: undefined, focus: false }, 100, run);
    expect(result).toEqual({ ok: true, bufnr: 12, pid: 4242 });
    expect(calls[0]!.slice(0, 4)).toEqual(["nvim", "--server", "/sock", "--remote-expr"]);
    expect(argumentJson(calls[0]![4]!)).toEqual({ cwd: "/x", prompt: "hi", focus: false });
    expect(calls[0]![4]).toContain("vim.json.decode(a)");
    expect(calls[0]![4]).toContain("cc.open");
  });

  test("surfaces Lua-side errors and malformed replies", async () => {
    const err = recorder({ stdout: JSON.stringify({ err: "invalid effort" }) });
    expect(await openCcInstance("/sock", { cwd: "/x" }, 100, err.run)).toEqual({ ok: false, error: "invalid effort" });
    const bad = recorder({ stdout: JSON.stringify({ bufnr: "nope", pid: 1 }) });
    expect((await openCcInstance("/sock", { cwd: "/x" }, 100, bad.run)).ok).toBe(false);
    const timeout = recorder({ timedOut: true });
    expect((await openCcInstance("/sock", { cwd: "/x" }, 100, timeout.run)).error).toContain("timed out");
    const failed = recorder({ exitCode: 1, stderr: "E5108: Error executing lua boom\nmore" });
    expect((await openCcInstance("/sock", { cwd: "/x" }, 100, failed.run)).error).toBe("E5108: Error executing lua boom");
  });
});

describe("send_prompt", () => {
  test("passes bufnr and text through _A", async () => {
    const { calls, run } = recorder({ stdout: JSON.stringify({ ok: true }) });
    expect(await sendCcPrompt("/sock", 7, "do the 'thing'\nplease", 100, run)).toEqual({ ok: true });
    expect(argumentJson(calls[0]![4]!)).toEqual({ bufnr: 7, text: "do the 'thing'\nplease" });
    expect(calls[0]![4]).toContain("cc.send_prompt");
  });

  test("validates locally before any RPC", async () => {
    const { calls, run } = recorder({ stdout: JSON.stringify({ ok: true }) });
    expect((await sendCcPrompt("/sock", 0, "x", 100, run)).ok).toBe(false);
    expect((await sendCcPrompt("/sock", 7, "   ", 100, run)).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("reports the guard error from cc.nvim", async () => {
    const { run } = recorder({ stdout: JSON.stringify({ err: "instance is busy" }) });
    expect(await sendCcPrompt("/sock", 7, "x", 100, run)).toEqual({ ok: false, error: "instance is busy" });
  });
});

describe("get_last_assistant_message", () => {
  test("returns the decoded text", async () => {
    const { calls, run } = recorder({ stdout: JSON.stringify({ text: "line 1\nline 2" }) });
    expect(await getCcLastAssistantMessage("/sock", 7, 100, run)).toEqual({ text: "line 1\nline 2" });
    expect(argumentJson(calls[0]![4]!)).toEqual({ bufnr: 7 });
    expect(calls[0]![4]).toContain("cc.get_last_assistant_message");
  });

  test("propagates a missing message as an error", async () => {
    const { run } = recorder({ stdout: JSON.stringify({ err: "no assistant message yet" }) });
    expect(await getCcLastAssistantMessage("/sock", 7, 100, run)).toEqual({ text: null, error: "no assistant message yet" });
  });
});

describe("close", () => {
  test("targets the given buffer and checks the API accepts a target", async () => {
    const { calls, run } = recorder({ stdout: JSON.stringify({ ok: true }) });
    expect(await closeCcInstance("/sock", 7, 100, run)).toEqual({ ok: true });
    expect(argumentJson(calls[0]![4]!)).toEqual({ bufnr: 7 });
    expect(calls[0]![4]).toContain("nparams < 1");
  });

  test("refuses an old close() that ignores its argument", async () => {
    const { run } = recorder({ stdout: JSON.stringify({ err: "cc.nvim agents API unavailable; update cc.nvim and restart Neovim" }) });
    expect((await closeCcInstance("/sock", 7, 100, run)).error).toContain("API unavailable");
  });
});
