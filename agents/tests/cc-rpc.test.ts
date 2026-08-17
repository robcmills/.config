import { expect, test } from "bun:test";
import { focusCcInstance, queryCcInstances } from "../src/cc-rpc.ts";
import type { CommandRunner } from "../src/types.ts";

test("cc inventory parses a valid snapshot", async () => {
  const run: CommandRunner = async () => ({
    stdout: JSON.stringify([{ outputBufnr: 1, promptBufnr: 2, sessionId: null, name: null, provider: "codex", model: null, cwd: "/x", pid: 3, state: "starting", turnElapsedMs: null }]),
    stderr: "", exitCode: 0, timedOut: false,
  });
  expect((await queryCcInstances("/socket", 100, run)).snapshots?.[0]?.state).toBe("starting");
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
