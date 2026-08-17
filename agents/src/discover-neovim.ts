import { readdirSync, readlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { runCommand } from "./command.ts";
import type { CommandRunner, NvimInstance } from "./types.ts";

export function parsePidFromSocket(socketPath: string): number | null {
  const match = basename(socketPath).match(/^nvim\.(\d+)\.\d+$/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function getTempRoots(run: CommandRunner = runCommand): Promise<string[]> {
  const roots = new Set<string>([tmpdir()]);
  if (process.env.TMPDIR) roots.add(process.env.TMPDIR);
  if (process.platform === "darwin") {
    const result = await run(["getconf", "DARWIN_USER_TEMP_DIR"], 1_000);
    const root = result.stdout.trim();
    if (result.exitCode === 0 && root) roots.add(root);
  }
  roots.add("/tmp");
  return [...roots];
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

export function findAllNeovimSockets(
  roots: string[],
  user = process.env.USER || "unknown",
): string[] {
  const sockets = new Set<string>();
  for (const root of roots) {
    const nvimDir = join(root, `nvim.${user}`);
    for (const entry of safeReadDir(nvimDir)) {
      const entryPath = join(nvimDir, entry);
      if (parsePidFromSocket(entryPath) !== null) sockets.add(entryPath);
      for (const file of safeReadDir(entryPath)) {
        const socketPath = join(entryPath, file);
        if (parsePidFromSocket(socketPath) !== null) sockets.add(socketPath);
      }
    }
  }
  return [...sockets].sort();
}

export async function getCwdFromPid(
  pid: number,
  run: CommandRunner = runCommand,
): Promise<string | null> {
  if (process.platform === "linux") {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    return (await getCwdsFromPids([pid], run)).get(pid) ?? null;
  }
  return null;
}

export function parseLsofCwds(output: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  for (const line of output.split("\n")) {
    const pidMatch = line.match(/^p(\d+)$/);
    if (pidMatch) {
      pid = Number(pidMatch[1]);
    } else if (pid !== null && line.startsWith("n")) {
      cwds.set(pid, line.slice(1));
    }
  }
  return cwds;
}

export async function getCwdsFromPids(
  rawPids: number[],
  run: CommandRunner = runCommand,
): Promise<Map<number, string>> {
  const pids = [...new Set(rawPids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  if (pids.length === 0) return new Map();

  if (process.platform === "linux") {
    const cwds = new Map<number, string>();
    for (const pid of pids) {
      try {
        cwds.set(pid, readlinkSync(`/proc/${pid}/cwd`));
      } catch {}
    }
    return cwds;
  }
  if (process.platform === "darwin") {
    // lsof startup and kernel inspection dominate discovery when invoked once
    // per Neovim. A comma-separated PID list produces the same p/n records in
    // a single scan. Parse useful stdout even if a process exits mid-command.
    const result = await run(["lsof", "-a", "-d", "cwd", "-p", pids.join(","), "-Fn"], 1_000);
    return parseLsofCwds(result.stdout);
  }
  return new Map();
}

const INFO_EXPR = `luaeval("vim.json.encode({pid=vim.fn.getpid(),cwd=vim.fn.getcwd()})")`;
const PING_EXPR = "1";

async function remoteExpr(
  socketPath: string,
  expression: string,
  timeoutMs: number,
  run: CommandRunner,
) {
  return run(["nvim", "--server", socketPath, "--remote-expr", expression], timeoutMs);
}

interface RpcInfo {
  pid: number;
  cwd: string;
}

async function rpcInfo(
  socketPath: string,
  timeoutMs: number,
  run: CommandRunner,
): Promise<RpcInfo | null> {
  const result = await remoteExpr(socketPath, INFO_EXPR, timeoutMs, run);
  if (result.exitCode !== 0 || result.timedOut) return null;
  try {
    const value = JSON.parse(result.stdout.trim()) as Partial<RpcInfo>;
    if (!Number.isSafeInteger(value.pid) || (value.pid ?? 0) <= 0 || typeof value.cwd !== "string") {
      return null;
    }
    return { pid: value.pid!, cwd: value.cwd };
  } catch {
    return null;
  }
}

export interface DiscoverNeovimOptions {
  roots?: string[];
  user?: string;
  timeoutMs?: number;
  run?: CommandRunner;
  alive?: (pid: number) => boolean;
  cwdFromPid?: (pid: number) => Promise<string | null>;
  probeRpc?: boolean;
}

export async function discoverNeovimInstances(
  options: DiscoverNeovimOptions = {},
): Promise<NvimInstance[]> {
  const run = options.run ?? runCommand;
  const roots = options.roots ?? await getTempRoots(run);
  const timeoutMs = options.timeoutMs ?? 750;
  const alive = options.alive ?? isProcessAlive;
  const probeRpc = options.probeRpc ?? true;
  const sockets = findAllNeovimSockets(roots, options.user);
  const livePids = new Set(sockets
    .map(parsePidFromSocket)
    .filter((pid): pid is number => pid !== null && alive(pid)));
  const cwdByPid = options.cwdFromPid
    ? new Map(await Promise.all([...livePids].map(async (pid) => [pid, await options.cwdFromPid!(pid)] as const)))
    : await getCwdsFromPids([...livePids], run);

  const found = await Promise.all(sockets.map(async (socketPath): Promise<NvimInstance | null> => {
    const parsedPid = parsePidFromSocket(socketPath);
    if (parsedPid !== null && livePids.has(parsedPid)) {
      const cwd = cwdByPid.get(parsedPid) ?? null;
      // The inventory query is itself a bounded RPC health check. Production
      // discovery skips this separate ping so each Neovim needs only one RPC.
      if (!probeRpc) {
        return { socketPath, pid: parsedPid, cwd: cwd ?? "", state: "responsive" };
      }
      const ping = await remoteExpr(socketPath, PING_EXPR, timeoutMs, run);
      if (ping.exitCode === 0 && !ping.timedOut) {
        if (cwd !== null) {
          return { socketPath, pid: parsedPid, cwd, state: "responsive" };
        }
        const info = await rpcInfo(socketPath, timeoutMs, run);
        if (info) return { socketPath, pid: info.pid, cwd: info.cwd, state: "responsive" };
      }
      return {
        socketPath,
        pid: parsedPid,
        cwd: cwd ?? "",
        state: "wedged",
        detail: ping.timedOut ? "RPC timed out" : (ping.stderr.trim() || "RPC did not respond"),
      };
    }

    if (!probeRpc) return null;

    // A nonstandard/stale-looking socket is retained only if RPC proves it is
    // backed by a live Neovim and supplies the missing kernel metadata.
    const info = await rpcInfo(socketPath, timeoutMs, run);
    if (!info || !alive(info.pid)) return null;
    return { socketPath, pid: info.pid, cwd: info.cwd, state: "responsive" };
  }));

  return found.filter((value): value is NvimInstance => value !== null);
}

export function dedupeNeovimInstances(instances: NvimInstance[]): NvimInstance[] {
  const byPid = new Map<number, NvimInstance>();
  for (const instance of [...instances].sort((a, b) => a.socketPath.localeCompare(b.socketPath))) {
    const current = byPid.get(instance.pid);
    if (!current || (current.state === "wedged" && instance.state === "responsive")) {
      byPid.set(instance.pid, instance);
    }
  }
  return [...byPid.values()].sort((a, b) => a.pid - b.pid);
}
