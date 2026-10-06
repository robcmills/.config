import { expect, test } from "bun:test";
import { ancestorsOf, findCallers, resolveCaller } from "../src/caller.ts";
import { agent } from "./fixtures.ts";

// 50 → 40 (bash) → 30 (claude, agent A) → 20 (nvim) → 1
const parents = new Map([[50, 40], [40, 30], [30, 20], [20, 1]]);

test("ancestry is nearest first and stops before pid 1", () => {
  expect(ancestorsOf(50, parents)).toEqual([50, 40, 30, 20]);
  expect(ancestorsOf(50, new Map([[50, 60], [60, 50]]))).toEqual([50, 60]);
});

test("an ancestor agent wins, then CLAUDE_PID, then the session id", () => {
  const a = agent({ key: "20:1", pid: 30 });
  const b = agent({ key: "20:2", pid: 31, sessionId: "sb" });
  const c = agent({ key: "20:3", pid: 32, sessionId: "sc" });
  const env = { CLAUDE_PID: "31", CLAUDE_CODE_SESSION_ID: "sc" };
  expect(findCallers([c, b, a], { self: 50, parents, env }).map((x) => x.key)).toEqual(["20:1", "20:2", "20:3"]);
  expect(resolveCaller([c, b], { self: 50, parents, env })?.key).toBe("20:2");
});

test("a plain shell resolves no caller", () => {
  expect(resolveCaller([agent({ pid: 99 })], { self: 50, parents, env: {} })).toBeNull();
  expect(resolveCaller([agent({ pid: null, sessionId: null })], { self: 50, parents, env: { CLAUDE_PID: "" } })).toBeNull();
});
