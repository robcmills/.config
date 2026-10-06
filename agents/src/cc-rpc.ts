import { runCommand } from "./command.ts";
import { AGENT_STATES } from "./types.ts";
import type {
  AgentState, CcInstanceSnapshot, CommandRunner, DelegateChild, DelegatorRef, Provider,
} from "./types.ts";

type RawCcInstanceSnapshot = Omit<
  CcInstanceSnapshot,
  "backgroundTaskCount" | "lastModifiedAt" | "delegateCount" | "children" | "delegator"
> & {
  backgroundTaskCount?: number;
  lastModifiedAt?: number | null;
  delegateCount?: unknown;
  children?: unknown;
  delegator?: unknown;
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

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function optionalInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) ? value as number : null;
}

/**
 * The delegation fields are newer than the rest of the snapshot, so they are
 * normalized rather than validated: a malformed entry is dropped instead of
 * rejecting the whole Neovim's inventory.
 */
export function normalizeChildren(value: unknown): DelegateChild[] {
  // An empty Lua table may encode as {} rather than [].
  if (!Array.isArray(value)) return [];
  const children: DelegateChild[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const v = entry as Record<string, unknown>;
    if (typeof v.key !== "string" || !AGENT_STATES.includes(v.state as never)) continue;
    children.push({
      key: v.key,
      sessionId: optionalString(v.sessionId),
      state: v.state as AgentState,
      nvimPid: optionalInteger(v.nvimPid),
      uid: optionalString(v.uid),
    });
  }
  return children;
}

export function normalizeDelegator(value: unknown): DelegatorRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.key !== "string" || v.key === "") return null;
  return {
    key: v.key,
    sessionId: optionalString(v.sessionId),
    socket: optionalString(v.socket),
    bufnr: optionalInteger(v.bufnr),
  };
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
        delegateCount: Number.isSafeInteger(snapshot.delegateCount) && (snapshot.delegateCount as number) > 0
          ? snapshot.delegateCount as number : 0,
        children: normalizeChildren(snapshot.children),
        delegator: normalizeDelegator(snapshot.delegator),
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
// Control RPCs: open, send_prompt, get_last_assistant_message, stop, close.
//
// Arguments travel as a JSON document in luaeval's `_A` and are decoded with
// vim.json.decode on the Neovim side, so prompt text never touches Lua source.
// Each Lua snippet returns a JSON object with either the result or `err`.
// ---------------------------------------------------------------------------

const API_UNAVAILABLE = "cc.nvim agents API unavailable; update cc.nvim and restart Neovim";

// Lua snippets are embedded in a Vimscript double-quoted string, so they must
// not contain `"` or `\`. luaCallExpression asserts this.

// A Neovim that loaded cc.nvim before the agents API landed still has an
// `open` function, but it returns nothing, so probing `open` alone creates an
// instance we can never address. Probe the whole API first and refuse before
// anything is created: send_prompt and get_last_assistant_message must be
// functions, and close must accept a target buffer (the same check CLOSE_LUA
// makes).
const API_PROBE_LUA = `type(cc.open) == 'function' and type(cc.send_prompt) == 'function' and type(cc.get_last_assistant_message) == 'function' and type(cc.close) == 'function' and debug.getinfo(cc.close, 'u').nparams >= 1`;

const OPEN_LUA = `(function(a) local o = vim.json.decode(a); local cc = require('cc'); if not (${API_PROBE_LUA}) then return vim.json.encode({err='${API_UNAVAILABLE}'}) end; local ok, bufnr, err = pcall(cc.open, o); if not ok then return vim.json.encode({err=tostring(bufnr)}) end; if type(bufnr) ~= 'number' then return vim.json.encode({err=tostring(err or 'cc.open returned no buffer; update cc.nvim and restart Neovim')}) end; return vim.json.encode({bufnr=bufnr, pid=vim.fn.getpid()}) end)(_A)`;

const SEND_LUA = `(function(a) local o = vim.json.decode(a); local cc = require('cc'); if type(cc.send_prompt) ~= 'function' then return vim.json.encode({err='${API_UNAVAILABLE}'}) end; local ok, res, err = pcall(cc.send_prompt, o.bufnr, o.text, o.delegator and {delegator=o.delegator} or nil); if not ok then return vim.json.encode({err=tostring(res)}) end; if not res then return vim.json.encode({err=tostring(err or 'cc.send_prompt failed')}) end; return vim.json.encode({ok=true}) end)(_A)`;

const TAIL_LUA = `(function(a) local o = vim.json.decode(a); local cc = require('cc'); if type(cc.get_last_assistant_message) ~= 'function' then return vim.json.encode({err='${API_UNAVAILABLE}'}) end; local ok, text, err = pcall(cc.get_last_assistant_message, o.bufnr); if not ok then return vim.json.encode({err=tostring(text)}) end; if type(text) ~= 'string' then return vim.json.encode({err=tostring(err or 'no assistant message yet')}) end; return vim.json.encode({text=text}) end)(_A)`;

// Older cc.nvim exposes close() with no parameters and acts on the current
// instance; calling it from here would close whatever the user is looking at.
const CLOSE_LUA = `(function(a) local o = vim.json.decode(a); local cc = require('cc'); local info = type(cc.close) == 'function' and debug.getinfo(cc.close, 'u') or nil; if not info or info.nparams < 1 then return vim.json.encode({err='${API_UNAVAILABLE}'}) end; local ok, res, err = pcall(cc.close, o.bufnr); if not ok then return vim.json.encode({err=tostring(res)}) end; if res == false then return vim.json.encode({err=tostring(err or 'cc.close failed')}) end; return vim.json.encode({ok=true}) end)(_A)`;

// Older cc.nvim exposes stop() with no parameters and interrupts the current
// instance, the same hazard as close(). The new stop(bufnr) returns ok, err.
const STOP_LUA = `(function(a) local o = vim.json.decode(a); local cc = require('cc'); local info = type(cc.stop) == 'function' and debug.getinfo(cc.stop, 'u') or nil; if not info or info.nparams < 1 then return vim.json.encode({err='${API_UNAVAILABLE}'}) end; local ok, res, err = pcall(cc.stop, o.bufnr); if not ok then return vim.json.encode({err=tostring(res)}) end; if res ~= true then return vim.json.encode({err=tostring(err or 'cc.stop failed')}) end; return vim.json.encode({ok=true}) end)(_A)`;

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

// Delegation RPCs. Each requires cc.delegation, which older cc.nvim lacks;
// require fails inside the pcall and comes back as an error envelope.
const DETACH_LUA = `(function(a) local o = vim.json.decode(a); local okm, D = pcall(require, 'cc.delegation'); if not okm then return vim.json.encode({err='${API_UNAVAILABLE}'}) end; local ok, res, err = pcall(D.detach_bufnr, o.bufnr); if not ok then return vim.json.encode({err=tostring(res)}) end; if not res then return vim.json.encode({err=tostring(err or 'detach failed')}) end; return vim.json.encode({ok=true}) end)(_A)`;

const REPUSH_LUA = `(function(a) local o = vim.json.decode(a); local okm, D = pcall(require, 'cc.delegation'); if not okm then return vim.json.encode({err='${API_UNAVAILABLE}'}) end; local ok, res, err = pcall(D.repush_bufnr, o.bufnr); if not ok then return vim.json.encode({err=tostring(res)}) end; if not res then return vim.json.encode({err=tostring(err or 'repush failed')}) end; return vim.json.encode({ok=true}) end)(_A)`;

const PRUNE_LUA = `(function(a) local o = vim.json.decode(a); local okm, D = pcall(require, 'cc.delegation'); if not okm then return vim.json.encode({err='${API_UNAVAILABLE}'}) end; local ok, res, err = pcall(D.prune_bufnr, o.bufnr, o.child, o.uid); if not ok then return vim.json.encode({err=tostring(res)}) end; if not res then return vim.json.encode({err=tostring(err or 'prune failed')}) end; return vim.json.encode({ok=true}) end)(_A)`;

const REBIND_LUA = `(function(a) local o = vim.json.decode(a); local okm, D = pcall(require, 'cc.delegation'); if not okm then return vim.json.encode({err='${API_UNAVAILABLE}'}) end; local ok, res, err = pcall(D.rebind_bufnr, o.bufnr, o.delegator); if not ok then return vim.json.encode({err=tostring(res)}) end; if not res then return vim.json.encode({err=tostring(err or 'rebind failed')}) end; return vim.json.encode({ok=true}) end)(_A)`;

/** Where a child pushes its state: the parent's agent key, Neovim socket, output buffer, and session. */
export interface CcDelegator {
  key: string;
  socket: string;
  bufnr: number;
  session_id: string | null;
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
  delegator?: CcDelegator;
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
  delegator?: CcDelegator,
): Promise<{ ok: boolean; error?: string }> {
  if (!validBufnr(outputBufnr)) return { ok: false, error: "invalid output buffer number" };
  if (text.trim() === "") return { ok: false, error: "prompt is empty" };
  const arg = delegator ? { bufnr: outputBufnr, text, delegator } : { bufnr: outputBufnr, text };
  const { value, error } = await callCc(socketPath, SEND_LUA, arg, timeoutMs, run, "send_prompt");
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

export async function interruptCcInstance(
  socketPath: string,
  outputBufnr: number,
  timeoutMs = 3_000,
  run: CommandRunner = runCommand,
): Promise<{ ok: boolean; error?: string }> {
  if (!validBufnr(outputBufnr)) return { ok: false, error: "invalid output buffer number" };
  const { value, error } = await callCc(
    socketPath, STOP_LUA, { bufnr: outputBufnr }, timeoutMs, run, "stop",
  );
  return value ? { ok: true } : { ok: false, error };
}

async function delegationCall(
  socketPath: string,
  lua: string,
  arg: { bufnr: number; [key: string]: unknown },
  label: string,
  timeoutMs: number,
  run: CommandRunner,
): Promise<{ ok: boolean; error?: string }> {
  if (!validBufnr(arg.bufnr)) return { ok: false, error: "invalid output buffer number" };
  const { value, error } = await callCc(socketPath, lua, arg, timeoutMs, run, label);
  return value ? { ok: true } : { ok: false, error };
}

/** Release a child's link to its parent. */
export function detachCcInstance(
  socketPath: string, outputBufnr: number, timeoutMs = 3_000, run: CommandRunner = runCommand,
) {
  return delegationCall(socketPath, DETACH_LUA, { bufnr: outputBufnr }, "detach", timeoutMs, run);
}

/** Ask a child to push its current state to its parent again. */
export function repushCcInstance(
  socketPath: string, outputBufnr: number, timeoutMs = 750, run: CommandRunner = runCommand,
) {
  return delegationCall(socketPath, REPUSH_LUA, { bufnr: outputBufnr }, "repush", timeoutMs, run);
}

/** Drop one child entry from a parent, only if it is still the incarnation `uid`. */
export function pruneCcDelegate(
  socketPath: string, parentBufnr: number, childKey: string, uid: string | null,
  timeoutMs = 750, run: CommandRunner = runCommand,
) {
  return delegationCall(
    socketPath, PRUNE_LUA, { bufnr: parentBufnr, child: childKey, uid }, "prune", timeoutMs, run,
  );
}

/** Point a child at its parent's new address (same session, restarted Neovim) and push. */
export function rebindCcInstance(
  socketPath: string, outputBufnr: number, delegator: CcDelegator,
  timeoutMs = 750, run: CommandRunner = runCommand,
) {
  return delegationCall(socketPath, REBIND_LUA, { bufnr: outputBufnr, delegator }, "rebind", timeoutMs, run);
}
