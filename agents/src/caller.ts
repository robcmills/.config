/**
 * The fields caller resolution reads. Jarvis's own Agent type has the same
 * fields with looser optionality, so it can share this code.
 */
export interface CallerCandidate {
  key: string;
  pid?: number | null;
  sessionId?: string | null;
}

/** What identifies the agent running a command: its process ancestry and Claude Code's env. */
export interface CallerContext {
  /** This process's pid. */
  self: number;
  /** pid → ppid for every process, as `ps -axo pid=,ppid=` reports. */
  parents: Map<number, number>;
  env: Record<string, string | undefined>;
}

/** This process and its ancestors, nearest first, stopping before pid 1. */
export function ancestorsOf(self: number, parents: Map<number, number>): number[] {
  const chain: number[] = [];
  const seen = new Set<number>();
  for (let current: number | undefined = self; current !== undefined && current > 1 && !seen.has(current); current = parents.get(current)) {
    seen.add(current);
    chain.push(current);
  }
  return chain;
}

/**
 * Agents that may be running this process, nearest first: an agent whose
 * process is an ancestor (codex and claude alike), then one Claude Code named
 * in `CLAUDE_PID` or `CLAUDE_CODE_SESSION_ID`. Empty from a plain shell.
 */
export function findCallers<T extends CallerCandidate>(agents: T[], context: CallerContext): T[] {
  const chain = ancestorsOf(context.self, context.parents);
  const depth = new Map(chain.map((pid, index) => [pid, index] as const));
  const byAncestry = agents
    .filter((agent) => typeof agent.pid === "number" && depth.has(agent.pid))
    .sort((a, b) => depth.get(a.pid!)! - depth.get(b.pid!)!);
  const { CLAUDE_PID: claudePid, CLAUDE_CODE_SESSION_ID: sessionId } = context.env;
  const byPid = claudePid ? agents.filter((agent) => String(agent.pid) === claudePid) : [];
  const bySession = sessionId ? agents.filter((agent) => agent.sessionId === sessionId) : [];
  const seen = new Set<string>();
  return [...byAncestry, ...byPid, ...bySession].filter((agent) => !seen.has(agent.key) && !!seen.add(agent.key));
}

/** The agent running this process, or null from a plain shell. */
export function resolveCaller<T extends CallerCandidate>(agents: T[], context: CallerContext): T | null {
  return findCallers(agents, context)[0] ?? null;
}
