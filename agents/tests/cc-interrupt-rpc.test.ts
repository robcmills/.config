import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interruptCcInstance } from "../src/cc-rpc.ts";
import { runCommand } from "../src/command.ts";

// A real headless Neovim whose `cc` module is a stub. The stub's `stop`
// writes its argument to `stopMarker`, so a test can see whether and how it
// was called.
class FakeNeovim {
  readonly dir = mkdtempSync(join(tmpdir(), "agents-fake-nvim-"));
  readonly socket = join(this.dir, "nvim.sock");
  readonly stopMarker = join(this.dir, "stop-called");
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

  stopArgument(): string | null {
    return existsSync(this.stopMarker) ? readFileSync(this.stopMarker, "utf8") : null;
  }

  kill(): void {
    this.proc?.kill("SIGKILL");
    rmSync(this.dir, { recursive: true, force: true });
  }
}

const MARK_STOP = (marker: string) => `local f = io.open('${marker}', 'w'); f:write(tostring(bufnr)); f:close()`;

let fake: FakeNeovim | null = null;
afterEach(() => { fake?.kill(); fake = null; });

describe("interrupt against a real Neovim", () => {
  test("refuses an old stop() that would interrupt the focused instance", async () => {
    fake = new FakeNeovim();
    // Pre-bufnr cc.nvim: stop() takes no parameter and acts on the current buffer.
    await fake.start(`
      local M = {}
      function M.stop() local bufnr = 'current'; ${MARK_STOP(fake.stopMarker)} end
      return M
    `);
    const result = await interruptCcInstance(fake.socket, 7, 5_000, runCommand);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("restart Neovim");
    expect(fake.stopArgument()).toBeNull();
  });

  test("passes the buffer to a current stop() and reports success", async () => {
    fake = new FakeNeovim();
    await fake.start(`
      local M = {}
      function M.stop(bufnr) ${MARK_STOP(fake.stopMarker)} return true end
      return M
    `);
    expect(await interruptCcInstance(fake.socket, 7, 5_000, runCommand)).toEqual({ ok: true });
    expect(fake.stopArgument()).toBe("7");
  });

  test("surfaces the reason when stop() sends nothing", async () => {
    fake = new FakeNeovim();
    await fake.start(`
      local M = {}
      function M.stop(bufnr) return false, 'interrupt already pending' end
      return M
    `);
    expect(await interruptCcInstance(fake.socket, 7, 5_000, runCommand))
      .toEqual({ ok: false, error: "interrupt already pending" });
  });
});
