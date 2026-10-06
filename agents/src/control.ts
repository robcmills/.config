import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { resolveCaller } from "./caller.ts";
import type { CallerContext } from "./caller.ts";
import {
  closeCcInstance,
  detachCcInstance,
  getCcLastAssistantMessage,
  interruptCcInstance,
  openCcInstance,
  sendCcPrompt,
} from "./cc-rpc.ts";
import type { CcDelegator, CcOpenOptions } from "./cc-rpc.ts";
import { toDelegator, wouldCycle } from "./delegation.ts";
import { discoverProcessParents } from "./discover-tmux.ts";
import type { Agent, AgentState, InventoryResult } from "./types.ts";

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
  detach?: typeof detachCcInstance;
  callerContext?: () => Promise<CallerContext>;
}

/** Who a new or re-engaged agent reports to: the resolved caller, nobody, or an explicit agent key. */
export type FromSpec = "auto" | "none" | { key: string };

export function parseFrom(value: string | undefined): FromSpec {
  if (value === undefined || value === "auto") return "auto";
  if (value === "none") return "none";
  if (KEY_PATTERN.test(value)) return { key: value };
  throw new Error(`invalid value for 'from=': expected auto, none, or an agent key, got '${value}'`);
}

export interface NewAgentOptions extends Omit<CcOpenOptions, "cwd" | "delegator"> {
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
): Promise<CcDelegator | undefined> {
  if (from === "none" || !dependencies.inventory) return undefined;
  let agents: Agent[];
  try {
    agents = (await dependencies.inventory()).agents;
  } catch (error) {
    if (from !== "auto") throw error;
    return undefined;
  }
  const parent = await resolveParent(from, agents, dependencies);
  return parent ? toDelegator(parent) : undefined;
}

/**
 * Open a new cc.nvim instance and return its agent key. The parent is passed
 * into cc.open so cc.nvim records the link before the first prompt is sent;
 * linking afterwards would race a fast child.
 */
export async function newAgent(
  options: NewAgentOptions,
  dependencies: Partial<Pick<ControlDependencies, "open" | "inventory" | "callerContext">> = {},
): Promise<string> {
  const cwd = resolve(options.cwd);
  if (!isDirectory(cwd)) throw new Error(`cwd is not a directory: ${options.cwd}`);
  if (!existsSync(options.socket)) throw new Error(`socket not found: ${options.socket}`);
  const { socket, cwd: _ignored, from = "auto", ...rest } = options;
  const delegator = await parentForNew(from, dependencies);
  const result = await (dependencies.open ?? openCcInstance)(socket, { ...rest, cwd, ...(delegator ? { delegator } : {}) });
  if (!result.ok || result.bufnr === undefined || result.pid === undefined) {
    throw new Error(result.error || "cc.nvim open failed");
  }
  return `${result.pid}:${result.bufnr}`;
}

/**
 * The parent `agents send` offers the target: only when the target has no
 * owner yet, and never itself or one of its own ancestors.
 */
export async function parentForSend(
  target: Agent,
  agents: Agent[],
  from: FromSpec,
  dependencies: Pick<ControlDependencies, "callerContext">,
): Promise<CcDelegator | undefined> {
  if (target.delegator) return undefined;
  const parent = await resolveParent(from, agents, dependencies);
  if (!parent || parent.key === target.key || wouldCycle(agents, parent.key, target.key)) return undefined;
  return toDelegator(parent);
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
  const delegator = await parentForSend(agent, agents, from, dependencies);
  const send = dependencies.send ?? sendCcPrompt;
  const result = delegator
    ? await send(agent.socketPath, agent.outputBufnr, text, undefined, undefined, delegator)
    : await send(agent.socketPath, agent.outputBufnr, text);
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

/** Release an agent's link to its parent, so its turns no longer count there. */
export async function detachAgent(key: string, dependencies: ControlDependencies): Promise<Agent> {
  const agent = await findAgent(key, dependencies);
  if (!agent.delegator) throw new Error(`agent ${key} has no parent to detach from`);
  const result = await (dependencies.detach ?? detachCcInstance)(agent.socketPath, agent.outputBufnr);
  if (!result.ok) throw new Error(result.error || "cc.nvim detach failed");
  return agent;
}
