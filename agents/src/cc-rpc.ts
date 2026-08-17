import { runCommand } from "./command.ts";
import { AGENT_STATES } from "./types.ts";
import type { CcInstanceSnapshot, CommandRunner } from "./types.ts";

const LIST_EXPR = `luaeval("(function() local cc=package.loaded['cc']; if not cc then return '[]' end; if not cc.list_instances then error('cc.nvim agents API unavailable; restart Neovim after updating cc.nvim') end; return vim.json.encode(cc.list_instances()) end)()")`;

function conciseError(value: string, fallback: string): string {
  const firstLine = value.trim().split("\n")[0]?.trim();
  if (!firstLine) return fallback;
  return firstLine.length > 240 ? `${firstLine.slice(0, 239)}…` : firstLine;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isSnapshot(value: unknown): value is CcInstanceSnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Number.isInteger(v.outputBufnr) && Number.isInteger(v.promptBufnr)
    && nullableString(v.sessionId) && nullableString(v.name)
    && (v.provider === "claude" || v.provider === "codex")
    && nullableString(v.model) && typeof v.cwd === "string"
    && nullableNumber(v.pid) && AGENT_STATES.includes(v.state as never)
    && nullableNumber(v.turnElapsedMs);
}

export interface CcQueryResult {
  snapshots: CcInstanceSnapshot[] | null;
  error?: string;
}

export async function queryCcInstances(
  socketPath: string,
  timeoutMs = 750,
  run: CommandRunner = runCommand,
): Promise<CcQueryResult> {
  const result = await run(["nvim", "--server", socketPath, "--remote-expr", LIST_EXPR], timeoutMs);
  if (result.timedOut) return { snapshots: null, error: "cc.nvim inventory RPC timed out" };
  if (result.exitCode !== 0) {
    return { snapshots: null, error: conciseError(result.stderr, "cc.nvim inventory RPC failed") };
  }
  try {
    const parsed = JSON.parse(result.stdout.trim()) as unknown;
    if (!Array.isArray(parsed) || !parsed.every(isSnapshot)) {
      return { snapshots: null, error: "cc.nvim returned an invalid instance snapshot" };
    }
    return { snapshots: parsed };
  } catch {
    return { snapshots: null, error: "cc.nvim returned invalid JSON" };
  }
}

export async function focusCcInstance(
  socketPath: string,
  outputBufnr: number,
  timeoutMs = 1_000,
  run: CommandRunner = runCommand,
): Promise<{ ok: boolean; error?: string }> {
  if (!Number.isSafeInteger(outputBufnr) || outputBufnr <= 0) {
    return { ok: false, error: "invalid output buffer number" };
  }
  const expression = `luaeval("require('cc').focus_instance(_A)", ${outputBufnr})`;
  const result = await run(["nvim", "--server", socketPath, "--remote-expr", expression], timeoutMs);
  if (result.timedOut) return { ok: false, error: "cc.nvim focus RPC timed out" };
  if (result.exitCode !== 0) return { ok: false, error: conciseError(result.stderr, "cc.nvim focus RPC failed") };
  const value = result.stdout.trim();
  return value === "1" || value === "v:true" || value === "true"
    ? { ok: true }
    : { ok: false, error: "agent disappeared before it could be focused" };
}
