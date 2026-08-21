import { afterEach, describe, expect, test } from "bun:test";
import {
  emptyInventoryWarningNotification,
  focusAndSwitch,
  notifyTmux,
  switchTmux,
} from "../src/switch.ts";
import type { CommandRunner } from "../src/types.ts";
import { agent } from "./fixtures.ts";

const originalTmux = process.env.TMUX;
afterEach(() => {
  if (originalTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = originalTmux;
});

describe("tmux switching", () => {
  test("requires a tmux client and reports resolved target IDs", async () => {
    delete process.env.TMUX;
    expect(switchTmux(agent())).rejects.toThrow("session=$1 window=@2 pane=%3");
  });

  test("switches stable session, window, then pane IDs", async () => {
    process.env.TMUX = "/tmp/tmux";
    const calls: string[][] = [];
    const run: CommandRunner = async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    await switchTmux(agent(), run);
    expect(calls).toEqual([
      ["tmux", "switch-client", "-t", "$1"],
      ["tmux", "select-window", "-t", "@2"],
      ["tmux", "select-pane", "-t", "%3"],
    ]);
  });

  test("shows a durable tmux notification without leaking command output", async () => {
    process.env.TMUX = "/tmp/tmux";
    const calls: Array<{ args: string[]; timeout?: number }> = [];
    const run: CommandRunner = async (args, timeout) => {
      calls.push({ args, timeout });
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    expect(await notifyTmux("agents: warning", 8_000, run)).toBe(true);
    expect(calls).toEqual([{
      args: ["tmux", "display-message", "-d", "8000", "agents: warning"],
      timeout: 1_500,
    }]);
  });

  test("skips tmux notification outside tmux", async () => {
    delete process.env.TMUX;
    let called = false;
    expect(await notifyTmux("agents: warning", 8_000, async () => {
      called = true;
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    })).toBe(false);
    expect(called).toBe(false);
  });
});

test("empty inventory warnings include the diagnostic command", () => {
  expect(emptyInventoryWarningNotification(3)).toBe(
    "agents: no switchable agents · 3 warnings · run 'agents doctor'",
  );
});

test("focus happens before tmux and partial success is explicit", async () => {
  const calls: string[] = [];
  await expect(focusAndSwitch(agent(), {
    focus: async () => { calls.push("focus"); return { ok: true }; },
    switchTmux: async () => { calls.push("tmux"); throw new Error("missing pane"); },
  })).rejects.toThrow("cc.nvim focused 100:7, but tmux switching failed");
  expect(calls).toEqual(["focus", "tmux"]);
});
