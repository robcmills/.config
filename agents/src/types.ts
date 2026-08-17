export const AGENT_STATES = [
  "waiting",
  "interrupting",
  "working",
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

export const SORT_KEYS = ["project", "status", "name", "provider", "model", "key"] as const;
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
