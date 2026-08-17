import { basename, relative, sep } from "node:path";
import { homedir } from "node:os";
import { queryCcInstances } from "./cc-rpc.ts";
import { dedupeNeovimInstances, discoverNeovimInstances } from "./discover-neovim.ts";
import { correlatePane, discoverProcessParents, discoverTmuxPanes } from "./discover-tmux.ts";
import { createAgentComparator, validateConfig } from "./sort.ts";
import type {
  Agent,
  AgentsConfig,
  CcInstanceSnapshot,
  InventoryResult,
  NvimInstance,
  TmuxPane,
} from "./types.ts";

export function projectFromCwd(cwd: string, home = homedir()): string {
  const srcRoot = `${home}${sep}src`;
  const withinSrc = relative(srcRoot, cwd);
  if (withinSrc && !withinSrc.startsWith(`..${sep}`) && withinSrc !== "..") {
    return withinSrc.split(sep)[0] || basename(cwd);
  }
  return basename(cwd) || cwd;
}

export function mergeSnapshots(
  nvim: NvimInstance,
  snapshots: CcInstanceSnapshot[],
  pane: TmuxPane | null,
): Agent[] {
  return snapshots
    .filter((snapshot) => snapshot.state !== "exited")
    .map((snapshot) => ({
      ...snapshot,
      key: `${nvim.pid}:${snapshot.outputBufnr}`,
      project: projectFromCwd(snapshot.cwd),
      nvimPid: nvim.pid,
      socketPath: nvim.socketPath,
      tmuxSessionId: pane?.sessionId ?? null,
      tmuxWindowId: pane?.windowId ?? null,
      tmuxWindowName: pane?.windowName ?? null,
      tmuxPaneId: pane?.paneId ?? null,
    }));
}

function describeTarget(pane: TmuxPane | null): string {
  return pane
    ? `tmux ${pane.sessionId}/${pane.windowId}/${pane.paneId}`
    : "tmux target unavailable";
}

export interface InventoryDependencies {
  discoverNeovim?: () => Promise<NvimInstance[]>;
  discoverTmux?: () => Promise<TmuxPane[]>;
  discoverParents?: () => Promise<Map<number, number>>;
  queryCc?: (socketPath: string) => Promise<{ snapshots: CcInstanceSnapshot[] | null; error?: string }>;
}

export async function buildInventory(
  rawConfig: AgentsConfig,
  dependencies: InventoryDependencies = {},
): Promise<InventoryResult> {
  const config = validateConfig(rawConfig);
  const [rawNvim, panes, parents] = await Promise.all([
    // queryCcInstances below doubles as the bounded RPC health check, avoiding
    // a separate nvim --remote-expr ping for every listener.
    (dependencies.discoverNeovim ?? (() => discoverNeovimInstances({ probeRpc: false })))(),
    (dependencies.discoverTmux ?? discoverTmuxPanes)(),
    (dependencies.discoverParents ?? discoverProcessParents)(),
  ]);
  const nvims = dedupeNeovimInstances(rawNvim);
  const warnings: string[] = [];
  const batches = await Promise.all(nvims.map(async (nvim) => {
    const pane = correlatePane(nvim.pid, nvim.cwd, panes, parents);
    if (nvim.state === "wedged") {
      warnings.push(
        `Neovim RPC unresponsive: socket=${nvim.socketPath} pid=${nvim.pid} cwd=${nvim.cwd || "unknown"} ${describeTarget(pane)}${nvim.detail ? ` (${nvim.detail})` : ""}`,
      );
      return [];
    }
    const result = await (dependencies.queryCc ?? queryCcInstances)(nvim.socketPath);
    if (result.snapshots === null) {
      warnings.push(
        `Could not inventory cc.nvim: socket=${nvim.socketPath} pid=${nvim.pid} cwd=${nvim.cwd || "unknown"} ${describeTarget(pane)} (${result.error || "unknown RPC error"})`,
      );
      return [];
    }
    return mergeSnapshots(nvim, result.snapshots, pane);
  }));
  const agents = batches.flat();
  agents.sort(createAgentComparator(config));
  warnings.sort();
  return { agents, warnings };
}
