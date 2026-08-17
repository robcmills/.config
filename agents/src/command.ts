import type { CommandResult, CommandRunner } from "./types.ts";

export const runCommand: CommandRunner = async (
  args: string[],
  timeoutMs = 2_000,
): Promise<CommandResult> => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 127,
      timedOut: false,
    };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {}
  }, timeoutMs);

  const stdoutPromise = typeof proc.stdout === "number" || proc.stdout === undefined
    ? Promise.resolve("")
    : new Response(proc.stdout).text();
  const stderrPromise = typeof proc.stderr === "number" || proc.stderr === undefined
    ? Promise.resolve("")
    : new Response(proc.stderr).text();
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    stdoutPromise,
    stderrPromise,
  ]);
  clearTimeout(timer);
  return { stdout, stderr, exitCode, timedOut };
};
