import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentBusyError,
  AgentNotFoundError,
  closeAgent,
  detachAgent,
  interruptAgent,
  lastLines,
  newAgent,
  parseFrom,
  sendToAgent,
  tailAgent,
} from "../src/control.ts";
import type { AgentState } from "../src/types.ts";
import { agent } from "./fixtures.ts";

const inventoryWith = (state: AgentState) => async () => ({ agents: [agent({ state })], warnings: [] });
// No agent is an ancestor and Claude Code's env is empty: a plain shell.
const shell = async () => ({ self: 1_000_000, parents: new Map<number, number>(), env: {} });
// Agent 50:1 (pid 300) runs this process.
const jarvis = agent({ key: "50:1", nvimPid: 50, outputBufnr: 1, socketPath: "/nvim.50", pid: 300, sessionId: "J" });
const fromJarvis = async () => ({ self: 400, parents: new Map([[400, 300], [300, 50]]), env: {} });

describe("new", () => {
  test("validates cwd and socket before the RPC and prints pid:bufnr", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-"));
    const socket = join(dir, "nvim.999.0");
    writeFileSync(socket, "");
    const opened: unknown[] = [];
    const key = await newAgent({ socket, cwd: dir, prompt: "hello", focus: false }, {
      open: async (socketPath, options) => {
        opened.push([socketPath, options]);
        return { ok: true, bufnr: 5, pid: 999 };
      },
    });
    expect(key).toBe("999:5");
    expect(opened).toEqual([[socket, { cwd: dir, prompt: "hello", focus: false }]]);

    let called = false;
    const open = async () => { called = true; return { ok: true, bufnr: 5, pid: 999 }; };
    await expect(newAgent({ socket, cwd: join(dir, "missing") }, { open })).rejects.toThrow("cwd is not a directory");
    await expect(newAgent({ socket: join(dir, "nope"), cwd: dir }, { open })).rejects.toThrow("socket not found");
    expect(called).toBe(false);
  });

  test("passes the resolved caller into cc.open so the link exists before the first prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-"));
    const socket = join(dir, "nvim.999.0");
    writeFileSync(socket, "");
    const opened: unknown[] = [];
    const open = async (_socket: string, options: unknown) => { opened.push(options); return { ok: true, bufnr: 5, pid: 999 }; };
    const inventory = async () => ({ agents: [jarvis], warnings: [] });
    await newAgent({ socket, cwd: dir, prompt: "go" }, { open, inventory, callerContext: fromJarvis });
    expect(opened[0]).toEqual({ cwd: dir, prompt: "go", delegator: { key: "50:1", socket: "/nvim.50", bufnr: 1, session_id: "J" } });
    await newAgent({ socket, cwd: dir }, { open, inventory, callerContext: shell });
    await newAgent({ socket, cwd: dir, from: "none" }, { open, inventory, callerContext: fromJarvis });
    await newAgent({ socket, cwd: dir }, { open, inventory: async () => { throw new Error("no tmux"); }, callerContext: fromJarvis });
    expect(opened.slice(1)).toEqual([{ cwd: dir }, { cwd: dir }, { cwd: dir }]);
    await expect(newAgent({ socket, cwd: dir, from: { key: "9:9" } }, { open, inventory })).rejects.toThrow("from= agent not found");
  });

  test("surfaces the RPC error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-"));
    const socket = join(dir, "nvim.1.0");
    writeFileSync(socket, "");
    await expect(newAgent({ socket, cwd: dir }, {
      open: async () => ({ ok: false, error: "ambiguous model" }),
    })).rejects.toThrow("ambiguous model");
  });
});

describe("send", () => {
  test("refuses while the agent is working, waiting, or interrupting", async () => {
    for (const state of ["working", "waiting", "interrupting"] as const) {
      let called = false;
      await expect(sendToAgent("100:7", "hi", {
        inventory: inventoryWith(state),
        send: async () => { called = true; return { ok: true }; },
        callerContext: shell,
      })).rejects.toBeInstanceOf(AgentBusyError);
      expect(called).toBe(false);
    }
  });

  test("sends to the agent's socket and buffer when idle", async () => {
    const calls: unknown[] = [];
    for (const state of ["ready", "unread", "monitoring", "starting", "delegating"] as const) {
      await sendToAgent("100:7", "hi there", {
        inventory: inventoryWith(state),
        send: async (socketPath, bufnr, text) => { calls.push([socketPath, bufnr, text]); return { ok: true }; },
        callerContext: shell,
      });
    }
    expect(calls).toHaveLength(5);
    expect(calls[0]).toEqual(["/tmp/nvim.100.0", 7, "hi there"]);
  });

  test("links an unlinked target to the caller, and keeps an existing owner", async () => {
    const calls: unknown[][] = [];
    const send = async (...args: unknown[]) => { calls.push(args); return { ok: true }; };
    const worker = agent({ key: "60:2", nvimPid: 60, outputBufnr: 2, socketPath: "/nvim.60" });
    await sendToAgent("60:2", "go", { inventory: async () => ({ agents: [jarvis, worker], warnings: [] }), send, callerContext: fromJarvis });
    expect(calls[0]?.[5]).toEqual({ key: "50:1", socket: "/nvim.50", bufnr: 1, session_id: "J" });
    const owned = { ...worker, delegator: { key: "70:1", sessionId: null, socket: "/nvim.70", bufnr: 1 } };
    await sendToAgent("60:2", "go", { inventory: async () => ({ agents: [jarvis, owned], warnings: [] }), send, callerContext: fromJarvis });
    expect(calls[1]).toHaveLength(3);
  });

  test("never links an agent to itself or to its own descendant", async () => {
    const calls: unknown[][] = [];
    const send = async (...args: unknown[]) => { calls.push(args); return { ok: true }; };
    // The Worker (child of Jarvis) sends to Jarvis: linking would make a cycle.
    const worker = agent({ key: "60:2", pid: 300, delegator: { key: "50:1", sessionId: "J", socket: "/nvim.50", bufnr: 1 } });
    const boss = { ...jarvis, pid: 301 };
    await sendToAgent("50:1", "report", { inventory: async () => ({ agents: [boss, worker], warnings: [] }), send, callerContext: fromJarvis });
    await sendToAgent("50:1", "self", { inventory: async () => ({ agents: [jarvis], warnings: [] }), send, callerContext: fromJarvis });
    expect(calls.map((call) => call.length)).toEqual([3, 3]);
  });

  test("from= accepts auto, none, or a key", () => {
    expect(parseFrom(undefined)).toBe("auto");
    expect(parseFrom("none")).toBe("none");
    expect(parseFrom("1:2")).toEqual({ key: "1:2" });
    expect(() => parseFrom("jarvis")).toThrow("invalid value for 'from='");
  });

  test("unknown keys fail before any RPC", async () => {
    let called = false;
    await expect(sendToAgent("1:1", "hi", {
      inventory: inventoryWith("ready"),
      send: async () => { called = true; return { ok: true }; },
    })).rejects.toBeInstanceOf(AgentNotFoundError);
    expect(called).toBe(false);
  });
});

describe("tail", () => {
  test("returns the whole message or its last n lines", async () => {
    const dependencies = {
      inventory: inventoryWith("unread"),
      lastMessage: async () => ({ text: "a\nb\nc\n" }),
    };
    expect(await tailAgent("100:7", undefined, dependencies)).toBe("a\nb\nc\n");
    expect(await tailAgent("100:7", 2, dependencies)).toBe("b\nc");
    expect(lastLines("only", 5)).toBe("only");
  });

  test("propagates RPC errors", async () => {
    await expect(tailAgent("100:7", undefined, {
      inventory: inventoryWith("ready"),
      lastMessage: async () => ({ text: null, error: "no assistant message yet" }),
    })).rejects.toThrow("no assistant message yet");
  });
});

describe("detach", () => {
  test("detaches a linked agent and refuses an unlinked one", async () => {
    const calls: unknown[] = [];
    const linked = agent({ delegator: { key: "50:1", sessionId: "J", socket: "/nvim.50", bufnr: 1 } });
    await detachAgent("100:7", {
      inventory: async () => ({ agents: [linked], warnings: [] }),
      detach: async (socketPath, bufnr) => { calls.push([socketPath, bufnr]); return { ok: true }; },
    });
    expect(calls).toEqual([["/tmp/nvim.100.0", 7]]);
    await expect(detachAgent("100:7", { inventory: inventoryWith("ready") })).rejects.toThrow("has no parent");
  });
});

describe("close", () => {
  test("closes the resolved buffer", async () => {
    const calls: unknown[] = [];
    await closeAgent("100:7", {
      inventory: inventoryWith("working"),
      close: async (socketPath, bufnr) => { calls.push([socketPath, bufnr]); return { ok: true }; },
    });
    expect(calls).toEqual([["/tmp/nvim.100.0", 7]]);
  });
});

describe("interrupt", () => {
  test("interrupts the resolved buffer", async () => {
    const calls: unknown[] = [];
    await interruptAgent("100:7", {
      inventory: inventoryWith("working"),
      interrupt: async (socketPath, bufnr) => { calls.push([socketPath, bufnr]); return { ok: true }; },
    });
    expect(calls).toEqual([["/tmp/nvim.100.0", 7]]);
  });

  test("throws with the reason when nothing was interrupted", async () => {
    await expect(interruptAgent("100:7", {
      inventory: inventoryWith("ready"),
      interrupt: async () => ({ ok: false, error: "no turn active" }),
    })).rejects.toThrow("nothing interrupted for 100:7: no turn active");
  });
});
