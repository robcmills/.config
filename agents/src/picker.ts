import { formatPickerTable } from "./format.ts";
import type { Agent } from "./types.ts";

export function pickerWarningSummary(warningCount: number): string | null {
  if (warningCount <= 0) return null;
  const noun = warningCount === 1 ? "warning" : "warnings";
  return `⚠ ${warningCount} inventory ${noun} · details: agents doctor`;
}

export async function pickAgent(agents: Agent[], warningCount = 0): Promise<string | null> {
  const { header, rows } = formatPickerTable(agents);
  const warning = pickerWarningSummary(warningCount);
  const args = [
    "fzf",
    "--ansi",
    "--layout=reverse",
    "--delimiter=\t",
    "--with-nth=1",
    "--prompt=Select agent: ",
    `--header=${header}`,
  ];
  if (warning) {
    args.push(
      "--border=bottom",
      `--border-label=${warning}`,
      "--border-label-pos=2:bottom",
    );
  }
  const proc = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(rows.join("\n") + "\n");
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
