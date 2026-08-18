# Agents Tool Implementation Plan

## Goal

Build a small personal CLI that accurately discovers every live cc.nvim agent,
shows its current status, and switches to the exact agent across Neovim and
tmux.

The first version is discovery and navigation only. It will not interrupt,
close, kill, send prompts to, or otherwise control an agent.

## Decision Summary

- Implement the tool in TypeScript and run it directly with Bun.
- Keep it in `~/.config/agents/` and expose it through a Bash alias named
  `agents`.
- Use cc.nvim's live in-memory state as the source of truth for agents.
- Discover Neovim instances using the hardened approach already proven in
  `~/src/nvim-lsp-bridge`.
- Correlate Neovim processes with tmux panes using stable tmux IDs, borrowing
  the switching and cwd-fallback ideas from `~/.config/bash/wt.sh`.
- Use an fzf picker inside a tmux popup for interactive use.
- Keep noninteractive output as the default, with `-i` explicitly opting into
  interaction.
- Keep sort keys and project priority in `~/.config/agents/config.ts` so the
  ordering can be changed without touching inventory or UI code.
- Do not add a daemon, database, persistent registry, full-screen TUI, or npm
  UI dependency in the first version.

## User Interface

The CLI surface should stay small:

```text
agents                 Print live agents as stable, uncolored TSV
agents --json          Print the same inventory as JSON
agents -i              Open the fzf picker and switch to the selection
agents switch <key>    Switch directly to one live agent
agents --help          Show usage
```

This follows the useful split in `wt.sh`: normal execution is safe for scripts
and agents, while `-i` opts a human into fzf and side effects.

Behavioral details:

- `agents` with no matches prints nothing and exits successfully.
- `agents -i` with no matches prints `No running cc.nvim agents.` and exits
  successfully.
- `agents --json` always prints valid JSON, including `[]` when empty.
- `agents switch <key>` never prompts. It either switches to that exact agent
  or exits nonzero with a specific error.
- Instances whose provider process has exited are filtered from the normal
  inventory; the tool is for running agents, not session history.
- stdout is reserved for inventory data. Warnings and errors go to stderr.
- ANSI color is used only in the fzf display, never in TSV or JSON output.

The interactive rows should initially contain only the information needed to
choose an agent:

```text
STATE       PROJECT          PROVIDER  MODEL        SESSION
ready       openspace        claude    opus-5      test-feature-permissions
working     openspace-aikido codex     gpt-5.6-sol refactor-alert-routing
waiting     gable-ct         codex     gpt-5.6-sol lease-review-landlord
```

### Sort configuration

Sorting must be data-driven rather than embedded in the formatter or picker.
The default primary key is last modified, followed by project, status, and
session name:

```typescript
// ~/.config/agents/config.ts
import type { AgentsConfig } from "./src/types";

export default {
  sort: {
    by: ["lastModified", "project", "status", "name"],
    projectOrder: [
      "openspace*",
      // Add the remaining project names here in the desired order, for example:
      // "notes",
      // ".config",
      // "cc.nvim",
      // "gable-ct",
    ],
    statusOrder: [
      "waiting",
      "interrupting",
      "working",
      "starting",
      "ready",
    ],
  },
} satisfies AgentsConfig;
```

Rules:

- `sort.by` controls comparator precedence. Reordering it to
  `["status", "project", "name"]`, for example, restores status-first sorting.
- `lastModified` sorts agents by their latest live conversation activity,
  newest first. Agents from older Neovim processes that do not expose an
  activity timestamp sort after timestamped agents until Neovim is restarted.
- `projectOrder` is checked from top to bottom. Entries are exact project names
  or simple trailing-`*` prefix groups.
- `openspace*` gives the main `openspace` project and all worktrees such as
  `openspace-aikido` and `openspace-delivery` the first project rank.
- Projects matching the same group are ordered by their actual project name,
  so `openspace` and its worktrees remain deterministic within the group.
- Add every other known project to `projectOrder` in the preferred manual
  order.
- Unlisted projects sort after configured projects, alphabetically by project
  name, so a new project remains visible before the config is updated.
- `statusOrder` controls status priority whenever `status` is used as a sort
  key.
- The same comparator is used for TSV, JSON, and fzf output.
- An invalid config should fail with a short, actionable error rather than
  silently falling back to a surprising order.

Do not add a preview pane, automatic refresh loop, persistent dashboard, or
picker action keys in the first pass. Reopening the popup performs a fresh live
query and keeps the implementation easy to reason about.

## Prior Art Incorporated

### nvim-lsp-bridge discovery

Reuse the behavior and tests behind these functions in
`~/src/nvim-lsp-bridge/lib.ts`:

- `getTempRoots()`
- `findAllNeovimSockets()`
- `parsePidFromSocket()`
- `isProcessAlive()`
- `getCwdFromPid()`
- `getNvimInfoFromPid()`
- `pingNvim()`
- `discoverInstances()`

Important lessons to preserve:

1. **Do not trust only the current `$TMPDIR`.** Agent harnesses can override
   it. Scan and deduplicate all plausible roots:
   - `os.tmpdir()`
   - `$TMPDIR`
   - `getconf DARWIN_USER_TEMP_DIR` on macOS
   - `/tmp`
2. **Separate process discovery from RPC health.** Parse the PID embedded in a
   standard `nvim.<pid>.<listener>` socket, verify the process with signal 0,
   and obtain cwd from kernel state (`lsof` on macOS, `/proc/<pid>/cwd` on
   Linux). This still works if Neovim's event loop is wedged.
3. **Put a timeout around every RPC call.** A socket can accept a connection
   while Neovim is blocked on a modal prompt or deadlocked.
4. **Do not silently drop wedged instances.** Report a concise warning with
   socket, PID, cwd, and tmux target when available. Exact cc.nvim agents cannot
   be inventoried without responsive RPC, but the tool must explain the gap.
5. **Query sockets concurrently.** One slow or wedged Neovim must not serialize
   the entire inventory.
6. **Ignore stale sockets safely.** A socket with no live process and no
   responsive RPC is not an agent and should not appear in the inventory.

The agents tool should adapt this small discovery core into its own
`discover-neovim.ts`. Do not import `nvim-lsp-bridge` by absolute path and do
not create a shared package yet; that would add coupling and packaging work to
an otherwise small personal tool. If both tools evolve together later, the
common discovery code can be extracted then.

One nvim-lsp-bridge behavior should deliberately not carry over: cwd-based
auto-selection of a single Neovim. The agents tool is an inventory, so it must
query every responsive Neovim and show every cc.nvim instance.

### wt.sh tmux ergonomics

Preserve these patterns from `~/.config/bash/wt.sh`:

- Noninteractive listing by default and `-i` for fzf interaction.
- Put switching logic in one function used by both direct and interactive
  commands.
- Prefer an exact tmux target, with a cwd-based lookup as a fallback.
- Return a clear error when no tmux window can be found.

Improve the target precision for agents:

- Ask tmux for stable `session_id`, `window_id`, and `pane_id` values rather
  than relying primarily on window names.
- Associate the Neovim PID from its socket with a pane by walking its parent
  process chain until it reaches `pane_pid`.
- If process ancestry does not produce a target, fall back to
  `pane_current_path`, using boundary-aware cwd matching.
- Only accept a cwd fallback when it produces one unambiguous pane. Do not guess
  between multiple panes with the same path.
- Switch to both the exact window and pane, since one tmux window may eventually
  contain multiple panes.

## Architecture

```text
tmux popup
    |
    v
agents -i (Bun/TypeScript)
    |
    +-- discover tmux sessions/windows/panes
    |
    +-- discover Neovim sockets across all temp roots
    |       |
    |       +-- PID/process/cwd from kernel state
    |       +-- bounded RPC health check
    |
    +-- ask each responsive cc.nvim for JSON-safe snapshots
            |
            +-- Claude instances
            +-- Codex instances

selection
    |
    +-- cc.nvim focuses output buffer N in target Neovim
    +-- tmux selects the exact session/window/pane
    +-- popup exits
```

There is no persistent registry. Every invocation builds a fresh snapshot from
live Neovim and tmux state.

## cc.nvim Integration

cc.nvim already owns the authoritative instance registry, but it is private to
`lua/cc/init.lua`. Add a narrow, provider-neutral public API:

```lua
require('cc').list_instances()
require('cc').focus_instance(output_bufnr)
```

### `list_instances()`

Return a JSON-safe array. Never expose provider objects, process handles,
buffers, or other internal tables directly.

Proposed snapshot:

```typescript
interface CcInstanceSnapshot {
  outputBufnr: number;
  promptBufnr: number;
  sessionId: string | null;
  name: string | null;
  provider: "claude" | "codex";
  model: string | null;
  cwd: string;
  pid: number | null;
  state:
    | "waiting"
    | "interrupting"
    | "working"
    | "starting"
    | "ready"
    | "exited";
  turnElapsedMs: number | null;
  lastModifiedAt: number | null; // epoch milliseconds
}
```

Store cwd on the cc.nvim instance when it is created or when the provider is
attached. Do not compute it later from `vim.fn.getcwd()`, because Neovim's cwd
can change while an older agent continues running in its original cwd.

Use one shared state calculation for `:CcStatus`, the statusline, and the
external snapshot so they cannot disagree.

State precedence:

1. process missing or not alive -> `exited`
2. awaiting a permission/user response -> `waiting`
3. interrupt pending -> `interrupting`
4. turn active -> `working`
5. no session ID yet -> `starting`
6. otherwise -> `ready`

Normalize the existing provider-specific interactive state so both Claude and
Codex set and clear an instance-level `awaiting_input` flag around permission
prompts and other blocking user-input UI. This is status tracking only; the
agents tool will not answer those prompts.

### `focus_instance(output_bufnr)`

- Accept only an integer output buffer number from the local Neovim process.
- Look it up in cc.nvim's existing instance registry.
- Focus/show that instance using cc.nvim's existing buffer and companion-window
  restoration behavior.
- Return `true` on success and `false` if the instance disappeared.
- Do not start, resume, close, interrupt, or mutate the conversation.

The external stable key is composed by the CLI as:

```text
<nvim-pid>:<output-bufnr>
```

The buffer number is only meaningful inside one Neovim, while the composite is
unique across the live inventory. It is intentionally ephemeral and need only
remain stable for the lifetime of those processes.

## TypeScript Tool

Suggested layout:

```text
~/.config/agents/
├── package.json
├── config.ts
├── bin/
│   └── agents
├── src/
│   ├── cli.ts
│   ├── types.ts
│   ├── discover-neovim.ts
│   ├── discover-tmux.ts
│   ├── cc-rpc.ts
│   ├── inventory.ts
│   ├── format.ts
│   ├── picker.ts
│   └── switch.ts
└── tests/
    ├── discover-neovim.test.ts
    ├── discover-tmux.test.ts
    ├── inventory.test.ts
    ├── sort.test.ts
    └── switch.test.ts
```

Keep runtime dependencies at zero. Use:

- Bun for TypeScript execution and tests.
- `nvim --server ... --remote-expr ...` for the two fixed RPC operations.
- `tmux` for pane inventory and switching.
- `fzf` only when `-i` is present.

Use `Bun.spawn` with argument arrays, never a shell-built command string. Put a
short timeout around every Neovim subprocess and terminate it on timeout. The
RPC expressions are fixed except for the validated numeric output buffer ID;
do not interpolate names, cwd values, or session IDs into Lua/Vim expressions.

### Inventory merge

The CLI adds host and tmux information to each cc.nvim snapshot:

```typescript
interface Agent extends CcInstanceSnapshot {
  key: string;
  project: string;
  nvimPid: number;
  socketPath: string;
  tmuxSessionId: string | null;
  tmuxWindowId: string | null;
  tmuxWindowName: string | null;
  tmuxPaneId: string | null;
}
```

Derive the sortable `project` name consistently from cwd:

- under `~/src/`, use the first project/worktree directory, such as
  `openspace`, `openspace-aikido`, or `cc.nvim`
- elsewhere, use the basename of the agent cwd, such as `.config`, `notes`, or
  `gable-ct`

This is a display/sort label only. Keep the full cwd in TSV/JSON data and use
cwd—not the project label—for tmux fallback matching.

## Switching Sequence

For `agents switch <key>` and an fzf selection:

1. Resolve direct `switch <key>` commands against a fresh inventory. For an
   fzf selection, reuse the in-memory inventory that populated the picker.
2. Call `focus_instance(outputBufnr)` through its Neovim socket; this also
   confirms that Neovim is responsive and the cc.nvim instance still exists.
3. Switch the current tmux client to the exact session ID when necessary.
4. Select the exact tmux window ID.
5. Select the exact tmux pane ID.
6. Exit successfully so the tmux popup closes.

If the agent vanished between selection and switching, report that and leave
the current tmux window unchanged. If cc.nvim focus succeeds but tmux switching
fails, report both facts explicitly.

The initial implementation may require execution from inside tmux. If `$TMUX`
is absent, listing still works, but switching should fail with a clear message
and print the target session/window/pane IDs.

## tmux and Bash Integration

Add a real launcher with a Bun shebang:

```text
~/.config/agents/bin/agents
```

Add the Bash alias:

```bash
alias agents="$HOME/.config/agents/bin/agents"
```

The tmux binding must invoke the executable path, not the alias, because aliases
are not reliably expanded in the popup's noninteractive shell:

```tmux
bind-key a display-popup -E -w 80 -h 12 "$HOME/.config/agents/bin/agents -i"
```

Keep the existing `cs` command during rollout. Remove or redirect it only after
the new inventory has been used successfully for both Claude and Codex agents.

## Implementation Order

### 1. Add and test the cc.nvim API

- Add the JSON-safe snapshot builder.
- Store the instance cwd.
- Centralize state calculation.
- Normalize `awaiting_input` for Claude and Codex.
- Add `list_instances()`.
- Add `focus_instance(output_bufnr)`.
- Test multiple simultaneous instances, both providers, every state, JSON
  encoding, and hidden-buffer focus restoration.

### 2. Implement hardened Neovim discovery

- Adapt the multi-temp-root scanning from nvim-lsp-bridge.
- Parse PID and cwd without RPC where possible.
- Filter stale sockets.
- Probe all live sockets concurrently with timeouts.
- Query cc.nvim snapshots only from responsive Neovims.
- Warn about wedged Neovims instead of silently omitting them.

### 3. Implement tmux discovery and correlation

- Parse stable tmux session/window/pane IDs and paths.
- Match Neovim PID to pane PID through process ancestry.
- Add the single-match cwd fallback from the spirit of `wt.sh`.
- Unit test direct PID, descendant PID, unique cwd fallback, ambiguous cwd,
  missing tmux, and paths containing spaces.

### 4. Implement noninteractive CLI output

- Build the merged inventory and derive project labels.
- Load and validate `config.ts`.
- Implement the configurable comparator, including ordered project groups,
  trailing-`*` prefix matching, manual project ranks, and alphabetical fallback.
- Add default TSV output.
- Add `--json`.
- Add deterministic exit behavior and stderr warnings.
- Add `switch <key>`.

This step makes the tool useful to other agents before adding the picker.

### 5. Add the fzf popup

- Add `-i` using the exact same inventory and switch function.
- Keep the initial picker to a single formatted list with no preview/actions.
- Add the tmux popup binding.
- Add the Bash alias.

### 6. Live smoke test

Verify with a mix of:

- multiple Neovim tmux windows
- multiple cc.nvim agents inside one Neovim
- Claude and Codex providers
- working and ready agents
- a permission prompt producing `waiting`
- a newly starting agent with no session ID
- a stale socket
- a deliberately blocked/unresponsive Neovim RPC endpoint
- direct `agents switch <key>` and interactive `agents -i`
- project-first sorting with `openspace*` grouped first
- changing `projectOrder`, `statusOrder`, and `sort.by` in the config

## Acceptance Criteria

The first pass is complete when:

- Every responsive live cc.nvim Claude and Codex instance appears exactly once.
- Multiple agents in one Neovim are listed and individually switchable.
- The cc.nvim snapshot's `working`, `waiting`, `starting`, `interrupting`,
  `ready`, and `exited` states agree with cc.nvim's own status display; the CLI
  filters `exited` snapshots from its running-agent inventory.
- Stale sockets do not create phantom agents.
- A wedged Neovim produces a bounded warning rather than hanging discovery or
  disappearing silently.
- Discovery still works when the caller's `$TMPDIR` is overridden.
- Sorting is controlled entirely by `config.ts`; `openspace` and its worktrees
  appear first by default, configured projects follow in manual order, and
  unlisted projects fall back alphabetically.
- TSV, JSON, and fzf use the same configured order.
- `agents`, `agents --json`, and `agents switch <key>` never prompt.
- `agents -i` opens in a tmux popup and Enter lands on the exact cc.nvim agent.
- No first-pass command can interrupt, close, kill, or send input to an agent.
- The existing `cs` and `wt` workflows continue working during rollout.

## Explicitly Deferred

- Interrupt/stop/close/kill actions
- Sending prompts
- Starting or resuming agents
- Automatic refresh and a persistent dashboard
- fzf preview panes and extra action bindings
- Notifications when an agent needs attention
- tmux status-bar counters
- Transcript parsing or provider-specific session-file discovery
- A daemon, cache, registry, or database
- Cross-machine or SSH discovery
- Extracting shared Neovim discovery into a separate package
