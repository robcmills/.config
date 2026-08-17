import { formatPickerTable } from "./format.ts";
import type { Agent } from "./types.ts";

export async function pickAgent(agents: Agent[]): Promise<string | null> {
  const { header, rows } = formatPickerTable(agents);
  const proc = Bun.spawn([
    "fzf",
    "--ansi",
    "--layout=reverse",
    "--delimiter=\t",
    "--with-nth=1",
    "--prompt=Select agent: ",
    `--header=${header}`,
  ], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  proc.stdin.write(rows.join("\n") + "\n");
  proc.stdin.end();
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) return null;
  const selected = output.trimEnd();
  const separator = selected.lastIndexOf("\t");
  return separator === -1 ? null : selected.slice(separator + 1);
}
