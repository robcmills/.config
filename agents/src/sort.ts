import { AGENT_STATES, SORT_KEYS } from "./types.ts";
import type { Agent, AgentsConfig, AgentState, SortKey } from "./types.ts";

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
}

function duplicates(values: readonly string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) !== index);
}

export function validateConfig(value: unknown): AgentsConfig {
  if (!value || typeof value !== "object" || !("sort" in value)) {
    throw new Error("config must export an object with a sort section");
  }
  const sort = (value as { sort?: unknown }).sort;
  if (!sort || typeof sort !== "object") throw new Error("config.sort must be an object");
  const raw = sort as Record<string, unknown>;
  assertStringArray(raw.by, "config.sort.by");
  assertStringArray(raw.projectOrder, "config.sort.projectOrder");
  assertStringArray(raw.statusOrder, "config.sort.statusOrder");
  if (raw.by.length === 0) throw new Error("config.sort.by must contain at least one sort key");
  const badKey = raw.by.find((key) => !SORT_KEYS.includes(key as SortKey));
  if (badKey) throw new Error(`config.sort.by contains unknown key: ${badKey}`);
  const badStatus = raw.statusOrder.find((state) => !AGENT_STATES.includes(state as AgentState));
  if (badStatus) throw new Error(`config.sort.statusOrder contains unknown state: ${badStatus}`);
  const badPattern = raw.projectOrder.find((pattern) => !pattern || pattern.slice(0, -1).includes("*"));
  if (badPattern !== undefined) {
    throw new Error(`config.sort.projectOrder has invalid pattern: ${badPattern || "(empty)"}; only a trailing * is supported`);
  }
  for (const [items, label] of [
    [raw.by, "config.sort.by"],
    [raw.projectOrder, "config.sort.projectOrder"],
    [raw.statusOrder, "config.sort.statusOrder"],
  ] as const) {
    const repeated = duplicates(items);
    if (repeated.length) throw new Error(`${label} contains duplicate value: ${repeated[0]}`);
  }
  return value as AgentsConfig;
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function configuredRank(value: string, order: readonly string[], prefixPatterns: boolean): number {
  const index = order.findIndex((pattern) => {
    if (prefixPatterns && pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1));
    return value === pattern;
  });
  return index === -1 ? order.length : index;
}

function compareNullable(left: string | null, right: string | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return lexical(left, right);
}

function compareNullableNewest(left: number | null, right: number | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}

export function createAgentComparator(config: AgentsConfig): (left: Agent, right: Agent) => number {
  const { by, projectOrder, statusOrder } = config.sort;
  return (left, right) => {
    for (const key of by) {
      let compared = 0;
      if (key === "lastModified") {
        compared = compareNullableNewest(left.lastModifiedAt, right.lastModifiedAt);
      } else if (key === "project") {
        compared = configuredRank(left.project, projectOrder, true)
          - configuredRank(right.project, projectOrder, true);
        if (compared === 0) compared = lexical(left.project, right.project);
      } else if (key === "status") {
        compared = configuredRank(left.state, statusOrder, false)
          - configuredRank(right.state, statusOrder, false);
        if (compared === 0 && left.state !== right.state) compared = lexical(left.state, right.state);
      } else if (key === "name" || key === "model") {
        compared = compareNullable(left[key], right[key]);
      } else {
        compared = lexical(left[key], right[key]);
      }
      if (compared !== 0) return compared;
    }
    return lexical(left.key, right.key);
  };
}
