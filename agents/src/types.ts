export const AGENT_STATES = [
  "waiting",
  "interrupting",
  "unread",
  "working",
  "delegating",
  "monitoring",
  "starting",
  "ready",
  "exited",
] as const;

export type AgentState = (typeof AGENT_STATES)[number];
export type Provider = "claude" | "codex";

export interface CcInstanceSnapshot {
  outputBufnr: number;
  promptBufnr: number;
  sessionId: string | null;
  name: string | null;
  provider: Provider;
  model: string | null;
  cwd: string;
  pid: number | null;
  state: AgentState;
  turnElapsedMs: number | null;
  backgroundTaskCount: number;
  lastModifiedAt: number | null;
  /** Linked child agents that are busy; counts even when another state wins. */
  delegateCount: number;
  /** Children linked to this agent, as it last heard from them. */
  children: DelegateChild[];
  /** The agent this one reports to, or null when unlinked. */
  delegator: DelegatorRef | null;
}

export interface DelegateChild {
  key: string;
  sessionId: string | null;
  state: AgentState;
  nvimPid: number | null;
  /** cc.nvim's per-instance link id; identifies the exact child incarnation. */
  uid: string | null;
}

export interface DelegatorRef {
  key: string;
  sessionId: string | null;
  socket: string | null;
  bufnr: number | null;
}

export interface TmuxPane {
  sessionId: string;
  windowId: string;
  windowName: string;
  paneId: string;
  panePid: number;
  currentPath: string;
}

export type NvimState = "responsive" | "wedged";

export interface NvimInstance {
  socketPath: string;
  pid: number;
  cwd: string;
  state: NvimState;
  detail?: string;
}

export interface Agent extends CcInstanceSnapshot {
  key: string;
  project: string;
  nvimPid: number;
  socketPath: string;
  tmuxSessionId: string | null;
  tmuxWindowId: string | null;
  tmuxWindowName: string | null;
  tmuxPaneId: string | null;
}

export const SORT_KEYS = ["lastModified", "project", "status", "name", "provider", "model", "key"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export interface AgentsConfig {
  sort: {
    by: SortKey[];
    projectOrder: string[];
    statusOrder: AgentState[];
  };
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export type CommandRunner = (args: string[], timeoutMs?: number) => Promise<CommandResult>;

export interface InventoryResult {
  agents: Agent[];
  warnings: string[];
}
