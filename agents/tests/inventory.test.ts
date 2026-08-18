import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { buildInventory, projectFromCwd } from "../src/inventory.ts";
import type { AgentsConfig, CcInstanceSnapshot } from "../src/types.ts";

const config: AgentsConfig = {
  sort: { by: ["project", "status", "name"], projectOrder: ["openspace*"], statusOrder: ["waiting", "working", "ready", "starting"] },
};

const snapshot = (overrides: Partial<CcInstanceSnapshot> = {}): CcInstanceSnapshot => ({
  outputBufnr: 4, promptBufnr: 5, sessionId: "s", name: "n", provider: "claude",
  model: "opus", cwd: `${homedir()}/src/openspace-a/web`, pid: 90,
  state: "ready", turnElapsedMs: null, backgroundTaskCount: 0,
  lastModifiedAt: 1_700_000_000_000, ...overrides,
});

test("project labels use the first ~/src component and basename elsewhere", () => {
  expect(projectFromCwd("/Users/me/src/openspace-a/web", "/Users/me")).toBe("openspace-a");
  expect(projectFromCwd("/Users/me/notes", "/Users/me")).toBe("notes");
});

describe("inventory merge", () => {
  test("filters exited agents, merges exact pane IDs, sorts, and warns for wedged Neovim", async () => {
    const result = await buildInventory(config, {
      discoverNeovim: async () => [
        { socketPath: "/nvim.10.0", pid: 10, cwd: `${homedir()}/src/openspace-a/web`, state: "responsive" },
        { socketPath: "/nvim.20.0", pid: 20, cwd: "/Users/me/notes", state: "wedged", detail: "timeout" },
      ],
      discoverTmux: async () => [{ sessionId: "$1", windowId: "@2", windowName: "x", paneId: "%3", panePid: 1, currentPath: "/none" }],
      discoverParents: async () => new Map([[10, 1]]),
      queryCc: async () => ({ snapshots: [snapshot(), snapshot({ outputBufnr: 9, state: "exited" })] }),
    });
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.key).toBe("10:4");
    expect(result.agents[0]?.project).toBe("openspace-a");
    expect(result.agents[0]?.tmuxPaneId).toBe("%3");
    expect(result.warnings[0]).toContain("socket=/nvim.20.0");
    expect(result.warnings[0]).toContain("pid=20");
  });

  test("warns when cc.nvim query fails without inventing agents", async () => {
    const result = await buildInventory(config, {
      discoverNeovim: async () => [{ socketPath: "/nvim.10.0", pid: 10, cwd: "/x", state: "responsive" }],
      discoverTmux: async () => [], discoverParents: async () => new Map(),
      queryCc: async () => ({ snapshots: null, error: "bad JSON" }),
    });
    expect(result.agents).toEqual([]);
    expect(result.warnings[0]).toContain("bad JSON");
  });
});
