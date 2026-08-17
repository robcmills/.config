import { focusCcInstance } from "./cc-rpc.ts";
import { runCommand } from "./command.ts";
import type { Agent, CommandRunner } from "./types.ts";

function targetDescription(agent: Agent): string {
  return `session=${agent.tmuxSessionId ?? "?"} window=${agent.tmuxWindowId ?? "?"} pane=${agent.tmuxPaneId ?? "?"}`;
}

export async function switchTmux(agent: Agent, run: CommandRunner = runCommand): Promise<void> {
  if (!process.env.TMUX) {
    throw new Error(`switching requires running inside tmux; target ${targetDescription(agent)}`);
  }
  if (!agent.tmuxSessionId || !agent.tmuxWindowId || !agent.tmuxPaneId) {
    throw new Error(`no unambiguous tmux pane found; target ${targetDescription(agent)}`);
  }
  for (const args of [
    ["tmux", "switch-client", "-t", agent.tmuxSessionId],
    ["tmux", "select-window", "-t", agent.tmuxWindowId],
    ["tmux", "select-pane", "-t", agent.tmuxPaneId],
  ]) {
    const result = await run(args, 1_500);
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`${args[1]} failed for ${targetDescription(agent)}: ${result.stderr.trim() || (result.timedOut ? "timed out" : `exit ${result.exitCode}`)}`);
    }
  }
}

export interface SwitchDependencies {
  focus?: typeof focusCcInstance;
  switchTmux?: typeof switchTmux;
}

export async function focusAndSwitch(
  agent: Agent,
  dependencies: SwitchDependencies = {},
): Promise<void> {
  const result = await (dependencies.focus ?? focusCcInstance)(agent.socketPath, agent.outputBufnr);
  if (!result.ok) throw new Error(result.error || "agent disappeared before it could be focused");
  try {
    await (dependencies.switchTmux ?? switchTmux)(agent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cc.nvim focused ${agent.key}, but tmux switching failed: ${message}`);
  }
}
