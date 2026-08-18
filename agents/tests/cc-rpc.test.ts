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

test("cc inventory tolerates pre-lastModified snapshots during rolling restarts", async () => {
  const run: CommandRunner = async () => ({
    stdout: JSON.stringify([{ outputBufnr: 1, promptBufnr: 2, sessionId: null, name: null, provider: "codex", model: null, cwd: "/x", pid: 3, state: "starting", turnElapsedMs: null }]),
    stderr: "", exitCode: 0, timedOut: false,
  });
  expect((await queryCcInstances("/socket", 100, run)).snapshots?.[0]?.lastModifiedAt).toBeNull();
  expect((await queryCcInstances("/socket", 100, run)).snapshots?.[0]?.backgroundTaskCount).toBe(0);
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
