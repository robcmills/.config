import { formatPickerTable } from "./format.ts";
import type { Agent } from "./types.ts";

export const PICKER_ROWS_FLAG = "--picker-rows";
const REFRESH_SECONDS = 10;
const AGENTS_BIN = `${import.meta.dir}/../bin/agents`;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The header line followed by the rows, as fzf reads them with --header-lines=1. */
export function formatPickerLines(agents: Agent[]): string {
  const { header, rows } = formatPickerTable(agents);
  return [header, ...rows].join("\n") + "\n";
}

/**
 * reload-sync keeps the old list until the new one is ready. With --track it
 * also blocks input until the reload finishes, so the command must not sleep.
 */
export function pickerRefreshBinding(bin = AGENTS_BIN): string {
  return `every(${REFRESH_SECONDS}):reload-sync(${shellQuote(bin)} ${PICKER_ROWS_FLAG})`;
}

export function pickerWarningSummary(warningCount: number): string | null {
  if (warningCount <= 0) return null;
  const noun = warningCount === 1 ? "warning" : "warnings";
  return `⚠ ${warningCount} inventory ${noun} · details: agents doctor`;
}

export async function pickAgent(agents: Agent[], warningCount = 0): Promise<string | null> {
  const warning = pickerWarningSummary(warningCount);
  const args = [
    "fzf",
    "--ansi",
    "--layout=reverse",
    "--delimiter=\t",
    "--with-nth=1",
    "--id-nth=2",
    "--prompt=Select agent: ",
    "--header-lines=1",
    "--track",
    `--bind=${pickerRefreshBinding()}`,
  ];
  if (warning) {
    args.push(
      "--border=bottom",
      `--border-label=${warning}`,
      "--border-label-pos=2:bottom",
    );
  }
  const proc = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(formatPickerLines(agents));
  proc.stdin.end();
  const [output, errorOutput, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode === 1 || exitCode === 130) return null;
  if (exitCode !== 0) {
    throw new Error(`fzf failed: ${errorOutput.trim() || `exit ${exitCode}`}`);
  }
  const selected = output.trimEnd();
  const separator = selected.lastIndexOf("\t");
  return separator === -1 ? null : selected.slice(separator + 1);
}
