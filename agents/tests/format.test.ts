import { expect, test } from "bun:test";
import { formatPickerRows, formatPickerTable, formatTsv, TSV_COLUMNS } from "../src/format.ts";
import { pickerWarningSummary } from "../src/picker.ts";
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

test("picker warnings are summarized without transient diagnostic details", () => {
  expect(pickerWarningSummary(0)).toBeNull();
  expect(pickerWarningSummary(1)).toBe("⚠ 1 inventory warning · details: agents doctor");
  expect(pickerWarningSummary(3)).toBe("⚠ 3 inventory warnings · details: agents doctor");
});

test("picker header and values share widths based on the longest value", () => {
  const { header, rows } = formatPickerTable([
    agent({ model: "gpt-5.6-sol", project: "x", lastModifiedAt: 1_700_000_000_123 }),
    agent({ key: "101:8", model: "opus", project: "long-project-name", lastModifiedAt: null }),
  ]);
  const visibleRow = rows[0]!.replace(/\x1b\[[0-9;]*m/g, "").split("\t")[0]!;
  const headerColumns = [
    header.indexOf("STATE"),
    header.indexOf("LAST MODIFIED"),
    header.indexOf("PROJECT"),
    header.indexOf("MODEL"),
    header.indexOf("SESSION"),
  ];
  const rowColumns = [
    visibleRow.indexOf("ready"),
    visibleRow.indexOf("2023-11-14T22:13:20Z"),
    visibleRow.indexOf("x"),
    visibleRow.indexOf("gpt-5.6-sol"),
    visibleRow.indexOf("session-name"),
  ];
  expect(rowColumns).toEqual(headerColumns);
  expect(header).not.toContain("PROVIDER");
  expect(visibleRow).not.toContain("codex");
  expect(header.slice(header.indexOf("MODEL"), header.indexOf("SESSION")).length)
    .toBeGreaterThan("gpt-5.6-sol".length);
  expect(rows[1]).toContain("—");
});
