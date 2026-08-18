import type { Agent } from "../src/types.ts";

export function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    key: "100:7",
    project: "project",
    nvimPid: 100,
    socketPath: "/tmp/nvim.100.0",
    tmuxSessionId: "$1",
    tmuxWindowId: "@2",
    tmuxWindowName: "work",
    tmuxPaneId: "%3",
    outputBufnr: 7,
    promptBufnr: 8,
    sessionId: "session-id",
    name: "session-name",
    provider: "codex",
    model: "gpt-5.6-sol",
    cwd: "/Users/me/src/project",
    pid: 200,
    state: "ready",
    turnElapsedMs: null,
    backgroundTaskCount: 0,
    lastModifiedAt: 1_700_000_000_000,
    ...overrides,
  };
}
