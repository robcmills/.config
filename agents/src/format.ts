import type { Agent } from "./types.ts";

export const TSV_COLUMNS: (keyof Agent)[] = [
  "key",
  "state",
  "project",
  "provider",
  "model",
  "name",
  "cwd",
  "nvimPid",
  "outputBufnr",
  "promptBufnr",
  "sessionId",
  "pid",
  "turnElapsedMs",
  "backgroundTaskCount",
  "lastModifiedAt",
  "socketPath",
  "tmuxSessionId",
  "tmuxWindowId",
  "tmuxWindowName",
  "tmuxPaneId",
];

function escapeTsv(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replaceAll("\\", "\\\\").replaceAll("\t", "\\t")
    .replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

export function formatTsv(agents: Agent[]): string {
  return agents.map((agent) => TSV_COLUMNS.map((column) => escapeTsv(agent[column])).join("\t")).join("\n");
}

const COLORS: Record<Agent["state"], string> = {
  waiting: "\x1b[33;1m",
  interrupting: "\x1b[31m",
  working: "\x1b[36m",
  monitoring: "\x1b[34;1m",
  starting: "\x1b[35m",
  ready: "\x1b[32m",
  exited: "\x1b[90m",
};
const RESET = "\x1b[0m";

function displayText(value: string | null): string {
  return (value ?? "—").replace(/[\x00-\x1f\x7f]/g, " ");
}

// ▼ marks the primary sort column (newest first).
const LAST_MODIFIED_HEADER = "LAST MODIFIED ▼";

function formatLastModified(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function cell(value: string | null, width: number): string {
  const text = displayText(value);
  return text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text.padEnd(width);
}

export interface PickerTable {
  header: string;
  rows: string[];
}

export function formatPickerTable(agents: Agent[]): PickerTable {
  const stateWidth = Math.max("STATE".length, ...agents.map((agent) => agent.state.length));
  const lastModified = agents.map((agent) => formatLastModified(agent.lastModifiedAt));
  const lastModifiedWidth = Math.max(
    LAST_MODIFIED_HEADER.length,
    ...lastModified.map((value) => (value ?? "—").length),
  );
  const projectWidth = Math.max("PROJECT".length, ...agents.map((agent) => agent.project.length));
  const modelWidth = Math.max("MODEL".length, ...agents.map((agent) => (agent.model ?? "—").length));
  const header = [
    cell("STATE", stateWidth),
    cell(LAST_MODIFIED_HEADER, lastModifiedWidth),
    cell("PROJECT", projectWidth),
    cell("MODEL", modelWidth),
    "SESSION",
  ].join("  ");
  const rows = agents.map((agent) => {
    const state = `${COLORS[agent.state]}${cell(agent.state, stateWidth)}${RESET}`;
    const display = [
      state,
      cell(formatLastModified(agent.lastModifiedAt), lastModifiedWidth),
      cell(agent.project, projectWidth),
      cell(agent.model, modelWidth),
      displayText(agent.name ?? agent.sessionId),
    ].join("  ");
    return `${display}\t${agent.key}`;
  });
  return { header, rows };
}

export function formatPickerRows(agents: Agent[]): string[] {
  return formatPickerTable(agents).rows;
}
