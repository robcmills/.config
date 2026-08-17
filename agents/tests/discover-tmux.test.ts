import { describe, expect, test } from "bun:test";
import {
  correlatePane,
  parseProcessParents,
  parseTmuxPanes,
} from "../src/discover-tmux.ts";

const panes = parseTmuxPanes([
  "$1\t@10\tmain window\t%20\t100\t/Users/me/src/project with spaces",
  "$2\t@11\tother\t%21\t200\t/Users/me/src/other",
].join("\n"));

describe("tmux parsing", () => {
  test("preserves stable IDs and paths containing spaces", () => {
    expect(panes[0]).toEqual({
      sessionId: "$1", windowId: "@10", windowName: "main window",
      paneId: "%20", panePid: 100, currentPath: "/Users/me/src/project with spaces",
    });
  });

  test("parses a process parent table", () => {
    expect(parseProcessParents(" 300 250\n 250 100\n").get(300)).toBe(250);
  });
});

describe("pane correlation", () => {
  test("matches direct and descendant PIDs", () => {
    expect(correlatePane(100, "/none", panes, new Map())?.paneId).toBe("%20");
    expect(correlatePane(300, "/none", panes, new Map([[300, 250], [250, 100]]))?.paneId).toBe("%20");
  });

  test("uses a unique boundary-aware cwd fallback", () => {
    expect(correlatePane(999, "/Users/me/src/other/subdir", panes, new Map())?.paneId).toBe("%21");
    expect(correlatePane(999, "/Users/me/src/othership", panes, new Map())).toBeNull();
  });

  test("does not guess between ambiguous cwd panes", () => {
    const duplicate = { ...panes[0]!, paneId: "%99", panePid: 999 };
    expect(correlatePane(500, panes[0]!.currentPath, [...panes, duplicate], new Map())).toBeNull();
  });
});
