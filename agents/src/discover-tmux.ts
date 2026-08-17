import { resolve } from "node:path";
import { runCommand } from "./command.ts";
import type { CommandRunner, TmuxPane } from "./types.ts";

const TMUX_FORMAT = [
  "#{session_id}",
  "#{window_id}",
  "#{window_name}",
  "#{pane_id}",
  "#{pane_pid}",
  "#{pane_current_path}",
].join("\t");

export function parseTmuxPanes(output: string): TmuxPane[] {
  const panes: TmuxPane[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const fields = line.split("\t");
    if (fields.length !== 6) continue;
    const [sessionId, windowId, windowName, paneId, rawPid, currentPath] = fields;
    const panePid = Number(rawPid);
    if (!sessionId?.startsWith("$") || !windowId?.startsWith("@")
        || !paneId?.startsWith("%") || !Number.isSafeInteger(panePid) || panePid <= 0
        || currentPath === undefined) continue;
    panes.push({ sessionId, windowId, windowName: windowName ?? "", paneId, panePid, currentPath });
  }
  return panes;
}

export async function discoverTmuxPanes(run: CommandRunner = runCommand): Promise<TmuxPane[]> {
  const result = await run(["tmux", "list-panes", "-a", "-F", TMUX_FORMAT], 1_500);
  return result.exitCode === 0 && !result.timedOut ? parseTmuxPanes(result.stdout) : [];
}

export function parseProcessParents(output: string): Map<number, number> {
  const parents = new Map<number, number>();
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match) parents.set(Number(match[1]), Number(match[2]));
  }
  return parents;
}

export async function discoverProcessParents(run: CommandRunner = runCommand): Promise<Map<number, number>> {
  const result = await run(["ps", "-axo", "pid=,ppid="], 1_500);
  return result.exitCode === 0 && !result.timedOut
    ? parseProcessParents(result.stdout)
    : new Map<number, number>();
}

function isPathRelated(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return left === right || left.startsWith(right + "/") || right.startsWith(left + "/");
}

export function correlatePane(
  nvimPid: number,
  cwd: string,
  panes: TmuxPane[],
  parents: Map<number, number>,
): TmuxPane | null {
  const paneByPid = new Map(panes.map((pane) => [pane.panePid, pane]));
  const seen = new Set<number>();
  let pid: number | undefined = nvimPid;
  while (pid && !seen.has(pid)) {
    const direct = paneByPid.get(pid);
    if (direct) return direct;
    seen.add(pid);
    pid = parents.get(pid);
  }

  if (!cwd) return null;
  const matches = panes.filter((pane) => pane.currentPath && isPathRelated(cwd, pane.currentPath));
  return matches.length === 1 ? matches[0]! : null;
}
