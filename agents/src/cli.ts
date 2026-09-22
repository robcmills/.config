import { readFileSync } from "node:fs";
import { parseBoolean, parseNamedArgs, parsePositiveInteger, requireArg } from "./args.ts";
import type { NamedArgs } from "./args.ts";
import { closeAgent, KEY_PATTERN, newAgent, sendToAgent, tailAgent } from "./control.ts";
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
  agents switch key=<k>  Same, named form
  agents doctor          Print complete inventory diagnostics
  agents --help          Show this help

  agents new socket=<path> cwd=<dir> [prompt=<text>|prompt-file=<path>]
             [model=<m>] [effort=<e>] [name=<n>] [provider=claude|codex]
             [focus=true|false]
                         Open a cc.nvim instance in that Neovim; prints its key
  agents send key=<k> prompt=<text>|prompt-file=<path>
                         Queue a prompt; refuses while the agent is mid-turn
  agents tail key=<k> [n=<lines>]
                         Print the agent's last assistant message
  agents close key=<k>   Close the agent

Keys are <nvim-pid>:<output-bufnr>, as printed by \`agents\`.`;

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
  if (args[0] === "switch") {
    const parsed = parseNamedArgs(args.slice(1), { keys: ["key"], allowPositional: true });
    const key = parsed.values.get("key") ?? parsed.positional[0];
    if (parsed.positional.length > 1 || (parsed.values.has("key") && parsed.positional.length > 0) || !key) {
      stderr("usage: agents switch <key> | agents switch key=<k>");
      return 2;
    }
    if (!validKey(key)) return 2;
    const result = await inventory();
    const agent = result.agents.find((candidate) => candidate.key === key);
    if (!agent) {
      stderr(`live agent not found: ${key}`);
      return 1;
    }
    await focusAndSwitch(agent);
    return 0;
  }
  if (args[0] === "new") return runNew(args.slice(1));
  if (args[0] === "send") return runSend(args.slice(1));
  if (args[0] === "tail") return runTail(args.slice(1));
  if (args[0] === "close") return runClose(args.slice(1));
  stderr("invalid arguments\n" + HELP);
  return 2;
}

function validKey(key: string): boolean {
  if (KEY_PATTERN.test(key)) return true;
  stderr(`invalid agent key '${key}'; expected <nvim-pid>:<output-bufnr>`);
  return false;
}

/** Exactly one of prompt= / prompt-file=. Returns undefined when neither is given. */
function readPrompt(parsed: NamedArgs): string | undefined {
  const inline = parsed.values.get("prompt");
  const file = parsed.values.get("prompt-file");
  if (inline !== undefined && file !== undefined) {
    throw new Error("pass either prompt= or prompt-file=, not both");
  }
  if (file !== undefined) {
    try {
      return readFileSync(file, "utf8");
    } catch (error) {
      throw new Error(`cannot read prompt-file '${file}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return inline;
}

const controlDependencies = { inventory: () => inventory() };

async function runNew(args: string[]): Promise<number> {
  const parsed = parseNamedArgs(args, {
    keys: ["socket", "cwd", "prompt", "prompt-file", "model", "effort", "name", "provider", "focus"],
  });
  const provider = parsed.values.get("provider");
  if (provider !== undefined && provider !== "claude" && provider !== "codex") {
    stderr(`invalid provider '${provider}'; expected claude or codex`);
    return 2;
  }
  const key = await newAgent({
    socket: requireArg(parsed, "socket"),
    cwd: requireArg(parsed, "cwd"),
    prompt: readPrompt(parsed),
    model: parsed.values.get("model"),
    effort: parsed.values.get("effort"),
    name: parsed.values.get("name"),
    provider,
    focus: parseBoolean(parsed.values.get("focus"), "focus"),
  });
  console.log(key);
  return 0;
}

async function runSend(args: string[]): Promise<number> {
  const parsed = parseNamedArgs(args, { keys: ["key", "prompt", "prompt-file"] });
  const key = requireArg(parsed, "key");
  if (!validKey(key)) return 2;
  const text = readPrompt(parsed);
  if (text === undefined) throw new Error("missing required argument 'prompt=' or 'prompt-file='");
  await sendToAgent(key, text, controlDependencies);
  return 0;
}

async function runTail(args: string[]): Promise<number> {
  const parsed = parseNamedArgs(args, { keys: ["key", "n"] });
  const key = requireArg(parsed, "key");
  if (!validKey(key)) return 2;
  const text = await tailAgent(key, parsePositiveInteger(parsed.values.get("n"), "n"), controlDependencies);
  console.log(text);
  return 0;
}

async function runClose(args: string[]): Promise<number> {
  const parsed = parseNamedArgs(args, { keys: ["key"] });
  const key = requireArg(parsed, "key");
  if (!validKey(key)) return 2;
  await closeAgent(key, controlDependencies);
  return 0;
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
