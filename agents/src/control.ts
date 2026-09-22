import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  closeCcInstance,
  getCcLastAssistantMessage,
  openCcInstance,
  sendCcPrompt,
} from "./cc-rpc.ts";
import type { CcOpenOptions } from "./cc-rpc.ts";
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
}

export interface NewAgentOptions extends Omit<CcOpenOptions, "cwd"> {
  socket: string;
  cwd: string;
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

/** Open a new cc.nvim instance and return its agent key. */
export async function newAgent(
  options: NewAgentOptions,
  dependencies: Pick<ControlDependencies, "open"> = {},
): Promise<string> {
  const cwd = resolve(options.cwd);
  if (!isDirectory(cwd)) throw new Error(`cwd is not a directory: ${options.cwd}`);
  if (!existsSync(options.socket)) throw new Error(`socket not found: ${options.socket}`);
  const { socket, cwd: _ignored, ...rest } = options;
  const result = await (dependencies.open ?? openCcInstance)(socket, { ...rest, cwd });
  if (!result.ok || result.bufnr === undefined || result.pid === undefined) {
    throw new Error(result.error || "cc.nvim open failed");
  }
  return `${result.pid}:${result.bufnr}`;
}

export async function sendToAgent(
  key: string,
  text: string,
  dependencies: ControlDependencies,
): Promise<Agent> {
  const agent = await findAgent(key, dependencies);
  if (BUSY_STATES.includes(agent.state)) throw new AgentBusyError(agent);
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

export async function closeAgent(key: string, dependencies: ControlDependencies): Promise<Agent> {
  const agent = await findAgent(key, dependencies);
  const result = await (dependencies.close ?? closeCcInstance)(agent.socketPath, agent.outputBufnr);
  if (!result.ok) throw new Error(result.error || "cc.nvim close failed");
  return agent;
}
