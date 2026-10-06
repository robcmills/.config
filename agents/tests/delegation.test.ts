import { describe, expect, test } from "bun:test";
import {
  applyCorrections, correctedDelegateCounts, planReconciliation, reconcileDelegations, wouldCycle,
} from "../src/delegation.ts";
import type { Agent, DelegateChild } from "../src/types.ts";
import { agent } from "./fixtures.ts";

const parent = (children: DelegateChild[], overrides: Partial<Agent> = {}) => agent({
  key: "10:1", nvimPid: 10, outputBufnr: 1, socketPath: "/nvim.10", sessionId: "P", children, ...overrides,
});
const entry = (overrides: Partial<DelegateChild> = {}): DelegateChild => ({
  key: "20:5", sessionId: "C", state: "working", nvimPid: 20, uid: "u1", ...overrides,
});
const child = (overrides: Partial<Agent> = {}) => agent({
  key: "20:5", nvimPid: 20, outputBufnr: 5, socketPath: "/nvim.20", sessionId: "C", state: "working",
  delegator: { key: "10:1", sessionId: "P", socket: "/nvim.10", bufnr: 1 }, ...overrides,
});
const alive = () => true;

describe("planReconciliation", () => {
  test("agreeing parent and child need nothing", () => {
    expect(planReconciliation({ agents: [parent([entry()]), child()], answered: new Set([10, 20]), alive })).toEqual([]);
  });

  test("a stale cached state asks the child to push again", () => {
    const plan = planReconciliation({ agents: [parent([entry()]), child({ state: "ready" })], answered: new Set([10, 20]), alive });
    expect(plan.map((c) => [c.kind, c.key])).toEqual([["repush", "20:5"]]);
  });

  test("a lost registration asks the child to push", () => {
    const plan = planReconciliation({ agents: [parent([]), child()], answered: new Set([10, 20]), alive });
    expect(plan.map((c) => [c.kind, c.key])).toEqual([["repush", "20:5"]]);
  });

  test("prunes a child whose Neovim answered without it, or whose Neovim is dead", () => {
    const answeredPlan = planReconciliation({ agents: [parent([entry()])], answered: new Set([10, 20]), alive });
    expect(answeredPlan).toMatchObject([{ kind: "prune", key: "10:1", child: "20:5", uid: "u1" }]);
    const deadPlan = planReconciliation({ agents: [parent([entry()])], answered: new Set([10]), alive: () => false });
    expect(deadPlan).toMatchObject([{ kind: "prune", child: "20:5" }]);
  });

  test("never prunes a child whose Neovim is wedged but alive", () => {
    expect(planReconciliation({ agents: [parent([entry()])], answered: new Set([10]), alive })).toEqual([]);
  });

  test("a reused buffer number is not the linked child", () => {
    const plan = planReconciliation({
      agents: [parent([entry()]), child({ sessionId: "other", delegator: null })], answered: new Set([10, 20]), alive,
    });
    expect(plan).toMatchObject([{ kind: "prune", child: "20:5" }]);
  });

  test("rebinds an orphan to its parent's session in a restarted Neovim", () => {
    const moved = parent([], { key: "11:3", nvimPid: 11, outputBufnr: 3, socketPath: "/nvim.11" });
    const plan = planReconciliation({ agents: [moved, child()], answered: new Set([11, 20]), alive });
    expect(plan).toMatchObject([{
      kind: "rebind", key: "20:5", delegator: { key: "11:3", socket: "/nvim.11", bufnr: 3, session_id: "P" },
    }]);
  });

  test("leaves an orphan alone when its parent session is nowhere or ambiguous", () => {
    expect(planReconciliation({ agents: [child()], answered: new Set([20]), alive })).toEqual([]);
    const twice = [parent([], { key: "11:3" }), parent([], { key: "12:3" }), child()];
    expect(planReconciliation({ agents: twice, answered: new Set([11, 12, 20]), alive })).toEqual([]);
  });
});

describe("corrected counts", () => {
  test("follow the children's real states and drop pruned entries", () => {
    const agents = [parent([entry(), entry({ key: "30:1", nvimPid: 30, uid: "u2" })]), child({ state: "ready" })];
    const plan = planReconciliation({ agents, answered: new Set([10, 20, 30]), alive });
    expect(correctedDelegateCounts(agents, plan).get("10:1")).toBe(0);
  });

  test("keep an unverifiable child's cached state", () => {
    const agents = [parent([entry()])];
    expect(correctedDelegateCounts(agents, []).get("10:1")).toBe(1);
  });

  test("an idle-looking parent with a busy child shows delegating", async () => {
    const agents = [parent([], { state: "unread" }), child()];
    const repushed: string[] = [];
    const warnings = await reconcileDelegations(agents, new Set([10, 20]), {
      alive, repush: async (socket) => { repushed.push(socket); return { ok: true }; },
    });
    expect(warnings).toEqual([]);
    expect(repushed).toEqual(["/nvim.20"]);
    expect(agents[0]!.state).toBe("delegating");
    expect(agents[0]!.delegateCount).toBe(1);
  });

  test("an inventory without links makes no RPCs", async () => {
    const agents = [agent()];
    expect(await reconcileDelegations(agents, new Set([100]), { repush: async () => { throw new Error("no"); } })).toEqual([]);
  });
});

test("failed corrections become warnings", async () => {
  const warnings = await applyCorrections(
    [{ kind: "prune", socket: "/s", bufnr: 1, key: "10:1", child: "20:5", uid: null, reason: "gone" }],
    { prune: async () => ({ ok: false, error: "timed out" }) },
  );
  expect(warnings).toEqual(["delegation prune for 10:1 failed (gone): timed out"]);
});

test("cycles and self-links are detected through the delegator chain", () => {
  const a = agent({ key: "1:1", delegator: null });
  const b = agent({ key: "1:2", delegator: { key: "1:1", sessionId: null, socket: null, bufnr: 1 } });
  const c = agent({ key: "1:3", delegator: { key: "1:2", sessionId: null, socket: null, bufnr: 2 } });
  expect(wouldCycle([a, b, c], "1:3", "1:1")).toBe(true);
  expect(wouldCycle([a, b, c], "1:1", "1:1")).toBe(true);
  expect(wouldCycle([a, b, c], "1:1", "1:3")).toBe(false);
});
