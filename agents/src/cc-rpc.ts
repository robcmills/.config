import { runCommand } from "./command.ts";
import { AGENT_STATES } from "./types.ts";
import type { CcInstanceSnapshot, CommandRunner, Provider } from "./types.ts";

type RawCcInstanceSnapshot = Omit<CcInstanceSnapshot, "backgroundTaskCount" | "lastModifiedAt"> & {
  backgroundTaskCount?: number;
  lastModifiedAt?: number | null;
};

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

function isSnapshot(value: unknown): value is RawCcInstanceSnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Number.isInteger(v.outputBufnr) && Number.isInteger(v.promptBufnr)
    && nullableString(v.sessionId) && nullableString(v.name)
    && (v.provider === "claude" || v.provider === "codex")
    && nullableString(v.model) && typeof v.cwd === "string"
    && nullableNumber(v.pid) && AGENT_STATES.includes(v.state as never)
    && nullableNumber(v.turnElapsedMs)
    && (v.backgroundTaskCount === undefined
      || (Number.isSafeInteger(v.backgroundTaskCount) && (v.backgroundTaskCount as number) >= 0))
    && (v.lastModifiedAt === undefined || nullableNumber(v.lastModifiedAt));
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
    return {
      snapshots: parsed.map((snapshot) => ({
        ...snapshot,
        // Older already-running Neovim processes do not expose these fields.
        // Keep inventory usable during rolling restarts.
        backgroundTaskCount: snapshot.backgroundTaskCount ?? 0,
        lastModifiedAt: snapshot.lastModifiedAt ?? null,
      })),
    };
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

// ---------------------------------------------------------------------------
// Control RPCs: open, send_prompt, get_last_assistant_message, close.
//
// Arguments travel as a JSON document in luaeval's `_A` and are decoded with
// vim.json.decode on the Neovim side, so prompt text never touches Lua source.
// Each Lua snippet returns a JSON object with either the result or `err`.
// ---------------------------------------------------------------------------

const API_UNAVAILABLE = "cc.nvim agents API unavailable; update cc.nvim and restart Neovim";

// Lua snippets are embedded in a Vimscript double-quoted string, so they must
// not contain `"` or `\`. luaCallExpression asserts this.
const OPEN_LUA = `(function(a) local o = vim.json.decode(a); local cc = require('cc'); if type(cc.open) ~= 'function' then return vim.json.encode({err='${API_UNAVAILABLE}'}) end; local ok, bufnr, err = pcall(cc.open, o); if not ok then return vim.json.encode({err=tostring(bufnr)}) end; if type(bufnr) ~= 'number' then return vim.json.encode({err=tostring(err or 'cc.open returned no buffer; update cc.nvim and restart Neovim')}) end; return vim.json.encode({bufnr=bufnr, pid=vim.fn.getpid()}) end)(_A)`;

const SEND_LUA = `(function(a) local o = vim.json.decode(a); local cc = require('cc'); if type(cc.send_prompt) ~= 'function' then return vim.json.encode({err='${API_UNAVAILABLE}'}) end; local ok, res, err = pcall(cc.send_prompt, o.bufnr, o.text); if not ok then return vim.json.encode({err=tostring(res)}) end; if not res then return vim.json.encode({err=tostring(err or 'cc.send_prompt failed')}) end; return vim.json.encode({ok=true}) end)(_A)`;

const TAIL_LUA = `(function(a) local o = vim.json.decode(a); local cc = require('cc'); if type(cc.get_last_assistant_message) ~= 'function' then return vim.json.encode({err='${API_UNAVAILABLE}'}) end; local ok, text, err = pcall(cc.get_last_assistant_message, o.bufnr); if not ok then return vim.json.encode({err=tostring(text)}) end; if type(text) ~= 'string' then return vim.json.encode({err=tostring(err or 'no assistant message yet')}) end; return vim.json.encode({text=text}) end)(_A)`;

// Older cc.nvim exposes close() with no parameters and acts on the current
// instance; calling it from here would close whatever the user is looking at.
const CLOSE_LUA = `(function(a) local o = vim.json.decode(a); local cc = require('cc'); local info = type(cc.close) == 'function' and debug.getinfo(cc.close, 'u') or nil; if not info or info.nparams < 1 then return vim.json.encode({err='${API_UNAVAILABLE}'}) end; local ok, res, err = pcall(cc.close, o.bufnr); if not ok then return vim.json.encode({err=tostring(res)}) end; if res == false then return vim.json.encode({err=tostring(err or 'cc.close failed')}) end; return vim.json.encode({ok=true}) end)(_A)`;

/**
 * Build a `--remote-expr` expression that evaluates `lua` with `_A` bound to
 * the JSON encoding of `arg`. JSON goes in a Vimscript single-quoted string,
 * where the only escape is doubling `'`.
 */
export function luaCallExpression(lua: string, arg: unknown): string {
  if (/["\\]/.test(lua)) throw new Error("Lua snippet must not contain double quotes or backslashes");
  const json = JSON.stringify(arg).replaceAll("'", "''");
  return `luaeval("${lua}", '${json}')`;
}

interface RpcEnvelope {
  err?: string;
  [key: string]: unknown;
}

async function callCc(
  socketPath: string,
  lua: string,
  arg: unknown,
  timeoutMs: number,
  run: CommandRunner,
  label: string,
): Promise<{ value: RpcEnvelope | null; error?: string }> {
  const result = await run(
    ["nvim", "--server", socketPath, "--remote-expr", luaCallExpression(lua, arg)],
    timeoutMs,
  );
  if (result.timedOut) return { value: null, error: `cc.nvim ${label} RPC timed out` };
  if (result.exitCode !== 0) {
    return { value: null, error: conciseError(result.stderr, `cc.nvim ${label} RPC failed`) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    return { value: null, error: `cc.nvim ${label} returned invalid JSON` };
  }
  if (!parsed || typeof parsed !== "object") {
    return { value: null, error: `cc.nvim ${label} returned an unexpected value` };
  }
  const envelope = parsed as RpcEnvelope;
  if (typeof envelope.err === "string") return { value: null, error: envelope.err };
  return { value: envelope };
}

export interface CcOpenOptions {
  cwd: string;
  prompt?: string;
  model?: string;
  effort?: string;
  name?: string;
  provider?: Provider;
  focus?: boolean;
  permission_mode?: string;
}

export interface CcOpenResult {
  ok: boolean;
  bufnr?: number;
  pid?: number;
  error?: string;
}

export async function openCcInstance(
  socketPath: string,
  options: CcOpenOptions,
  timeoutMs = 5_000,
  run: CommandRunner = runCommand,
): Promise<CcOpenResult> {
  // Only send keys the caller set so cc.nvim applies its own defaults.
  const opts = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
  const { value, error } = await callCc(socketPath, OPEN_LUA, opts, timeoutMs, run, "open");
  if (!value) return { ok: false, error };
  if (!Number.isSafeInteger(value.bufnr) || (value.bufnr as number) <= 0 || !Number.isSafeInteger(value.pid)) {
    return { ok: false, error: "cc.nvim open returned an invalid buffer or pid" };
  }
  return { ok: true, bufnr: value.bufnr as number, pid: value.pid as number };
}

function validBufnr(outputBufnr: number): boolean {
  return Number.isSafeInteger(outputBufnr) && outputBufnr > 0;
}

export async function sendCcPrompt(
  socketPath: string,
  outputBufnr: number,
  text: string,
  timeoutMs = 3_000,
  run: CommandRunner = runCommand,
): Promise<{ ok: boolean; error?: string }> {
  if (!validBufnr(outputBufnr)) return { ok: false, error: "invalid output buffer number" };
  if (text.trim() === "") return { ok: false, error: "prompt is empty" };
  const { value, error } = await callCc(
    socketPath, SEND_LUA, { bufnr: outputBufnr, text }, timeoutMs, run, "send_prompt",
  );
  return value ? { ok: true } : { ok: false, error };
}

export async function getCcLastAssistantMessage(
  socketPath: string,
  outputBufnr: number,
  timeoutMs = 2_000,
  run: CommandRunner = runCommand,
): Promise<{ text: string | null; error?: string }> {
  if (!validBufnr(outputBufnr)) return { text: null, error: "invalid output buffer number" };
  const { value, error } = await callCc(
    socketPath, TAIL_LUA, { bufnr: outputBufnr }, timeoutMs, run, "get_last_assistant_message",
  );
  if (!value) return { text: null, error };
  if (typeof value.text !== "string") return { text: null, error: "cc.nvim returned a non-string message" };
  return { text: value.text };
}

export async function closeCcInstance(
  socketPath: string,
  outputBufnr: number,
  timeoutMs = 3_000,
  run: CommandRunner = runCommand,
): Promise<{ ok: boolean; error?: string }> {
  if (!validBufnr(outputBufnr)) return { ok: false, error: "invalid output buffer number" };
  const { value, error } = await callCc(
    socketPath, CLOSE_LUA, { bufnr: outputBufnr }, timeoutMs, run, "close",
  );
  return value ? { ok: true } : { ok: false, error };
}
