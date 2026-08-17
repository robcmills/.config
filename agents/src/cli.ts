import { formatTsv } from "./format.ts";
import { buildInventory } from "./inventory.ts";
import { pickAgent } from "./picker.ts";
import { validateConfig } from "./sort.ts";
import { focusAndSwitch } from "./switch.ts";

const HELP = `Usage:
  agents                 Print live agents as stable TSV
  agents --json          Print live agents as JSON
  agents -i              Pick and switch to a live agent
  agents switch <key>    Switch directly to one live agent
  agents --help          Show this help`;

function stderr(message: string) {
  console.error(`agents: ${message}`);
}

async function inventory() {
  let config;
  try {
    const configSource = (await import("../config.ts")).default as unknown;
    config = validateConfig(configSource);
  } catch (error) {
    throw new Error(`invalid config: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = await buildInventory(config);
  for (const warning of result.warnings) stderr(`warning: ${warning}`);
  return result.agents;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
      console.log(HELP);
      return 0;
    }
    if (args.length === 0 || (args.length === 1 && args[0] === "--json")) {
      const agents = await inventory();
      if (args[0] === "--json") console.log(JSON.stringify(agents, null, 2));
      else {
        const output = formatTsv(agents);
        if (output) console.log(output);
      }
      return 0;
    }
    if (args.length === 1 && args[0] === "-i") {
      const agents = await inventory();
      if (agents.length === 0) {
        console.log("No running cc.nvim agents.");
        return 0;
      }
      const key = await pickAgent(agents);
      if (key === null) return 0;
      const agent = agents.find((candidate) => candidate.key === key);
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
      const agents = await inventory();
      const agent = agents.find((candidate) => candidate.key === key);
      if (!agent) {
        stderr(`live agent not found: ${key}`);
        return 1;
      }
      await focusAndSwitch(agent);
      return 0;
    }
    stderr("invalid arguments\n" + HELP);
    return 2;
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
