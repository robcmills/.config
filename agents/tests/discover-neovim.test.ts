import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  dedupeNeovimInstances,
  discoverNeovimInstances,
  findAllNeovimSockets,
  getTempRoots,
  parseLsofCwds,
  parsePidFromSocket,
} from "../src/discover-neovim.ts";
import type { CommandRunner } from "../src/types.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("parsePidFromSocket", () => {
  test("accepts standard listener indices only", () => {
    expect(parsePidFromSocket("/tmp/nvim.me/x/nvim.123.0")).toBe(123);
    expect(parsePidFromSocket("/tmp/nvim.me/x/nvim.123.7")).toBe(123);
    expect(parsePidFromSocket("/tmp/nvim.sock")).toBeNull();
  });
});

test("getTempRoots includes overridden and fallback roots without duplicates", async () => {
  const original = process.env.TMPDIR;
  process.env.TMPDIR = "/tmp/agents-test-override";
  const run: CommandRunner = async () => ({
    stdout: "/var/folders/canonical/T/\n", stderr: "", exitCode: 0, timedOut: false,
  });
  try {
    const roots = await getTempRoots(run);
    expect(roots).toContain("/tmp/agents-test-override");
    expect(roots).toContain("/tmp");
    expect(new Set(roots).size).toBe(roots.length);
  } finally {
    if (original === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = original;
  }
});

test("findAllNeovimSockets scans nested dirs and deduplicates roots", () => {
  const root = mkdtempSync(join(tmpdir(), "agents-nvim-"));
  temporary.push(root);
  const dir = join(root, "nvim.test-user", "abc");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "nvim.321.0"), "");
  writeFileSync(join(dir, "ignore"), "");
  expect(findAllNeovimSockets([root, root], "test-user")).toEqual([join(dir, "nvim.321.0")]);
});

test("parseLsofCwds extracts all PID/path pairs from one batched scan", () => {
  expect(parseLsofCwds("p11\nfcwd\nn/cwd/one\np22\nfcwd\nn/cwd/two\n")).toEqual(new Map([
    [11, "/cwd/one"],
    [22, "/cwd/two"],
  ]));
});

test("discovery retains live wedged processes but drops stale sockets", async () => {
  const root = mkdtempSync(join(tmpdir(), "agents-nvim-"));
  temporary.push(root);
  const dir = join(root, "nvim.test-user", "abc");
  mkdirSync(dir, { recursive: true });
  for (const pid of [11, 22, 33]) writeFileSync(join(dir, `nvim.${pid}.0`), "");
  const run: CommandRunner = async (args) => {
    const socket = args[2] ?? "";
    if (socket.includes("nvim.11.")) return { stdout: "1\n", stderr: "", exitCode: 0, timedOut: false };
    if (socket.includes("nvim.22.")) return { stdout: "", stderr: "", exitCode: 137, timedOut: true };
    return { stdout: "", stderr: "stale", exitCode: 1, timedOut: false };
  };
  const instances = await discoverNeovimInstances({
    roots: [root], user: "test-user", run,
    alive: (pid) => pid !== 33,
    cwdFromPid: async (pid) => `/cwd/${pid}`,
  });
  expect(instances.map((instance) => [instance.pid, instance.state])).toEqual([
    [11, "responsive"], [22, "wedged"],
  ]);
});

test("discovery can defer RPC health checking to the inventory query", async () => {
  const root = mkdtempSync(join(tmpdir(), "agents-nvim-"));
  temporary.push(root);
  const dir = join(root, "nvim.test-user", "abc");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "nvim.11.0"), "");
  let rpcCalls = 0;
  const instances = await discoverNeovimInstances({
    roots: [root], user: "test-user", probeRpc: false,
    run: async () => { rpcCalls++; return { stdout: "", stderr: "", exitCode: 1, timedOut: false }; },
    alive: () => true,
    cwdFromPid: async () => "/cwd/11",
  });
  expect(instances).toEqual([{
    socketPath: join(dir, "nvim.11.0"), pid: 11, cwd: "/cwd/11", state: "responsive",
  }]);
  expect(rpcCalls).toBe(0);
});

test("dedupe prefers a responsive listener for the same Neovim PID", () => {
  expect(dedupeNeovimInstances([
    { socketPath: "/b/nvim.7.0", pid: 7, cwd: "/x", state: "wedged" },
    { socketPath: "/a/nvim.7.1", pid: 7, cwd: "/x", state: "responsive" },
  ])).toEqual([
    { socketPath: "/a/nvim.7.1", pid: 7, cwd: "/x", state: "responsive" },
  ]);
});
