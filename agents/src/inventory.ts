import { basename, relative, sep } from "node:path";
import { homedir } from "node:os";
import { queryCcInstances } from "./cc-rpc.ts";
import { reconcileDelegations } from "./delegation.ts";
import type { LinkDependencies } from "./delegation.ts";
import { dedupeNeovimInstances, discoverNeovimInstances } from "./discover-neovim.ts";
import { correlatePane, discoverProcessParents, discoverTmuxPanes } from "./discover-tmux.ts";
import { createAgentComparator, validateConfig } from "./sort.ts";
import type {
  Agent,
  AgentsConfig,
  CcInstanceSnapshot,
  ForwarderRecord,
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
      delegator: null,
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
  queryCc?: (socketPath: string) => Promise<{
    snapshots: CcInstanceSnapshot[] | null;
    forwarders?: Omit<ForwarderRecord, "nvimPid" | "socketPath">[];
    error?: string;
  }>;
  reconcile?: LinkDependencies & { alive?: (pid: number) => boolean };
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
  const answered = new Set<number>();
  const forwarders: ForwarderRecord[] = [];
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
    answered.add(nvim.pid);
    for (const record of result.forwarders ?? []) forwarders.push({ ...record, nvimPid: nvim.pid, socketPath: nvim.socketPath });
    return mergeSnapshots(nvim, result.snapshots, pane);
  }));
  const agents = batches.flat();
  // Every inventory repairs parent/child links it can see are stale.
  warnings.push(...await reconcileDelegations(agents, forwarders, answered, dependencies.reconcile));
  agents.sort(createAgentComparator(config));
  warnings.sort();
  return { agents, warnings, forwarders };
}

/**
 * Repair delegation links without the tmux discovery a full inventory does,
 * for callers that only want the repair (cc.nvim instances coming up).
 */
export async function reconcileOnly(
  rawConfig: AgentsConfig,
  dependencies: InventoryDependencies = {},
): Promise<InventoryResult> {
  return buildInventory(rawConfig, {
    ...dependencies,
    discoverTmux: async () => [],
    discoverParents: async () => new Map(),
  });
}
