import {
  installForwarder, registerCcDelegate, uninstallForwarder, unregisterCcDelegate,
} from "./cc-rpc.ts";
import type { ChildRef } from "./cc-rpc.ts";
import type { Agent, AgentState, ForwarderRecord, ParentRef } from "./types.ts";

/**
 * Child states that keep a parent `delegating`. A child that is itself
 * delegating counts, so nesting composes.
 */
export const DELEGATE_BUSY_STATES: ReadonlySet<AgentState> = new Set([
  "starting", "working", "waiting", "interrupting", "monitoring", "delegating",
]);

/** States a parent shows below `delegating` in cc.nvim's precedence. */
const BELOW_DELEGATING: ReadonlySet<AgentState> = new Set(["monitoring", "unread", "starting", "ready"]);

export function parentRefOf(agent: Agent): ParentRef {
  return { key: agent.key, socket: agent.socketPath, bufnr: agent.outputBufnr, sessionId: agent.sessionId };
}

export function childRefOf(agent: Agent): ChildRef {
  return {
    key: agent.key, socket: agent.socketPath, bufnr: agent.outputBufnr,
    nvimPid: agent.nvimPid, sessionId: agent.sessionId, state: agent.state,
  };
}

/** Both known and different. An unknown session id (still starting) matches anything. */
function sessionsDiffer(left: string | null | undefined, right: string | null | undefined): boolean {
  return !!left && !!right && left !== right;
}

/**
 * Fill each agent's `delegator`: the parent its forwarder points at, else a
 * parent whose children list it.
 */
export function deriveDelegators(agents: Agent[], forwarders: ForwarderRecord[]): void {
  const byKey = new Map(agents.map((agent) => [agent.key, agent] as const));
  for (const agent of agents) agent.delegator = null;
  for (const record of forwarders) {
    const child = byKey.get(record.childKey);
    if (child && !child.delegator) child.delegator = record.parent;
  }
  for (const parent of agents) {
    for (const entry of parent.children) {
      const child = byKey.get(entry.key);
      if (child && !child.delegator) child.delegator = parentRefOf(parent);
    }
  }
}

/**
 * True when linking `childKey` under `parentKey` would make an agent its own
 * ancestor. Walks up from the parent through each agent's delegator.
 */
export function wouldCycle(agents: Agent[], parentKey: string, childKey: string): boolean {
  const byKey = new Map(agents.map((agent) => [agent.key, agent] as const));
  const seen = new Set<string>();
  for (let key: string | undefined = parentKey; key !== undefined && !seen.has(key); key = byKey.get(key)?.delegator?.key) {
    if (key === childKey) return true;
    seen.add(key);
  }
  return false;
}

export interface LinkDependencies {
  register?: typeof registerCcDelegate;
  unregister?: typeof unregisterCcDelegate;
  install?: typeof installForwarder;
  uninstall?: typeof uninstallForwarder;
}

/**
 * Register `child` with `parent` in the parent's Neovim, then install the
 * forwarder in the child's, which pushes the child's current state once.
 * Registering first means that push lands. Returns warnings: a link that
 * could not be made is reported, never silently dropped.
 */
export async function linkChild(parent: ParentRef, child: ChildRef, dependencies: LinkDependencies = {}): Promise<string[]> {
  const untracked = (why: string) => `${child.key} is not tracked as a child of ${parent.key}: ${why}`;
  const registered = await (dependencies.register ?? registerCcDelegate)(parent.socket, parent.bufnr, child);
  if (!registered.ok) return [untracked(registered.error || "register failed")];
  const installed = await (dependencies.install ?? installForwarder)(child.socket, child.bufnr, child.key, parent);
  if (installed.ok) return [];
  await (dependencies.unregister ?? unregisterCcDelegate)(parent.socket, parent.bufnr, child.key);
  return [untracked(installed.error || "forwarder install failed")];
}

export type Correction =
  | { kind: "register"; parent: ParentRef; child: ChildRef; reason: string }
  | { kind: "unregister"; parent: ParentRef; childKey: string; reason: string }
  | { kind: "install"; parent: ParentRef; child: ChildRef; reason: string }
  | { kind: "uninstall"; socket: string; childBufnr: number; childKey: string; parentKey: string; reason: string };

export interface ReconcileInput {
  agents: Agent[];
  forwarders: ForwarderRecord[];
  /** Neovim pids whose inventory RPC answered, so a missing buffer there is real. */
  answered: ReadonlySet<number>;
  /** False only when the pid is known dead. */
  alive: (pid: number) => boolean;
}

function nvimPidOfKey(key: string): number | null {
  const pid = Number(key.split(":")[0]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Compare each parent's children with the children's own snapshots and the
 * forwarders installed in their Neovims, and list the RPCs that repair the
 * difference. Prunes only on positive evidence: a dead Neovim pid, or a
 * Neovim that answered without the child. A wedged Neovim proves nothing.
 */
export function planReconciliation({ agents, forwarders, answered, alive }: ReconcileInput): Correction[] {
  const byKey = new Map(agents.map((agent) => [agent.key, agent] as const));
  const corrections = new Map<string, Correction>();
  const add = (id: string, correction: Correction) => {
    if (!corrections.has(id)) corrections.set(id, correction);
  };
  const forwarderTo = (child: Agent, parentKey: string) => forwarders.some((record) =>
    record.nvimPid === child.nvimPid && record.childBufnr === child.outputBufnr && record.parent.key === parentKey);

  for (const parent of agents) {
    const ref = parentRefOf(parent);
    for (const entry of parent.children) {
      const child = byKey.get(entry.key);
      const prune = (reason: string) => add(`unregister:${parent.key}>${entry.key}`, { kind: "unregister", parent: ref, childKey: entry.key, reason });
      if (!child) {
        const pid = entry.nvimPid ?? nvimPidOfKey(entry.key);
        if (pid !== null && answered.has(pid)) prune(`${entry.key} is gone from its Neovim`);
        else if (pid !== null && !alive(pid)) prune(`${entry.key}'s Neovim ${pid} is dead`);
        continue;
      }
      if (sessionsDiffer(entry.sessionId, child.sessionId)) {
        prune(`${entry.key} now holds another session`);
        continue;
      }
      if (!forwarderTo(child, parent.key)) {
        add(`install:${child.key}>${parent.key}`, { kind: "install", parent: ref, child: childRefOf(child), reason: `${child.key} has no forwarder to ${parent.key}` });
      } else if (child.state !== entry.state) {
        add(`install:${child.key}>${parent.key}`, { kind: "install", parent: ref, child: childRefOf(child), reason: `${parent.key} has ${entry.key} as ${entry.state}, it is ${child.state}` });
      }
    }
  }

  for (const record of forwarders) {
    const child = byKey.get(record.childKey);
    const remove = (reason: string) => add(`uninstall:${record.name}@${record.nvimPid}`, {
      kind: "uninstall", socket: record.socketPath, childBufnr: record.childBufnr, childKey: record.childKey, parentKey: record.parent.key, reason,
    });
    if (!child) {
      remove(`${record.childKey} is gone`);
      continue;
    }
    const parent = byKey.get(record.parent.key);
    if (parent && !sessionsDiffer(parent.sessionId, record.parent.sessionId)) {
      if (!parent.children.some((entry) => entry.key === child.key)) {
        const ref = parentRefOf(parent);
        add(`register:${parent.key}>${child.key}`, { kind: "register", parent: ref, child: childRefOf(child), reason: `${parent.key} does not list ${child.key}` });
        add(`install:${child.key}>${parent.key}`, { kind: "install", parent: ref, child: childRefOf(child), reason: `push ${child.key}'s state to ${parent.key}` });
      }
      continue;
    }
    if (parent) continue;
    // The parent's Neovim is gone or wedged. If its session lives on in a
    // restarted Neovim, rebuild the link there from this registry entry.
    if (!record.parent.sessionId) continue;
    const candidates = agents.filter((agent) => agent.sessionId === record.parent.sessionId && agent.key !== child.key);
    if (candidates.length !== 1) continue;
    const target = candidates[0]!;
    if (wouldCycle(agents, target.key, child.key)) continue;
    const ref = parentRefOf(target);
    const reason = `${record.parent.key} is gone; session ${record.parent.sessionId} is now ${target.key}`;
    add(`register:${target.key}>${child.key}`, { kind: "register", parent: ref, child: childRefOf(child), reason });
    // Installing to the new parent replaces the stale forwarder (one parent per child).
    add(`install:${child.key}>${target.key}`, { kind: "install", parent: ref, child: childRefOf(child), reason });
  }
  return [...corrections.values()];
}

/**
 * The parent's busy-child count as the inventory sees it: a child's real
 * state when it is visible, the parent's cached state when it cannot be
 * checked, and nothing for an entry the plan prunes. A child whose
 * forwarder points at the parent but whose registration was lost counts too.
 */
export function correctedDelegateCounts(agents: Agent[], forwarders: ForwarderRecord[], corrections: Correction[]): Map<string, number> {
  const byKey = new Map(agents.map((agent) => [agent.key, agent] as const));
  const pruned = new Set(corrections.flatMap((c) => c.kind === "unregister" ? [`${c.parent.key}>${c.childKey}`] : []));
  const counts = new Map<string, number>();
  for (const parent of agents) {
    const counted = new Set<string>();
    let count = 0;
    for (const entry of parent.children) {
      counted.add(entry.key);
      if (pruned.has(`${parent.key}>${entry.key}`)) continue;
      const state = byKey.get(entry.key)?.state ?? entry.state;
      if (DELEGATE_BUSY_STATES.has(state)) count += 1;
    }
    for (const record of forwarders) {
      if (record.parent.key !== parent.key || counted.has(record.childKey)) continue;
      if (sessionsDiffer(record.parent.sessionId, parent.sessionId)) continue;
      const child = byKey.get(record.childKey);
      counted.add(record.childKey);
      if (child && DELEGATE_BUSY_STATES.has(child.state)) count += 1;
    }
    counts.set(parent.key, count);
  }
  return counts;
}

/**
 * Apply corrected counts to the inventory rows: `delegateCount` follows the
 * children's real states, and an idle-looking parent with a busy child shows
 * `delegating`. Never lowers a parent out of `delegating`; the repair RPCs
 * fix that in cc.nvim and the next inventory reads it.
 */
export function applyCorrectedCounts(agents: Agent[], counts: Map<string, number>): void {
  for (const agent of agents) {
    const count = counts.get(agent.key);
    if (count === undefined) continue;
    agent.delegateCount = count;
    if (count > 0 && BELOW_DELEGATING.has(agent.state)) agent.state = "delegating";
  }
}

/**
 * Send every correction. Registrations and removals go first, then forwarder
 * installs, so each install's push reaches a registered entry. Returns a
 * warning for each that failed.
 */
export async function applyCorrections(corrections: Correction[], dependencies: LinkDependencies = {}): Promise<string[]> {
  const run = async (correction: Correction) => {
    const result = correction.kind === "register"
      ? await (dependencies.register ?? registerCcDelegate)(correction.parent.socket, correction.parent.bufnr, correction.child)
      : correction.kind === "unregister"
        ? await (dependencies.unregister ?? unregisterCcDelegate)(correction.parent.socket, correction.parent.bufnr, correction.childKey)
        : correction.kind === "install"
          ? await (dependencies.install ?? installForwarder)(correction.child.socket, correction.child.bufnr, correction.child.key, correction.parent)
          : await (dependencies.uninstall ?? uninstallForwarder)(correction.socket, correction.childBufnr, correction.parentKey);
    const target = correction.kind === "uninstall" ? correction.childKey : correction.kind === "unregister" ? correction.parent.key : correction.kind === "register" ? correction.parent.key : correction.child.key;
    return result.ok ? null : `delegation ${correction.kind} for ${target} failed (${correction.reason}): ${result.error || "unknown error"}`;
  };
  const first = await Promise.all(corrections.filter((c) => c.kind !== "install").map(run));
  const second = await Promise.all(corrections.filter((c) => c.kind === "install").map(run));
  return [...first, ...second].filter((warning): warning is string => warning !== null);
}

/** `kill -0`: false only when the process is known not to exist. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Derive delegators, plan and send repairs, and fold corrected counts into `agents`. Returns warnings. */
export async function reconcileDelegations(
  agents: Agent[],
  forwarders: ForwarderRecord[],
  answered: ReadonlySet<number>,
  dependencies: LinkDependencies & { alive?: (pid: number) => boolean } = {},
): Promise<string[]> {
  deriveDelegators(agents, forwarders);
  if (forwarders.length === 0 && !agents.some((agent) => agent.children.length > 0)) return [];
  const corrections = planReconciliation({ agents, forwarders, answered, alive: dependencies.alive ?? processAlive });
  const counts = correctedDelegateCounts(agents, forwarders, corrections);
  const warnings = corrections.length ? await applyCorrections(corrections, dependencies) : [];
  applyCorrectedCounts(agents, counts);
  return warnings;
}
