import { expect, test } from "bun:test";
import { focusCcInstance, queryCcInstances } from "../src/cc-rpc.ts";
import type { CommandRunner } from "../src/types.ts";

test("cc inventory parses a valid snapshot", async () => {
  const run: CommandRunner = async () => ({
    stdout: JSON.stringify([{ outputBufnr: 1, promptBufnr: 2, sessionId: null, name: null, provider: "codex", model: null, cwd: "/x", pid: 3, state: "monitoring", turnElapsedMs: null, backgroundTaskCount: 2, lastModifiedAt: 1_700_000_000_000 }]),
    stderr: "", exitCode: 0, timedOut: false,
  });
  const snapshot = (await queryCcInstances("/socket", 100, run)).snapshots?.[0];
  expect(snapshot?.state).toBe("monitoring");
  expect(snapshot?.backgroundTaskCount).toBe(2);
});

test("cc inventory accepts an unread snapshot", async () => {
  const run: CommandRunner = async () => ({
    stdout: JSON.stringify([{ outputBufnr: 1, promptBufnr: 2, sessionId: null, name: null, provider: "codex", model: null, cwd: "/x", pid: 3, state: "unread", turnElapsedMs: null, backgroundTaskCount: 0, lastModifiedAt: 1_700_000_000_000 }]),
    stderr: "", exitCode: 0, timedOut: false,
  });
  const result = await queryCcInstances("/socket", 100, run);
  expect(result.error).toBeUndefined();
  expect(result.snapshots).toHaveLength(1);
  expect(result.snapshots?.[0]?.state).toBe("unread");
});

test("cc inventory tolerates pre-lastModified snapshots during rolling restarts", async () => {
  const run: CommandRunner = async () => ({
    stdout: JSON.stringify([{ outputBufnr: 1, promptBufnr: 2, sessionId: null, name: null, provider: "codex", model: null, cwd: "/x", pid: 3, state: "starting", turnElapsedMs: null }]),
    stderr: "", exitCode: 0, timedOut: false,
  });
  expect((await queryCcInstances("/socket", 100, run)).snapshots?.[0]?.lastModifiedAt).toBeNull();
  expect((await queryCcInstances("/socket", 100, run)).snapshots?.[0]?.backgroundTaskCount).toBe(0);
});

test("cc inventory reads snapshots and forwarders, and normalizes the link fields", async () => {
  const base = { outputBufnr: 1, promptBufnr: 2, sessionId: "s", name: null, provider: "claude", model: null, cwd: "/x", pid: 3, turnElapsedMs: null };
  const run: CommandRunner = async () => ({
    stdout: JSON.stringify({
      instances: [
        { ...base, state: "delegating", delegateCount: 2,
          children: [{ key: "9:1", sessionId: "c", state: "working", nvimPid: 9 }, { key: "9:2", state: "bogus" }] },
        // An empty Lua table encodes as {}, and older cc.nvim omits the fields.
        { ...base, outputBufnr: 3, state: "ready", children: {} },
      ],
      forwarders: [
        { name: "f", childBufnr: 3, childKey: "7:3", parent: { key: "8:1", socket: "/s", bufnr: 1, session_id: "p" } },
        { name: "broken" },
      ],
    }),
    stderr: "", exitCode: 0, timedOut: false,
  });
  const result = await queryCcInstances("/socket", 100, run);
  expect(result.error).toBeUndefined();
  const [first, second] = result.snapshots!;
  expect(first?.state).toBe("delegating");
  expect(first?.delegateCount).toBe(2);
  expect(first?.children).toEqual([{ key: "9:1", sessionId: "c", state: "working", nvimPid: 9 }]);
  expect(second?.delegateCount).toBe(0);
  expect(second?.children).toEqual([]);
  expect(result.forwarders).toEqual([{ name: "f", childBufnr: 3, childKey: "7:3", parent: { key: "8:1", socket: "/s", bufnr: 1, sessionId: "p" } }]);
});

test("cc inventory accepts the bare array a Neovim without cc.nvim returns", async () => {
  const run: CommandRunner = async () => ({ stdout: "[]", stderr: "", exitCode: 0, timedOut: false });
  expect(await queryCcInstances("/socket", 100, run)).toEqual({ forwarders: [], snapshots: [] });
});

test("focus validates the numeric buffer before constructing RPC arguments", async () => {
  let called = false;
  const run: CommandRunner = async () => {
    called = true;
    return { stdout: "1\n", stderr: "", exitCode: 0, timedOut: false };
  };
  expect((await focusCcInstance("/socket", 1.5, 100, run)).ok).toBe(false);
  expect(called).toBe(false);
  expect((await focusCcInstance("/socket", 42, 100, run)).ok).toBe(true);
});
