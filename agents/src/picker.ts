import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isProcessAlive } from "./discover-neovim.ts";
import { formatPickerTable } from "./format.ts";
import type { Agent } from "./types.ts";

export const PICKER_ROWS_FLAG = "--picker-rows";
export const REFRESH_KEY = "ctrl-r";
const AGENTS_BIN = `${import.meta.dir}/../bin/agents`;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The header line followed by the rows, as fzf reads them with --header-lines=1. */
export function formatPickerLines(agents: Agent[]): string {
  const { header, rows } = formatPickerTable(agents);
  return [header, ...rows].join("\n") + "\n";
}

/**
 * Manual repair for changes no event reports (a SIGKILLed Neovim, tmux window
 * changes). reload-sync keeps the old list until the new one is ready.
 */
export function pickerRefreshBinding(bin = AGENTS_BIN): string {
  return `${REFRESH_KEY}:reload-sync(${shellQuote(bin)} ${PICKER_ROWS_FLAG})`;
}

export function pickerWarningSummary(warningCount: number): string | null {
  if (warningCount <= 0) return null;
  const noun = warningCount === 1 ? "warning" : "warnings";
  return `⚠ ${warningCount} inventory ${noun} · details: agents doctor`;
}

/**
 * Where open popups listen. picker-notify.lua, loaded in every Neovim, connects
 * to each `<pid>.sock` here on cc.nvim's CcStateChanged and CcRenamed, and
 * writes renames to each `spawn-<pid>.sock` (a waiting `jarvis spawn`).
 */
export function pickerDir(env: Record<string, string | undefined> = process.env): string {
  return env.AGENTS_PICKER_DIR || `/tmp/agents-picker.${env.USER || "unknown"}`;
}

/** Delete the files of popups and spawns that died without cleaning up. */
export function pruneStalePickers(dir: string, alive: (pid: number) => boolean = isProcessAlive): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const pid = Number(entry.match(/^(?:spawn-)?(\d+)\./)?.[1]);
    if (Number.isSafeInteger(pid) && pid > 0 && !alive(pid)) rmSync(join(dir, entry), { force: true });
  }
}

export interface Coalescer {
  /** Something changed: refresh now, or once more after the refresh in flight. */
  changed(): void;
  /** fzf can take pushes. Refreshes wait for this. */
  ready(): void;
  /** No further refreshes start. */
  stop(): void;
  /** Resolves when no refresh is in flight. */
  settled(): Promise<void>;
}

/**
 * One refresh at a time. Changes during a refresh collapse into one rerun when
 * it ends, so there is no debounce timer and an idle system does nothing.
 */
export function createCoalescer(refresh: () => Promise<void>): Coalescer {
  let ready = false;
  let dirty = false;
  let stopped = false;
  let running: Promise<void> | null = null;
  const pump = () => {
    if (running || stopped || !ready || !dirty) return;
    dirty = false;
    running = refresh().catch(() => {}).finally(() => {
      running = null;
      pump();
    });
  };
  return {
    changed() {
      dirty = true;
      pump();
    },
    ready() {
      ready = true;
      pump();
    },
    stop() {
      stopped = true;
    },
    async settled() {
      while (running) await running;
    },
  };
}

export type FzfPost = (socket: string, action: string) => Promise<void>;

async function postToFzf(socket: string, action: string): Promise<void> {
  const headers: Record<string, string> = {};
  if (process.env.FZF_API_KEY) headers["x-api-key"] = process.env.FZF_API_KEY;
  const response = await fetch("http://localhost/", { unix: socket, method: "POST", body: action, headers });
  if (!response.ok) throw new Error(`fzf rejected ${action}: ${response.status}`);
}

export interface PickerSession {
  /** Neovims connect here to report a change; fzf's start event writes `ready`. */
  socketPath: string;
  fzfSocketPath: string;
  rowsPath: string;
  coalescer: Coalescer;
  /** The agents fzf last loaded from an event, or null before the first. */
  latest(): Agent[] | null;
  /** Stop listening and delete this popup's files. Idempotent. */
  close(): void;
}

export interface PickerSessionOptions {
  inventory: () => Promise<Agent[]>;
  dir?: string;
  pid?: number;
  post?: FzfPost;
  alive?: (pid: number) => boolean;
}

/**
 * Listen for agent changes while the popup is open. Open it before the first
 * inventory, so a change during that inventory is not lost.
 */
export function openPickerSession(options: PickerSessionOptions): PickerSession {
  const dir = options.dir ?? pickerDir();
  const pid = options.pid ?? process.pid;
  const post = options.post ?? postToFzf;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  pruneStalePickers(dir, options.alive);
  const socketPath = join(dir, `${pid}.sock`);
  const fzfSocketPath = join(dir, `${pid}.fzf.sock`);
  const rowsPath = join(dir, `${pid}.rows`);
  for (const path of [socketPath, fzfSocketPath, rowsPath]) rmSync(path, { force: true });

  let latest: Agent[] | null = null;
  const coalescer = createCoalescer(async () => {
    const agents = await options.inventory();
    writeFileSync(rowsPath, formatPickerLines(agents));
    await post(fzfSocketPath, `reload-sync(cat ${shellQuote(rowsPath)})`);
    latest = agents;
  });
  // A connection is the message. fzf's readiness probe writes `ready`;
  // Neovims write nothing, so a connection that closes silently is a change.
  const server = Bun.listen<{ ready: boolean }>({
    unix: socketPath,
    socket: {
      open(socket) {
        socket.data = { ready: false };
      },
      data(socket, chunk) {
        if (chunk.toString().includes("ready")) socket.data.ready = true;
        socket.end();
      },
      close(socket) {
        if (socket.data?.ready) coalescer.ready();
        else coalescer.changed();
      },
    },
  });

  let closed = false;
  return {
    socketPath,
    fzfSocketPath,
    rowsPath,
    coalescer,
    latest: () => latest,
    close() {
      if (closed) return;
      closed = true;
      coalescer.stop();
      server.stop(true);
      for (const path of [socketPath, fzfSocketPath, rowsPath]) rmSync(path, { force: true });
    },
  };
}

export function pickerArgs(warningCount: number, session?: PickerSession, bin = AGENTS_BIN): string[] {
  const args = [
    "fzf",
    "--ansi",
    "--layout=reverse",
    "--delimiter=\t",
    "--with-nth=1",
    "--id-nth=2",
    "--prompt=Select agent: ",
    `--header=${REFRESH_KEY} refresh`,
    "--header-lines=1",
    "--track",
    `--bind=${pickerRefreshBinding(bin)}`,
  ];
  if (session) {
    // fzf's server is listening by the time `start` fires.
    args.push(
      `--listen=${session.fzfSocketPath}`,
      `--bind=start:execute-silent(printf ready | nc -U ${shellQuote(session.socketPath)} >/dev/null 2>&1)`,
    );
  }
  const warning = pickerWarningSummary(warningCount);
  if (warning) {
    args.push(
      "--border=bottom",
      `--border-label=${warning}`,
      "--border-label-pos=2:bottom",
    );
  }
  return args;
}

/** Returns the picked agent's key, or null when cancelled. */
export async function pickAgent(agents: Agent[], warningCount = 0, session?: PickerSession): Promise<string | null> {
  const proc = Bun.spawn(pickerArgs(warningCount, session), { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(formatPickerLines(agents));
  proc.stdin.end();
  const [output, errorOutput, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode === 1 || exitCode === 130) return null;
  if (exitCode !== 0) {
    throw new Error(`fzf failed: ${errorOutput.trim() || `exit ${exitCode}`}`);
  }
  const selected = output.trimEnd();
  const separator = selected.lastIndexOf("\t");
  return separator === -1 ? null : selected.slice(separator + 1);
}

/**
 * The picked agent. Rows can come from a reload, so look in the latest pushed
 * inventory, then the one the popup opened with, then a fresh one (a ctrl-r
 * reload runs in fzf, out of this process's sight).
 */
export async function resolvePicked(
  key: string,
  known: (Agent[] | null)[],
  fresh: () => Promise<Agent[]>,
): Promise<Agent | null> {
  for (const agents of known) {
    const agent = agents?.find((candidate) => candidate.key === key);
    if (agent) return agent;
  }
  return (await fresh()).find((candidate) => candidate.key === key) ?? null;
}
