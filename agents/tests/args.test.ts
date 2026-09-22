import { expect, test } from "bun:test";
import { parseBoolean, parseNamedArgs, parsePositiveInteger, requireArg } from "../src/args.ts";

test("parses key=value pairs, flags, and values containing '='", () => {
  const parsed = parseNamedArgs(["key=1:2", "prompt=a=b", "--json"], { keys: ["key", "prompt"], flags: ["--json"] });
  expect(parsed.values.get("key")).toBe("1:2");
  expect(parsed.values.get("prompt")).toBe("a=b");
  expect(parsed.flags.has("--json")).toBe(true);
  expect(parsed.positional).toEqual([]);
});

test("rejects duplicates, unknown keys, and stray positionals", () => {
  expect(() => parseNamedArgs(["key=1", "key=2"], { keys: ["key"] })).toThrow("duplicate argument 'key='");
  expect(() => parseNamedArgs(["promt=x"], { keys: ["prompt"] })).toThrow("unknown argument 'promt='");
  expect(() => parseNamedArgs(["oops"], { keys: ["key"] })).toThrow("unexpected argument 'oops'");
});

test("positionals are accepted only when allowed", () => {
  const parsed = parseNamedArgs(["100:7"], { keys: ["key"], allowPositional: true });
  expect(parsed.positional).toEqual(["100:7"]);
});

test("requireArg rejects missing and empty values", () => {
  const parsed = parseNamedArgs(["key="], { keys: ["key", "cwd"] });
  expect(() => requireArg(parsed, "key")).toThrow("missing required argument 'key='");
  expect(() => requireArg(parsed, "cwd")).toThrow("missing required argument 'cwd='");
});

test("boolean and integer coercion", () => {
  expect(parseBoolean(undefined, "focus")).toBeUndefined();
  expect(parseBoolean("false", "focus")).toBe(false);
  expect(parseBoolean("1", "focus")).toBe(true);
  expect(() => parseBoolean("maybe", "focus")).toThrow("invalid value for 'focus='");
  expect(parsePositiveInteger("12", "n")).toBe(12);
  expect(() => parsePositiveInteger("0", "n")).toThrow("invalid value for 'n='");
  expect(() => parsePositiveInteger("x", "n")).toThrow("invalid value for 'n='");
});
