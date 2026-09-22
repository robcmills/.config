export interface NamedArgsSpec {
  /** Accepted `key=value` names. */
  keys: readonly string[];
  /** Accepted bare flags such as `--json`. */
  flags?: readonly string[];
  /** Whether bare words (not `key=value`, not a flag) are accepted. */
  allowPositional?: boolean;
}

export interface NamedArgs {
  values: Map<string, string>;
  flags: Set<string>;
  positional: string[];
}

/**
 * Parse `key=value` arguments. Every key may appear once. Anything else is
 * rejected so a typo never silently becomes a prompt or a positional.
 */
export function parseNamedArgs(args: string[], spec: NamedArgsSpec): NamedArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positional: string[] = [];
  for (const arg of args) {
    if (spec.flags?.includes(arg)) {
      flags.add(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq > 0 ? arg.slice(0, eq) : null;
    if (key !== null && spec.keys.includes(key)) {
      if (values.has(key)) throw new Error(`duplicate argument '${key}='`);
      values.set(key, arg.slice(eq + 1));
      continue;
    }
    if (key !== null && /^[a-z][a-z-]*$/.test(key)) {
      throw new Error(`unknown argument '${key}='; expected one of: ${spec.keys.map((k) => `${k}=`).join(", ")}`);
    }
    if (spec.allowPositional) {
      positional.push(arg);
      continue;
    }
    throw new Error(`unexpected argument '${arg}'`);
  }
  return { values, flags, positional };
}

export function requireArg(parsed: NamedArgs, key: string): string {
  const value = parsed.values.get(key);
  if (value === undefined || value === "") throw new Error(`missing required argument '${key}='`);
  return value;
}

export function parseBoolean(value: string | undefined, key: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  throw new Error(`invalid value for '${key}=': expected true or false, got '${value}'`);
}

export function parsePositiveInteger(value: string | undefined, key: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`invalid value for '${key}=': expected a positive integer, got '${value}'`);
  }
  return n;
}
