import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installForwarder, queryCcInstances, registerCcDelegate, uninstallForwarder, unregisterCcDelegate,
} from "../src/cc-rpc.ts";
import { runCommand } from "../src/command.ts";

// Real headless Neovims with stub modules. The child stub has only what
// cc.nvim main (05106da) offers: list_instances, cc.state_events, and the
// User CcStateChanged event. The parent stub records what reaches
// cc.delegation._remote.
const started: { proc: ReturnType<typeof Bun.spawn>; dir: string }[] = [];
afterEach(() => {
  for (const { proc, dir } of started.splice(0)) { proc.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); }
});

async function neovim(lua: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "agents-fwd-"));
  const socket = join(dir, "nvim.sock");
  const init = join(dir, "init.lua");
  writeFileSync(init, lua);
  const proc = Bun.spawn(["nvim", "--headless", "--clean", "--listen", socket, "-c", `luafile ${init}`], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  started.push({ proc, dir });
  const deadline = Date.now() + 5_000;
  while (!existsSync(socket)) {
    if (Date.now() > deadline) throw new Error("Neovim never opened its socket");
    await Bun.sleep(20);
  }
  return socket;
}

const CHILD = (withEvents = true) => `
  _G.state = 'starting'
  package.loaded['cc'] = { list_instances = function() return { { outputBufnr = 5, promptBufnr = 6, state = _G.state, sessionId = 'child-sid', name = vim.NIL, provider = 'claude', model = vim.NIL, cwd = '/tmp', pid = vim.NIL, turnElapsedMs = vim.NIL } } end }
  ${withEvents ? "package.loaded['cc.state_events'] = {}" : ""}
  function _G.fire(bufnr, state, closed)
    _G.state = state
    vim.api.nvim_exec_autocmds('User', { pattern = 'CcStateChanged', data = { bufnr = bufnr, state = state, closed = closed } })
  end
`;
const PARENT = `
  _G.got = {}
  package.loaded['cc.delegation'] = { _remote = function(method, p) table.insert(_G.got, { method = method, state = p.state, seq = p.seq, key = p.key, parent_bufnr = p.parent_bufnr, session_id = p.session_id }) end }
`;

async function expr(socket: string, lua: string): Promise<string> {
  const result = await runCommand(["nvim", "--server", socket, "--remote-expr", `luaeval("${lua}")`], 2_000);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function received(socket: string, count: number): Promise<{ state: string; seq: number; key: string; parent_bufnr: number; session_id?: string }[]> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const got = JSON.parse(await expr(socket, "vim.json.encode(_G.got)")) as unknown;
    const list = Array.isArray(got) ? got as { state: string; seq: number; key: string; parent_bufnr: number }[] : [];
    if (list.length >= count || Date.now() > deadline) return list;
    await Bun.sleep(20);
  }
}

test("the forwarder pushes the current state on install, then every transition of its child only", async () => {
  const [parentSocket, childSocket] = await Promise.all([neovim(PARENT), neovim(CHILD())]);
  const parent = { key: "1:2", socket: parentSocket, bufnr: 2, sessionId: "parent-sid" };
  expect(await installForwarder(childSocket, 5, "9:5", parent, 2_000)).toEqual({ ok: true });
  await expr(childSocket, "_G.fire(5, 'working')");
  await expr(childSocket, "_G.fire(6, 'working')");
  // Installing twice is harmless: still one push per transition.
  expect(await installForwarder(childSocket, 5, "9:5", parent, 2_000)).toEqual({ ok: true });
  await expr(childSocket, "_G.fire(5, 'unread')");
  const got = await received(parentSocket, 4);
  expect(got.map((p) => p.state)).toEqual(["starting", "working", "working", "unread"]);
  expect(got.map((p) => p.seq)).toEqual([1, 2, 3, 4]);
  expect(got[0]).toMatchObject({ key: "9:5", parent_bufnr: 2, session_id: "child-sid" });

  // The registry is readable by the inventory query.
  const listed = await queryCcInstances(childSocket, 2_000);
  expect(listed.forwarders).toEqual([{ name: expect.any(String), childBufnr: 5, childKey: "9:5", parent }]);

  // The parent's turn boundary asks for a re-push through the global.
  await expr(childSocket, "_G.cc_delegation_repush('1:2')");
  expect((await received(parentSocket, 5)).at(-1)?.state).toBe("unread");

  expect(await uninstallForwarder(childSocket, 5, undefined, 2_000)).toEqual({ ok: true });
  await expr(childSocket, "_G.fire(5, 'working')");
  await Bun.sleep(150);
  expect(await received(parentSocket, 6)).toHaveLength(5);
  expect((await queryCcInstances(childSocket, 2_000)).forwarders).toEqual([]);
});

test("a closed event pushes exited and removes the forwarder", async () => {
  const [parentSocket, childSocket] = await Promise.all([neovim(PARENT), neovim(CHILD())]);
  await installForwarder(childSocket, 5, "9:5", { key: "1:2", socket: parentSocket, bufnr: 2, sessionId: null }, 2_000);
  await expr(childSocket, "_G.fire(5, 'exited', true)");
  expect((await received(parentSocket, 2)).map((p) => p.state)).toEqual(["starting", "exited"]);
  expect((await queryCcInstances(childSocket, 2_000)).forwarders).toEqual([]);
});

test("refuses a child Neovim without CcStateChanged, or without that buffer", async () => {
  const [parentSocket, oldChild, child] = await Promise.all([neovim(PARENT), neovim(CHILD(false)), neovim(CHILD())]);
  const parent = { key: "1:2", socket: parentSocket, bufnr: 2, sessionId: null };
  expect(await installForwarder(oldChild, 5, "9:5", parent, 2_000)).toEqual({ ok: false, error: "the child's cc.nvim has no CcStateChanged event" });
  expect(await installForwarder(child, 7, "9:7", parent, 2_000)).toEqual({ ok: false, error: "no cc.nvim instance owns buffer 7" });
});

test("register and unregister reach the parent's cc.delegation, and name a parent without it", async () => {
  const [parent, old] = await Promise.all([neovim(`
    _G.calls = {}
    package.loaded['cc.delegation'] = {
      register_bufnr = function(bufnr, child) table.insert(_G.calls, { 'register', bufnr, child.key, child.nvim_pid, child.state }) return true end,
      unregister_bufnr = function(bufnr, key) table.insert(_G.calls, { 'unregister', bufnr, key }) return true end,
    }
  `), neovim("")]);
  const child = { key: "9:5", socket: "/s", bufnr: 5, nvimPid: 9, sessionId: null, state: "starting" as const };
  expect(await registerCcDelegate(parent, 2, child, 2_000)).toEqual({ ok: true });
  expect(await unregisterCcDelegate(parent, 2, "9:5", 2_000)).toEqual({ ok: true });
  expect(JSON.parse(await expr(parent, "vim.json.encode(_G.calls)"))).toEqual([["register", 2, "9:5", 9, "starting"], ["unregister", 2, "9:5"]]);
  expect(await registerCcDelegate(old, 2, child, 2_000)).toEqual({
    ok: false, error: "the parent cc.nvim has no delegation receiver; update cc.nvim and restart Neovim",
  });
});
