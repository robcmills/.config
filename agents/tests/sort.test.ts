import { describe, expect, test } from "bun:test";
import { createAgentComparator, validateConfig } from "../src/sort.ts";
import type { AgentsConfig, SortKey } from "../src/types.ts";
import { agent } from "./fixtures.ts";

const config: AgentsConfig = {
  sort: {
    by: ["project", "status", "name"],
    projectOrder: ["openspace*", "notes"],
    statusOrder: ["waiting", "working", "ready"],
  },
};

describe("configured sorting", () => {
  test("sorts last modified newest-first and unknown timestamps last", () => {
    const byModified: AgentsConfig = {
      ...config,
      sort: { ...config.sort, by: ["lastModified"] },
    };
    const agents = [
      agent({ key: "1:1", lastModifiedAt: 100 }),
      agent({ key: "1:2", lastModifiedAt: null }),
      agent({ key: "1:3", lastModifiedAt: 300 }),
    ];
    expect(agents.sort(createAgentComparator(byModified)).map((item) => item.key))
      .toEqual(["1:3", "1:1", "1:2"]);
  });

  test("groups configured prefixes, then manual projects, then alphabetical fallback", () => {
    const agents = [
      agent({ key: "1:1", project: "z-new" }),
      agent({ key: "1:2", project: "notes" }),
      agent({ key: "1:3", project: "openspace-zebra" }),
      agent({ key: "1:4", project: "openspace" }),
      agent({ key: "1:5", project: "a-new" }),
    ];
    expect(agents.sort(createAgentComparator(config)).map((item) => item.project)).toEqual([
      "openspace", "openspace-zebra", "notes", "a-new", "z-new",
    ]);
  });

  test("reordering sort.by makes status primary", () => {
    const byStatus: AgentsConfig = {
      ...config,
      sort: { ...config.sort, by: ["status", "project"] as SortKey[] },
    };
    const agents = [agent({ key: "1:1", project: "openspace", state: "ready" }), agent({ key: "1:2", project: "z", state: "waiting" })];
    expect(agents.sort(createAgentComparator(byStatus)).map((item) => item.state)).toEqual(["waiting", "ready"]);
  });
});

describe("config validation", () => {
  test("rejects unknown sort keys and invalid wildcard patterns", () => {
    expect(() => validateConfig({ sort: { ...config.sort, by: ["bogus"] } })).toThrow("unknown key");
    expect(() => validateConfig({ sort: { ...config.sort, projectOrder: ["open*space"] } })).toThrow("only a trailing *");
  });

  test("rejects duplicate priorities", () => {
    expect(() => validateConfig({ sort: { ...config.sort, statusOrder: ["ready", "ready"] } })).toThrow("duplicate");
  });
});
