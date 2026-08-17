import { expect, test } from "bun:test";
import { formatPickerRows, formatPickerTable, formatTsv, TSV_COLUMNS } from "../src/format.ts";
import { agent } from "./fixtures.ts";

test("TSV is stable, uncolored, and escapes field delimiters", () => {
  const output = formatTsv([agent({ name: "a\tb\nc" })]);
  expect(output.split("\t")).toHaveLength(TSV_COLUMNS.length);
  expect(output).toContain("a\\tb\\nc");
  expect(output).not.toContain("\x1b[");
  expect(formatTsv([])).toBe("");
});

test("picker rows color only the display and retain a hidden exact key", () => {
  const output = formatPickerRows([agent({ state: "waiting" })])[0]!;
  expect(output).toContain("\x1b[");
  expect(output.endsWith("\t100:7")).toBe(true);
});

test("picker header and values share widths based on the longest value", () => {
  const { header, rows } = formatPickerTable([
    agent({ model: "gpt-5.6-sol", project: "x" }),
    agent({ key: "101:8", model: "opus", project: "long-project-name" }),
  ]);
  const visibleRow = rows[0]!.replace(/\x1b\[[0-9;]*m/g, "").split("\t")[0]!;
  const headerColumns = [
    header.indexOf("STATE"),
    header.indexOf("PROJECT"),
    header.indexOf("PROVIDER"),
    header.indexOf("MODEL"),
    header.indexOf("SESSION"),
  ];
  const rowColumns = [
    visibleRow.indexOf("ready"),
    visibleRow.indexOf("x"),
    visibleRow.indexOf("codex"),
    visibleRow.indexOf("gpt-5.6-sol"),
    visibleRow.indexOf("session-name"),
  ];
  expect(rowColumns).toEqual(headerColumns);
  expect(header.slice(header.indexOf("MODEL"), header.indexOf("SESSION")).length)
    .toBeGreaterThan("gpt-5.6-sol".length);
});
