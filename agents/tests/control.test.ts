import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentBusyError,
  AgentNotFoundError,
  closeAgent,
  lastLines,
  newAgent,
  sendToAgent,
  tailAgent,
} from "../src/control.ts";
import type { AgentState } from "../src/types.ts";
import { agent } from "./fixtures.ts";

const inventoryWith = (state: AgentState) => async () => ({ agents: [agent({ state })], warnings: [] });

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
      })).rejects.toBeInstanceOf(AgentBusyError);
      expect(called).toBe(false);
    }
  });

  test("sends to the agent's socket and buffer when idle", async () => {
    const calls: unknown[] = [];
    for (const state of ["ready", "unread", "monitoring", "starting"] as const) {
      await sendToAgent("100:7", "hi there", {
        inventory: inventoryWith(state),
        send: async (socketPath, bufnr, text) => { calls.push([socketPath, bufnr, text]); return { ok: true }; },
      });
    }
    expect(calls).toHaveLength(4);
    expect(calls[0]).toEqual(["/tmp/nvim.100.0", 7, "hi there"]);
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
