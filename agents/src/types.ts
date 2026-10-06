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
  /** Children registered with this agent, as it last heard from them. */
  children: DelegateChild[];
}

export interface DelegateChild {
  key: string;
  sessionId: string | null;
  state: AgentState;
  nvimPid: number | null;
}

/** A parent agent's address, as a forwarder records it. */
export interface ParentRef {
  key: string;
  socket: string;
  bufnr: number;
  sessionId: string | null;
}

/** A forwarder installed in a child's Neovim, from that Neovim's registry. */
export interface ForwarderRecord {
  name: string;
  parent: ParentRef;
  childBufnr: number;
  childKey: string;
  /** The child's Neovim, filled in by the inventory. */
  nvimPid: number;
  socketPath: string;
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
  /** The parent that owns this agent, from its forwarder or a parent's children; null when unlinked. */
  delegator: ParentRef | null;
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
  /** Forwarders found in the Neovims that answered. */
  forwarders?: ForwarderRecord[];
}
