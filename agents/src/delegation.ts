import { pruneCcDelegate, rebindCcInstance, repushCcInstance } from "./cc-rpc.ts";
import type { CcDelegator } from "./cc-rpc.ts";
import type { Agent, AgentState, DelegateChild } from "./types.ts";

/**
 * Child states that keep a parent `delegating`. A child that is itself
 * delegating counts, so nesting composes.
 */
export const DELEGATE_BUSY_STATES: ReadonlySet<AgentState> = new Set([
  "starting", "working", "waiting", "interrupting", "monitoring", "delegating",
]);

/** States a parent shows below `delegating` in cc.nvim's precedence. */
const BELOW_DELEGATING: ReadonlySet<AgentState> = new Set(["monitoring", "unread", "starting", "ready"]);

export function toDelegator(agent: Agent): CcDelegator {
  return { key: agent.key, socket: agent.socketPath, bufnr: agent.outputBufnr, session_id: agent.sessionId };
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

export type Correction =
  | { kind: "repush"; socket: string; bufnr: number; key: string; reason: string }
  | { kind: "prune"; socket: string; bufnr: number; key: string; child: string; uid: string | null; reason: string }
  | { kind: "rebind"; socket: string; bufnr: number; key: string; delegator: CcDelegator; reason: string };

/** Both known and different. An unknown session id (still starting) matches anything. */
function sessionsDiffer(left: string | null | undefined, right: string | null | undefined): boolean {
  return !!left && !!right && left !== right;
}

function nvimPidOf(child: DelegateChild): number | null {
  if (child.nvimPid !== null) return child.nvimPid;
  const pid = Number(child.key.split(":")[0]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** Is `child` (a live agent) the incarnation `entry` records, linked to `parent`? */
function linkedTo(child: Agent, parent: Agent, entry: DelegateChild): boolean {
  return child.delegator?.key === parent.key
    && !sessionsDiffer(child.delegator.sessionId, parent.sessionId)
    && !sessionsDiffer(child.sessionId, entry.sessionId);
}

export interface ReconcileInput {
  agents: Agent[];
  /** Neovim pids whose inventory RPC answered, so a missing buffer there is real. */
  answered: ReadonlySet<number>;
  /** False only when the pid is known dead. */
  alive: (pid: number) => boolean;
}

/**
 * Compare each parent's cached children with the children's own snapshots and
 * list the RPCs that repair the difference. Prunes only on positive evidence:
 * a dead Neovim pid, a Neovim that answered without that child, or a live
 * agent at that key that is not this link. A wedged Neovim proves nothing.
 */
export function planReconciliation({ agents, answered, alive }: ReconcileInput): Correction[] {
  const byKey = new Map(agents.map((agent) => [agent.key, agent] as const));
  const corrections = new Map<string, Correction>();
  const add = (correction: Correction) => {
    const id = correction.kind === "prune" ? `prune:${correction.key}:${correction.child}` : `${correction.kind}:${correction.key}`;
    if (!corrections.has(id)) corrections.set(id, correction);
  };
  const repush = (child: Agent, reason: string) => add({ kind: "repush", socket: child.socketPath, bufnr: child.outputBufnr, key: child.key, reason });

  for (const parent of agents) {
    for (const entry of parent.children) {
      const child = byKey.get(entry.key);
      const prune = (reason: string) => add({
        kind: "prune", socket: parent.socketPath, bufnr: parent.outputBufnr, key: parent.key, child: entry.key, uid: entry.uid, reason,
      });
      if (!child) {
        const pid = nvimPidOf(entry);
        if (pid !== null && answered.has(pid)) prune(`${entry.key} is gone from its Neovim`);
        else if (pid !== null && !alive(pid)) prune(`${entry.key}'s Neovim ${pid} is dead`);
        continue;
      }
      if (!linkedTo(child, parent, entry)) {
        prune(`${entry.key} is no longer linked to ${parent.key}`);
        if (child.delegator?.key === parent.key) repush(child, `${child.key} replaced an older link at the same key`);
        continue;
      }
      if (child.state !== entry.state) repush(child, `${parent.key} has ${entry.key} as ${entry.state}, it is ${child.state}`);
    }
  }

  for (const child of agents) {
    const ref = child.delegator;
    if (!ref) continue;
    const parent = byKey.get(ref.key);
    if (parent && !sessionsDiffer(parent.sessionId, ref.sessionId)) {
      if (!parent.children.some((entry) => entry.key === child.key)) repush(child, `${parent.key} does not list ${child.key}`);
      continue;
    }
    // The parent's address is stale. If its session lives on elsewhere (a
    // restarted Neovim resumed it), point the child there.
    if (!ref.sessionId) continue;
    const candidates = agents.filter((agent) => agent.sessionId === ref.sessionId && agent.key !== child.key);
    if (candidates.length !== 1) continue;
    const target = candidates[0]!;
    if (wouldCycle(agents, target.key, child.key)) continue;
    add({ kind: "rebind", socket: child.socketPath, bufnr: child.outputBufnr, key: child.key, delegator: toDelegator(target), reason: `${ref.key} is gone; session ${ref.sessionId} is now ${target.key}` });
  }
  return [...corrections.values()];
}

/**
 * The parent's busy-child count as the inventory sees it: a child's real
 * state when it is visible and still linked, the parent's cached state when
 * it cannot be checked, and nothing for an entry the plan prunes.
 */
export function correctedDelegateCounts(agents: Agent[], corrections: Correction[]): Map<string, number> {
  const byKey = new Map(agents.map((agent) => [agent.key, agent] as const));
  const pruned = new Set(corrections.flatMap((c) => c.kind === "prune" ? [`${c.key}>${c.child}`] : []));
  const counts = new Map<string, number>();
  for (const parent of agents) {
    const counted = new Set<string>();
    let count = 0;
    for (const entry of parent.children) {
      counted.add(entry.key);
      if (pruned.has(`${parent.key}>${entry.key}`)) continue;
      const child = byKey.get(entry.key);
      const state = child && linkedTo(child, parent, entry) ? child.state : entry.state;
      if (DELEGATE_BUSY_STATES.has(state)) count += 1;
    }
    // A child whose registration push was lost still counts.
    for (const child of agents) {
      if (child.delegator?.key !== parent.key || counted.has(child.key)) continue;
      if (sessionsDiffer(child.delegator.sessionId, parent.sessionId)) continue;
      if (DELEGATE_BUSY_STATES.has(child.state)) count += 1;
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

export interface ReconcileDependencies {
  repush?: typeof repushCcInstance;
  prune?: typeof pruneCcDelegate;
  rebind?: typeof rebindCcInstance;
}

/** Send every correction at once. Returns a warning for each that failed. */
export async function applyCorrections(
  corrections: Correction[],
  dependencies: ReconcileDependencies = {},
): Promise<string[]> {
  const results = await Promise.all(corrections.map(async (correction) => {
    const result = correction.kind === "repush"
      ? await (dependencies.repush ?? repushCcInstance)(correction.socket, correction.bufnr)
      : correction.kind === "prune"
        ? await (dependencies.prune ?? pruneCcDelegate)(correction.socket, correction.bufnr, correction.child, correction.uid)
        : await (dependencies.rebind ?? rebindCcInstance)(correction.socket, correction.bufnr, correction.delegator);
    return result.ok ? null : `delegation ${correction.kind} for ${correction.key} failed (${correction.reason}): ${result.error || "unknown error"}`;
  }));
  return results.filter((warning): warning is string => warning !== null);
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

/** Plan, send, and fold the corrected counts into `agents`. Returns warnings. */
export async function reconcileDelegations(
  agents: Agent[],
  answered: ReadonlySet<number>,
  dependencies: ReconcileDependencies & { alive?: (pid: number) => boolean } = {},
): Promise<string[]> {
  if (!agents.some((agent) => agent.children.length > 0 || agent.delegator !== null)) return [];
  const corrections = planReconciliation({ agents, answered, alive: dependencies.alive ?? processAlive });
  const counts = correctedDelegateCounts(agents, corrections);
  const warnings = corrections.length ? await applyCorrections(corrections, dependencies) : [];
  applyCorrectedCounts(agents, counts);
  return warnings;
}
