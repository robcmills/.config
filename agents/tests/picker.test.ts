import { afterEach, expect, test } from "bun:test";
import { connect } from "node:net";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/command.ts";
import {
  createCoalescer, openPickerSession, pickerArgs, pickerDir, pruneStalePickers, resolvePicked,
} from "../src/picker.ts";
import type { PickerSession } from "../src/picker.ts";
import { agent } from "./fixtures.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-picker-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

test("coalescer does nothing until fzf is ready and something changed", async () => {
  let runs = 0;
  const c = createCoalescer(async () => { runs++; });
  c.changed();
  await c.settled();
  expect(runs).toBe(0);
  c.ready();
  await c.settled();
  expect(runs).toBe(1);
  // Idle: no change, no work.
  c.ready();
  await c.settled();
  expect(runs).toBe(1);
});

test("changes during a refresh collapse into one rerun", async () => {
  const gates = [deferred(), deferred()];
  let runs = 0;
  const c = createCoalescer(() => gates[runs++]!.promise);
  c.ready();
  c.changed();
  expect(runs).toBe(1);
  c.changed();
  c.changed();
  c.changed();
  expect(runs).toBe(1);
  gates[0]!.resolve();
  await until(() => runs === 2, "the rerun");
  gates[1]!.resolve();
  await c.settled();
  expect(runs).toBe(2);
});

test("a failed refresh does not wedge the coalescer, and stop ends refreshes", async () => {
  let runs = 0;
  const c = createCoalescer(async () => {
    runs++;
    throw new Error("inventory failed");
  });
  c.ready();
  c.changed();
  await c.settled();
  c.changed();
  await c.settled();
  expect(runs).toBe(2);
  c.stop();
  c.changed();
  await c.settled();
  expect(runs).toBe(2);
});

/** Connect and hang up, as picker-notify.lua does. */
function poke(socket: string, data?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = connect(socket, () => {
      if (data) client.write(data);
      client.end();
    });
    client.on("close", () => resolve());
    client.on("error", reject);
  });
}

function session(dir: string, inventory: () => Promise<ReturnType<typeof agent>[]>) {
  const posts: { socket: string; action: string }[] = [];
  const s = openPickerSession({
    dir, pid: 4242, inventory, alive: () => true,
    post: async (socket, action) => { posts.push({ socket, action }); },
  });
  cleanup.push(() => s.close());
  return { s, posts };
}

test("a session refreshes fzf from the rows file on a change after ready", async () => {
  const dir = tempDir();
  let inventories = 0;
  const { s, posts } = session(dir, async () => {
    inventories++;
    return [agent({ key: "100:7", name: "fresh" })];
  });
  expect(s.socketPath).toBe(join(dir, "4242.sock"));
  await poke(s.socketPath);
  await s.coalescer.settled();
  expect(inventories).toBe(0);
  await poke(s.socketPath, "ready");
  await until(() => posts.length === 1, "the push");
  await s.coalescer.settled();
  expect(posts[0]).toEqual({ socket: join(dir, "4242.fzf.sock"), action: `reload-sync(cat '${join(dir, "4242.rows")}')` });
  expect(readFileSync(s.rowsPath, "utf8")).toContain("fresh");
  expect(s.latest()?.map((a) => a.key)).toEqual(["100:7"]);
  // Ready with nothing new: no inventory.
  await poke(s.socketPath, "ready");
  await s.coalescer.settled();
  expect(inventories).toBe(1);
});

test("closing a session deletes its files and stops listening", async () => {
  const dir = tempDir();
  const { s } = session(dir, async () => []);
  writeFileSync(s.rowsPath, "rows");
  s.close();
  s.close();
  expect(readdirSync(dir)).toEqual([]);
  await expect(poke(s.socketPath)).rejects.toThrow();
});

test("stale files of dead popups are pruned, live and foreign ones kept", () => {
  const dir = tempDir();
  for (const name of ["11.sock", "11.fzf.sock", "11.rows", "22.sock", "notes.txt"]) writeFileSync(join(dir, name), "");
  pruneStalePickers(dir, (pid) => pid === 22);
  expect(readdirSync(dir).sort()).toEqual(["22.sock", "notes.txt"]);
  pruneStalePickers(join(dir, "missing"));
});

test("picker dir honors AGENTS_PICKER_DIR, else a per-user /tmp dir", () => {
  expect(pickerDir({ AGENTS_PICKER_DIR: "/x" })).toBe("/x");
  expect(pickerDir({ USER: "rob" })).toBe("/tmp/agents-picker.rob");
});

test("fzf args: no timer, a ctrl-r refresh, and a listen socket plus ready probe", () => {
  const args = pickerArgs(0, { socketPath: "/d/1.sock", fzfSocketPath: "/d/1.fzf.sock" } as PickerSession, "/bin/agents");
  expect(args.join(" ")).not.toContain("every(");
  expect(args).toContain("--bind=ctrl-r:reload-sync('/bin/agents' --picker-rows)");
  expect(args).toContain("--header=ctrl-r refresh");
  expect(args).toContain("--listen=/d/1.fzf.sock");
  expect(args).toContain("--bind=start:execute-silent(printf ready | nc -U '/d/1.sock' >/dev/null 2>&1)");
  expect(pickerArgs(0, undefined, "/bin/agents").some((arg) => arg.startsWith("--listen"))).toBe(false);
});

test("a picked key resolves from the latest rows, then the opening rows, then a fresh inventory", async () => {
  const opened = [agent({ key: "1:1", name: "opened" })];
  const latest = [agent({ key: "2:2", name: "latest" })];
  let fresh = 0;
  const freshInventory = async () => {
    fresh++;
    return [agent({ key: "3:3", name: "fresh" })];
  };
  expect((await resolvePicked("2:2", [latest, opened], freshInventory))?.name).toBe("latest");
  expect((await resolvePicked("1:1", [null, opened], freshInventory))?.name).toBe("opened");
  expect(fresh).toBe(0);
  expect((await resolvePicked("3:3", [latest, opened], freshInventory))?.name).toBe("fresh");
  expect(await resolvePicked("9:9", [latest, opened], freshInventory)).toBeNull();
});

test("picker-notify.lua pokes open popups on CcStateChanged, from a real Neovim", async () => {
  const dir = tempDir();
  const { s } = session(dir, async () => [agent()]);
  // Leftovers the notifier must skip or survive: fzf's socket, a dead popup's socket.
  writeFileSync(join(dir, "4242.fzf.sock"), "");
  writeFileSync(join(dir, "999999.sock"), "");
  let changes = 0;
  const original = s.coalescer.changed;
  s.coalescer.changed = () => { changes++; original(); };

  const nvimDir = tempDir();
  const socket = join(nvimDir, "nvim.sock");
  const notifier = join(import.meta.dir, "../src/picker-notify.lua");
  const proc = Bun.spawn(["nvim", "--headless", "--clean", "--listen", socket, "-c", `luafile ${notifier}`], {
    stdout: "ignore", stderr: "ignore", stdin: "ignore",
    env: { ...process.env, AGENTS_PICKER_DIR: dir },
  });
  cleanup.unshift(() => proc.kill("SIGKILL"));
  await until(() => existsSync(socket), "Neovim's socket");

  const fire = (event: string) => runCommand(["nvim", "--server", socket, "--remote-expr",
    `luaeval("vim.api.nvim_exec_autocmds('User', { pattern = '${event}', data = { bufnr = 5, state = 'working' } }) or 1")`], 2_000);
  expect((await fire("SomethingElse")).exitCode).toBe(0);
  expect((await fire("CcStateChanged")).exitCode).toBe(0);
  await until(() => changes === 1, "the poke");
  await Bun.sleep(50);
  expect(changes).toBe(1);

  // With no popup open the event is a no-op.
  s.close();
  expect((await fire("CcStateChanged")).exitCode).toBe(0);
  rmSync(dir, { recursive: true, force: true });
  expect((await fire("CcStateChanged")).exitCode).toBe(0);
});
