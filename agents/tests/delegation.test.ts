import { describe, expect, test } from "bun:test";
import {
  applyCorrections, correctedDelegateCounts, deriveDelegators, linkChild, planReconciliation,
  reconcileDelegations, wouldCycle,
} from "../src/delegation.ts";
import type { Agent, DelegateChild, ForwarderRecord } from "../src/types.ts";
import { agent } from "./fixtures.ts";

const parent = (children: DelegateChild[], overrides: Partial<Agent> = {}) => agent({
  key: "10:1", nvimPid: 10, outputBufnr: 1, socketPath: "/nvim.10", sessionId: "P", children, ...overrides,
});
const entry = (overrides: Partial<DelegateChild> = {}): DelegateChild => ({
  key: "20:5", sessionId: "C", state: "working", nvimPid: 20, ...overrides,
});
const child = (overrides: Partial<Agent> = {}) => agent({
  key: "20:5", nvimPid: 20, outputBufnr: 5, socketPath: "/nvim.20", sessionId: "C", state: "working", ...overrides,
});
const forwarder = (overrides: Partial<ForwarderRecord> = {}): ForwarderRecord => ({
  name: "f", childKey: "20:5", childBufnr: 5, nvimPid: 20, socketPath: "/nvim.20",
  parent: { key: "10:1", socket: "/nvim.10", bufnr: 1, sessionId: "P" }, ...overrides,
});
const alive = () => true;
const plan = (agents: Agent[], forwarders: ForwarderRecord[], answered: number[], isAlive = alive) =>
  planReconciliation({ agents, forwarders, answered: new Set(answered), alive: isAlive })
    .map((c) => [c.kind, c.kind === "uninstall" ? c.childKey : c.kind === "unregister" ? c.childKey : c.child.key, c.kind === "uninstall" ? c.parentKey : c.parent.key]);

describe("planReconciliation", () => {
  test("agreeing parent, child, and forwarder need nothing", () => {
    expect(plan([parent([entry()]), child()], [forwarder()], [10, 20])).toEqual([]);
  });

  test("a stale cached state re-runs the forwarder install, which pushes", () => {
    expect(plan([parent([entry()]), child({ state: "ready" })], [forwarder()], [10, 20])).toEqual([["install", "20:5", "10:1"]]);
  });

  test("a missing forwarder is reinstalled", () => {
    expect(plan([parent([entry()]), child()], [], [10, 20])).toEqual([["install", "20:5", "10:1"]]);
  });

  test("a lost registration is registered again from the forwarder", () => {
    expect(plan([parent([]), child()], [forwarder()], [10, 20])).toEqual([["register", "20:5", "10:1"], ["install", "20:5", "10:1"]]);
  });

  test("prunes a child whose Neovim answered without it (a close on old cc.nvim) or is dead", () => {
    expect(plan([parent([entry()])], [], [10, 20])).toEqual([["unregister", "20:5", "10:1"]]);
    expect(plan([parent([entry()])], [], [10], () => false)).toEqual([["unregister", "20:5", "10:1"]]);
  });

  test("never prunes a child whose Neovim is wedged but alive", () => {
    expect(plan([parent([entry()])], [], [10])).toEqual([]);
  });

  test("removes a forwarder whose child is gone", () => {
    expect(plan([parent([])], [forwarder()], [10, 20])).toEqual([["uninstall", "20:5", "10:1"]]);
  });

  test("rebuilds a restarted parent's map from the child's registry by session id", () => {
    const moved = parent([], { key: "11:3", nvimPid: 11, outputBufnr: 3, socketPath: "/nvim.11" });
    expect(plan([moved, child()], [forwarder()], [11, 20])).toEqual([["register", "20:5", "11:3"], ["install", "20:5", "11:3"]]);
  });

  test("leaves an orphan alone when its parent session is nowhere or ambiguous", () => {
    expect(plan([child()], [forwarder()], [20])).toEqual([]);
    const twice = [parent([], { key: "11:3" }), parent([], { key: "12:3" }), child()];
    expect(plan(twice, [forwarder()], [11, 12, 20])).toEqual([]);
  });
});

describe("counts and delegators", () => {
  test("counts follow the children's real states and drop pruned entries", () => {
    const agents = [parent([entry(), entry({ key: "30:1", nvimPid: 30 })]), child({ state: "ready" })];
    const corrections = planReconciliation({ agents, forwarders: [forwarder()], answered: new Set([10, 20, 30]), alive });
    expect(correctedDelegateCounts(agents, [forwarder()], corrections).get("10:1")).toBe(0);
  });

  test("an unverifiable child keeps its cached state", () => {
    expect(correctedDelegateCounts([parent([entry()])], [], []).get("10:1")).toBe(1);
  });

  test("a child with a forwarder but no registration still counts", () => {
    expect(correctedDelegateCounts([parent([]), child()], [forwarder()], []).get("10:1")).toBe(1);
  });

  test("delegator comes from the forwarder, else from a parent's children", () => {
    const agents = [parent([entry()]), child(), agent({ key: "40:1", nvimPid: 40 })];
    deriveDelegators(agents, []);
    expect(agents[1]!.delegator).toEqual({ key: "10:1", socket: "/nvim.10", bufnr: 1, sessionId: "P" });
    const moved = { ...forwarder().parent, key: "11:3" };
    deriveDelegators(agents, [forwarder({ parent: moved })]);
    expect(agents[1]!.delegator?.key).toBe("11:3");
    expect(agents[2]!.delegator).toBeNull();
  });

  test("an idle-looking parent with a busy child shows delegating", async () => {
    const agents = [parent([], { state: "unread" }), child()];
    const calls: string[] = [];
    const warnings = await reconcileDelegations(agents, [forwarder()], new Set([10, 20]), {
      alive,
      register: async (socket) => { calls.push(`register ${socket}`); return { ok: true }; },
      install: async (socket) => { calls.push(`install ${socket}`); return { ok: true }; },
    });
    expect(warnings).toEqual([]);
    expect(calls).toEqual(["register /nvim.10", "install /nvim.20"]);
    expect(agents[0]!.state).toBe("delegating");
    expect(agents[0]!.delegateCount).toBe(1);
  });

  test("a restarted parent is relinked and the returned delegator is the new one", async () => {
    // Session P moved from Neovim 10 (dead) to 11:3; the child still forwards to 10:1.
    const moved = parent([], { key: "11:3", nvimPid: 11, outputBufnr: 3, socketPath: "/nvim.11", state: "ready" });
    const agents = [moved, child()];
    const ok = async () => ({ ok: true });
    expect(await reconcileDelegations(agents, [forwarder()], new Set([11, 20]), { alive, register: ok, install: ok })).toEqual([]);
    expect(agents[0]!.state).toBe("delegating");
    expect(agents[1]!.delegator?.key).toBe("11:3");
  });

  test("a failed relink leaves the delegator as found", async () => {
    const moved = parent([], { key: "11:3", nvimPid: 11, outputBufnr: 3, socketPath: "/nvim.11" });
    const agents = [moved, child()];
    const warnings = await reconcileDelegations(agents, [forwarder()], new Set([11, 20]), {
      alive, register: async () => ({ ok: true }), install: async () => ({ ok: false, error: "boom" }),
    });
    expect(warnings).toHaveLength(1);
    expect(agents[1]!.delegator?.key).toBe("10:1");
  });

  test("a pruned registration no longer names the parent as delegator", async () => {
    const agents = [parent([entry({ sessionId: "OLD" })]), child()];
    await reconcileDelegations(agents, [], new Set([10, 20]), { alive, unregister: async () => ({ ok: true }) });
    expect(agents[1]!.delegator).toBeNull();
  });

  test("an inventory without links makes no RPCs", async () => {
    const agents = [agent()];
    expect(await reconcileDelegations(agents, [], new Set([100]), { install: async () => { throw new Error("no"); } })).toEqual([]);
    expect(agents[0]!.delegator).toBeNull();
  });
});

describe("linkChild", () => {
  const p = { key: "10:1", socket: "/nvim.10", bufnr: 1, sessionId: "P" };
  const c = { key: "20:5", socket: "/nvim.20", bufnr: 5, nvimPid: 20, sessionId: null, state: "starting" as const };

  test("registers in the parent before installing the forwarder", async () => {
    const calls: string[] = [];
    const warnings = await linkChild(p, c, {
      register: async () => { calls.push("register"); return { ok: true }; },
      install: async () => { calls.push("install"); return { ok: true }; },
    });
    expect(warnings).toEqual([]);
    expect(calls).toEqual(["register", "install"]);
  });

  test("a parent without the receiver or a child without CcStateChanged is a warning", async () => {
    const noReceiver = await linkChild(p, c, { register: async () => ({ ok: false, error: "the parent cc.nvim has no delegation receiver" }) });
    expect(noReceiver).toEqual(["20:5 is not tracked as a child of 10:1: the parent cc.nvim has no delegation receiver"]);
    let unregistered = false;
    const noEvent = await linkChild(p, c, {
      register: async () => ({ ok: true }),
      install: async () => ({ ok: false, error: "the child's cc.nvim has no CcStateChanged event" }),
      unregister: async () => { unregistered = true; return { ok: true }; },
    });
    expect(noEvent).toEqual(["20:5 is not tracked as a child of 10:1: the child's cc.nvim has no CcStateChanged event"]);
    expect(unregistered).toBe(true);
  });
});

test("failed corrections become warnings", async () => {
  const warnings = await applyCorrections(
    [{ kind: "unregister", parent: { key: "10:1", socket: "/s", bufnr: 1, sessionId: null }, childKey: "20:5", reason: "gone" }],
    { unregister: async () => ({ ok: false, error: "timed out" }) },
  );
  expect(warnings).toEqual(["delegation unregister for 10:1 failed (gone): timed out"]);
});

test("cycles and self-links are detected through the delegator chain", () => {
  const ref = (key: string) => ({ key, socket: "/s", bufnr: 1, sessionId: null });
  const a = agent({ key: "1:1", delegator: null });
  const b = agent({ key: "1:2", delegator: ref("1:1") });
  const c = agent({ key: "1:3", delegator: ref("1:2") });
  expect(wouldCycle([a, b, c], "1:3", "1:1")).toBe(true);
  expect(wouldCycle([a, b, c], "1:1", "1:1")).toBe(true);
  expect(wouldCycle([a, b, c], "1:1", "1:3")).toBe(false);
});
