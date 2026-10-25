import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { resolveCaller } from "./caller.ts";
import type { CallerContext } from "./caller.ts";
import {
  closeCcInstance,
  getCcLastAssistantMessage,
  interruptCcInstance,
  openCcInstance,
  sendCcPrompt,
  uninstallForwarder,
  unregisterCcDelegate,
} from "./cc-rpc.ts";
import type { CcOpenOptions } from "./cc-rpc.ts";
import { childRefOf, linkChild, parentRefOf, wouldCycle } from "./delegation.ts";
import type { LinkDependencies } from "./delegation.ts";
import { discoverProcessParents } from "./discover-tmux.ts";
import type { Agent, AgentState, InventoryResult, ParentRef } from "./types.ts";

/** States in which cc.nvim is mid-turn and a new prompt must not be queued. */
export const BUSY_STATES: readonly AgentState[] = ["working", "waiting", "interrupting"];

export const KEY_PATTERN = /^\d+:\d+$/;

export interface ControlDependencies {
  inventory: () => Promise<InventoryResult>;
  open?: typeof openCcInstance;
  send?: typeof sendCcPrompt;
  lastMessage?: typeof getCcLastAssistantMessage;
  close?: typeof closeCcInstance;
  interrupt?: typeof interruptCcInstance;
  callerContext?: () => Promise<CallerContext>;
  link?: LinkDependencies;
  /** Where a link that could not be made is reported; defaults to stderr. */
  warn?: (message: string) => void;
}

function defaultWarn(message: string): void {
  console.error(`agents: warning: ${message}`);
}

/** Who a new or re-engaged agent reports to: the resolved caller, nobody, or an explicit agent key. */
export type FromSpec = "auto" | "none" | { key: string };

export function parseFrom(value: string | undefined): FromSpec {
  if (value === undefined || value === "auto") return "auto";
  if (value === "none") return "none";
  if (KEY_PATTERN.test(value)) return { key: value };
  throw new Error(`invalid value for 'from=': expected auto, none, or an agent key, got '${value}'`);
}

export interface NewAgentOptions extends Omit<CcOpenOptions, "cwd"> {
  socket: string;
  cwd: string;
  from?: FromSpec;
}

async function defaultCallerContext(): Promise<CallerContext> {
  return { self: process.pid, parents: await discoverProcessParents(), env: process.env };
}

/**
 * The agent that `from` names among `agents`. `auto` resolves the caller by
 * process ancestry and Claude Code's env, and is null from a plain shell.
 */
export async function resolveParent(
  from: FromSpec,
  agents: Agent[],
  dependencies: Pick<ControlDependencies, "callerContext">,
): Promise<Agent | null> {
  if (from === "none") return null;
  if (from === "auto") return resolveCaller(agents, await (dependencies.callerContext ?? defaultCallerContext)());
  const parent = agents.find((agent) => agent.key === from.key);
  if (!parent) throw new Error(`from= agent not found: ${from.key}`);
  return parent;
}

export class AgentNotFoundError extends Error {
  constructor(key: string) {
    super(`live agent not found: ${key}`);
  }
}

export class AgentBusyError extends Error {
  constructor(agent: Agent) {
    super(`agent ${agent.key} is ${agent.state}; refusing to send a prompt mid-turn`);
  }
}

export async function findAgent(key: string, dependencies: ControlDependencies): Promise<Agent> {
  const result = await dependencies.inventory();
  const agent = result.agents.find((candidate) => candidate.key === key);
  if (!agent) throw new AgentNotFoundError(key);
  return agent;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The parent a new agent links to. Resolution never blocks a spawn: with
 * `auto`, an inventory failure means no link. An explicit key must resolve.
 */
async function parentForNew(
  from: FromSpec,
  dependencies: Partial<Pick<ControlDependencies, "inventory" | "callerContext">>,
): Promise<Agent | undefined> {
  if (from === "none" || !dependencies.inventory) return undefined;
  let agents: Agent[];
  try {
    agents = (await dependencies.inventory()).agents;
  } catch (error) {
    if (from !== "auto") throw error;
    return undefined;
  }
  return await resolveParent(from, agents, dependencies) ?? undefined;
}

/**
 * The permission mode a new Claude agent starts in: the one asked for, else
 * its Claude parent's live mode. Claude Code holds a cross-session message
 * whose sender runs in another permission class, and cc.nvim has no way to
 * approve it, so a child in its parent's mode is what lets its reports
 * arrive. The child is never more permissive than the parent this way.
 * Undefined leaves cc.nvim's configured default; `warning` says why when a
 * parent was found but its mode was not.
 */
export function inheritedPermissionMode(
  options: Pick<CcOpenOptions, "permission_mode" | "provider">,
  parent: Agent | undefined,
): { mode?: string; warning?: string } {
  if (options.permission_mode !== undefined) return { mode: options.permission_mode };
  if (!parent || parent.provider !== "claude" || options.provider === "codex") return {};
  if (parent.permissionMode) return { mode: parent.permissionMode };
  return {
    warning: `${parent.key}'s permission mode is unknown (cc.nvim predates permissionMode, or its session has not started); `
      + "the new agent starts in cc.nvim's configured mode, and if that differs its messages to the parent are held",
  };
}

/**
 * Open a new cc.nvim instance and return its agent key. With a parent, the
 * child is registered in the parent's Neovim and a forwarder is installed in
 * its own, which then pushes the child's current state once, so a turn that
 * started (or even finished) since open is covered. A link that cannot be
 * made is a warning, never a failed spawn.
 */
export async function newAgent(
  options: NewAgentOptions,
  dependencies: Partial<Pick<ControlDependencies, "open" | "inventory" | "callerContext" | "link" | "warn">> = {},
): Promise<string> {
  const cwd = resolve(options.cwd);
  if (!isDirectory(cwd)) throw new Error(`cwd is not a directory: ${options.cwd}`);
  if (!existsSync(options.socket)) throw new Error(`socket not found: ${options.socket}`);
  const { socket, cwd: _ignored, from = "auto", ...rest } = options;
  const parent = await parentForNew(from, dependencies);
  const warn = dependencies.warn ?? defaultWarn;
  const inherited = inheritedPermissionMode(rest, parent);
  if (inherited.warning) warn(inherited.warning);
  const result = await (dependencies.open ?? openCcInstance)(socket, { ...rest, permission_mode: inherited.mode, cwd });
  if (!result.ok || result.bufnr === undefined || result.pid === undefined) {
    throw new Error(result.error || "cc.nvim open failed");
  }
  const key = `${result.pid}:${result.bufnr}`;
  if (parent) {
    const child = { key, socket, bufnr: result.bufnr, nvimPid: result.pid, sessionId: null, state: "starting" as const };
    for (const warning of await linkChild(parentRefOf(parent), child, dependencies.link)) warn(warning);
  }
  return key;
}

/** Where `agents send` links its target, and the parent it leaves, if any. */
export interface SendLink {
  parent: ParentRef;
  previous?: ParentRef;
}

/**
 * The parent `agents send` links the target to: the resolved caller (or the
 * `from=` key) when that is a live agent other than the target's current
 * parent, so a follow-up from a new session moves the target under it.
 * Otherwise the current parent, whose forwarder is re-checked before the
 * turn starts: with `from=none`, when the caller cannot be resolved, or when
 * linking would make the target its own ancestor.
 */
export async function parentForSend(
  target: Agent,
  agents: Agent[],
  from: FromSpec,
  dependencies: Pick<ControlDependencies, "callerContext">,
): Promise<SendLink | undefined> {
  const current = target.delegator ?? undefined;
  const parent = await resolveParent(from, agents, dependencies);
  if (!parent || parent.key === target.key || wouldCycle(agents, parent.key, target.key)) {
    return current && { parent: current };
  }
  if (current?.key === parent.key) return { parent: parentRefOf(parent) };
  return { parent: parentRefOf(parent), previous: current };
}

export async function sendToAgent(
  key: string,
  text: string,
  dependencies: ControlDependencies,
  from: FromSpec = "auto",
): Promise<Agent> {
  const { agents } = await dependencies.inventory();
  const agent = agents.find((candidate) => candidate.key === key);
  if (!agent) throw new AgentNotFoundError(key);
  if (BUSY_STATES.includes(agent.state)) throw new AgentBusyError(agent);
  const link = await parentForSend(agent, agents, from, dependencies);
  // Link (or re-check the forwarder) before sending, so the turn this send
  // starts is pushed to the parent.
  if (link) {
    const warn = dependencies.warn ?? defaultWarn;
    const warnings = await linkChild(link.parent, childRefOf(agent), dependencies.link);
    for (const warning of warnings) warn(warning);
    // Installing the new forwarder replaced the old one; drop the target from
    // the parents it left. If the link failed, the old parent keeps it.
    if (link.previous && warnings.length === 0) {
      for (const old of agents) {
        if (old.key === link.parent.key || !old.children.some((entry) => entry.key === key)) continue;
        const result = await (dependencies.link?.unregister ?? unregisterCcDelegate)(old.socketPath, old.outputBufnr, key);
        if (!result.ok) warn(`${key} is still listed under ${old.key}: ${result.error || "unregister failed"}`);
      }
    }
  }
  const result = await (dependencies.send ?? sendCcPrompt)(agent.socketPath, agent.outputBufnr, text);
  if (!result.ok) throw new Error(result.error || "cc.nvim send_prompt failed");
  return agent;
}

export function lastLines(text: string, n: number | undefined): string {
  if (n === undefined) return text;
  const lines = text.replace(/\n$/, "").split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

export async function tailAgent(
  key: string,
  n: number | undefined,
  dependencies: ControlDependencies,
): Promise<string> {
  const agent = await findAgent(key, dependencies);
  const result = await (dependencies.lastMessage ?? getCcLastAssistantMessage)(agent.socketPath, agent.outputBufnr);
  if (result.text === null) throw new Error(result.error || "cc.nvim get_last_assistant_message failed");
  return lastLines(result.text, n);
}

export async function interruptAgent(key: string, dependencies: ControlDependencies): Promise<Agent> {
  const agent = await findAgent(key, dependencies);
  const result = await (dependencies.interrupt ?? interruptCcInstance)(agent.socketPath, agent.outputBufnr);
  if (!result.ok) throw new Error(`nothing interrupted for ${key}: ${result.error || "cc.nvim stop failed"}`);
  return agent;
}

export async function closeAgent(key: string, dependencies: ControlDependencies): Promise<Agent> {
  const agent = await findAgent(key, dependencies);
  const result = await (dependencies.close ?? closeCcInstance)(agent.socketPath, agent.outputBufnr);
  if (!result.ok) throw new Error(result.error || "cc.nvim close failed");
  return agent;
}

/**
 * Release an agent from its parent: remove its forwarders and the registry
 * entry in its own Neovim, and drop it from every parent that lists it.
 */
export async function detachAgent(key: string, dependencies: ControlDependencies): Promise<Agent> {
  const { agents } = await dependencies.inventory();
  const agent = agents.find((candidate) => candidate.key === key);
  if (!agent) throw new AgentNotFoundError(key);
  const parents = agents.filter((candidate) => candidate.children.some((entry) => entry.key === key));
  if (!agent.delegator && parents.length === 0) throw new Error(`agent ${key} has no parent to detach from`);
  const errors: string[] = [];
  const removed = await (dependencies.link?.uninstall ?? uninstallForwarder)(agent.socketPath, agent.outputBufnr);
  if (!removed.ok) errors.push(`forwarder: ${removed.error || "uninstall failed"}`);
  for (const parent of parents) {
    const result = await (dependencies.link?.unregister ?? unregisterCcDelegate)(parent.socketPath, parent.outputBufnr, key);
    if (!result.ok) errors.push(`${parent.key}: ${result.error || "unregister failed"}`);
  }
  if (errors.length) throw new Error(`detach incomplete: ${errors.join("; ")}`);
  return agent;
}
