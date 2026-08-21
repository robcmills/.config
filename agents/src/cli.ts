import { formatTsv } from "./format.ts";
import { buildInventory } from "./inventory.ts";
import { pickAgent } from "./picker.ts";
import { validateConfig } from "./sort.ts";
import { emptyInventoryWarningNotification, focusAndSwitch, notifyTmux } from "./switch.ts";
import type { InventoryResult } from "./types.ts";

const HELP = `Usage:
  agents                 Print live agents as stable TSV
  agents --json          Print live agents as JSON
  agents -i              Pick and switch to a live agent
  agents -i --pause-on-error
                         Keep an interactive popup open on fatal errors
  agents switch <key>    Switch directly to one live agent
  agents doctor          Print complete inventory diagnostics
  agents --help          Show this help`;

function stderr(message: string) {
  console.error(`agents: ${message}`);
}

async function inventory(emitWarnings = true): Promise<InventoryResult> {
  let config;
  try {
    const configSource = (await import("../config.ts")).default as unknown;
    config = validateConfig(configSource);
  } catch (error) {
    throw new Error(`invalid config: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = await buildInventory(config);
  if (emitWarnings) {
    for (const warning of result.warnings) stderr(`warning: ${warning}`);
  }
  return result;
}

async function pauseForAcknowledgement(): Promise<void> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") return;
  console.error("\nPress Enter or Escape to close.");
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  await new Promise<void>((resolve) => {
    const onData = (chunk: Buffer | string) => {
      const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (![...data].some((byte) => byte === 10 || byte === 13 || byte === 27)) return;
      process.stdin.off("data", onData);
      resolve();
    };
    process.stdin.on("data", onData);
  });
  process.stdin.setRawMode(Boolean(wasRaw));
  if (!wasRaw) process.stdin.pause();
}

function printDoctor(result: InventoryResult): void {
  console.log(`Switchable agents: ${result.agents.length}`);
  if (result.warnings.length === 0) {
    console.log("Inventory warnings: none");
    return;
  }
  console.log(`Inventory warnings: ${result.warnings.length}`);
  result.warnings.forEach((warning, index) => {
    console.log(`\n${index + 1}. ${warning}`);
  });
}

async function run(args: string[]): Promise<number> {
  if (args.includes("--pause-on-error")) {
    args = args.filter((arg) => arg !== "--pause-on-error");
  }
  if (args.length === 1 && args[0] === "doctor") {
    printDoctor(await inventory(false));
    return 0;
  }
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(HELP);
    return 0;
  }
  if (args.length === 0 || (args.length === 1 && args[0] === "--json")) {
    const result = await inventory();
    if (args[0] === "--json") console.log(JSON.stringify(result.agents, null, 2));
    else {
      const output = formatTsv(result.agents);
      if (output) console.log(output);
    }
    return 0;
  }
  if (args.length === 1 && args[0] === "-i") {
    const result = await inventory(false);
    if (result.agents.length === 0) {
      if (result.warnings.length > 0) {
        await notifyTmux(emptyInventoryWarningNotification(result.warnings.length));
      } else {
        await notifyTmux("agents: no running cc.nvim agents");
      }
      return 0;
    }
    const key = await pickAgent(result.agents, result.warnings.length);
    if (key === null) return 0;
    const agent = result.agents.find((candidate) => candidate.key === key);
    if (!agent) throw new Error(`picker returned an unknown agent key: ${key}`);
    // focus_instance verifies that the selected agent still exists, so a
    // second full inventory would only duplicate discovery and RPC work.
    await focusAndSwitch(agent);
    return 0;
  }
  if (args.length === 2 && args[0] === "switch") {
    const key = args[1]!;
    if (!/^\d+:\d+$/.test(key)) {
      stderr(`invalid agent key '${key}'; expected <nvim-pid>:<output-bufnr>`);
      return 2;
    }
    const result = await inventory();
    const agent = result.agents.find((candidate) => candidate.key === key);
    if (!agent) {
      stderr(`live agent not found: ${key}`);
      return 1;
    }
    await focusAndSwitch(agent);
    return 0;
  }
  stderr("invalid arguments\n" + HELP);
  return 2;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const pauseOnError = args.includes("--pause-on-error");
  try {
    const exitCode = await run(args);
    if (pauseOnError && exitCode !== 0) await pauseForAcknowledgement();
    return exitCode;
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    if (pauseOnError) await pauseForAcknowledgement();
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
