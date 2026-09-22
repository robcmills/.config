import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCcInstance } from "../src/cc-rpc.ts";
import { runCommand } from "../src/command.ts";

// A real headless Neovim whose `cc` module is a stub. Each call to the stub's
// `open` touches `openMarker`, so a test can assert whether it ran.
class FakeNeovim {
  readonly dir = mkdtempSync(join(tmpdir(), "agents-fake-nvim-"));
  readonly socket = join(this.dir, "nvim.sock");
  readonly openMarker = join(this.dir, "open-called");
  private proc: ReturnType<typeof Bun.spawn> | null = null;

  async start(ccModule: string): Promise<void> {
    const stub = join(this.dir, "cc.lua");
    writeFileSync(stub, `package.loaded['cc'] = (function() ${ccModule} end)()`);
    this.proc = Bun.spawn(
      ["nvim", "--headless", "--clean", "--listen", this.socket, "-c", `luafile ${stub}`],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    );
    const deadline = Date.now() + 5_000;
    while (!existsSync(this.socket)) {
      if (Date.now() > deadline) throw new Error("fake Neovim never opened its socket");
      await Bun.sleep(20);
    }
  }

  openWasCalled(): boolean {
    return existsSync(this.openMarker);
  }

  stop(): void {
    this.proc?.kill("SIGKILL");
    rmSync(this.dir, { recursive: true, force: true });
  }
}

const MARK_OPEN = (marker: string) => `local f = io.open('${marker}', 'w'); f:write('x'); f:close()`;

let fake: FakeNeovim | null = null;
afterEach(() => { fake?.stop(); fake = null; });

describe("open against a real Neovim", () => {
  test("refuses a stale cc.nvim without calling open, naming the restart", async () => {
    fake = new FakeNeovim();
    // Pre-agents-API cc.nvim: open() exists but returns nothing, there is no
    // send_prompt, and close() acts on the current instance with no parameter.
    await fake.start(`
      local M = {}
      function M.open(opts) ${MARK_OPEN(fake.openMarker)} end
      function M.close() end
      return M
    `);
    const result = await openCcInstance(fake.socket, { cwd: "/tmp", name: "probe" }, 5_000, runCommand);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("restart Neovim");
    expect(fake.openWasCalled()).toBe(false);
  });

  test("still refuses when only close() is old, before anything is created", async () => {
    fake = new FakeNeovim();
    await fake.start(`
      local M = {}
      function M.open(opts) ${MARK_OPEN(fake.openMarker)} return 3 end
      function M.send_prompt(bufnr, text) return true end
      function M.get_last_assistant_message(bufnr) return '' end
      function M.close() end
      return M
    `);
    const result = await openCcInstance(fake.socket, { cwd: "/tmp" }, 5_000, runCommand);
    expect(result.error).toContain("API unavailable");
    expect(fake.openWasCalled()).toBe(false);
  });

  test("calls open on a current cc.nvim and returns its buffer and pid", async () => {
    fake = new FakeNeovim();
    await fake.start(`
      local M = {}
      function M.open(opts) ${MARK_OPEN(fake.openMarker)} return 42 end
      function M.send_prompt(bufnr, text) return true end
      function M.get_last_assistant_message(bufnr) return '' end
      function M.close(bufnr) return true end
      return M
    `);
    const result = await openCcInstance(fake.socket, { cwd: "/tmp", focus: false }, 5_000, runCommand);
    expect(result.ok).toBe(true);
    expect(result.bufnr).toBe(42);
    expect(Number.isSafeInteger(result.pid)).toBe(true);
    expect(fake.openWasCalled()).toBe(true);
  });

  test("keeps the post-open buffer check for an open() that returns nothing", async () => {
    fake = new FakeNeovim();
    await fake.start(`
      local M = {}
      function M.open(opts) ${MARK_OPEN(fake.openMarker)} end
      function M.send_prompt(bufnr, text) return true end
      function M.get_last_assistant_message(bufnr) return '' end
      function M.close(bufnr) return true end
      return M
    `);
    const result = await openCcInstance(fake.socket, { cwd: "/tmp" }, 5_000, runCommand);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("returned no buffer");
    expect(fake.openWasCalled()).toBe(true);
  });
});
