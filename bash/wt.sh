#!/usr/bin/env bash
set -euo pipefail

# wt: git worktrees under ~/src/<repo-basename>-<name>, each with a tmux
# window running Neovim and Claude Code memory shared with the main repo.
#
# Named arguments only. `repo=` defaults to the main repo of the current
# directory. Per-repo behavior lives in wt-hooks.sh next to this script.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=wt-hooks.sh
. "$SCRIPT_DIR/wt-hooks.sh"

usage() {
  cat <<'EOF'
Usage:
  wt new name=<n> repo=<path> [subdir=<s>] [window=<w>] [--json]
  wt ls [repo=<path>] [-i]            # print names; -i: fzf picker + switch
  wt switch name=<n> [repo=<path>]
  wt rm name=<n>... [repo=<path>]
  wt rm -i [repo=<path>]              # fzf multi-select
  wt -i                               # same as: wt ls -i

repo= defaults to the main repo of the current directory.
Worktrees land at ~/src/<repo-basename>-<name>.
EOF
}

die() {
  echo "wt: $*" >&2
  exit 1
}

# --- argument parsing -------------------------------------------------------

NAMES=()
REPO_ARG=""
SUBDIR=""
SUBDIR_GIVEN=0
WINDOW=""
JSON=0
INTERACTIVE=0

parse_args() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      name=*) NAMES+=("${arg#name=}") ;;
      repo=*) REPO_ARG="${arg#repo=}" ;;
      subdir=*) SUBDIR="${arg#subdir=}"; SUBDIR_GIVEN=1 ;;
      window=*) WINDOW="${arg#window=}" ;;
      --json) JSON=1 ;;
      -i) INTERACTIVE=1 ;;
      *) usage >&2; die "unknown argument '$arg'" ;;
    esac
  done
}

require_single_name() {
  if [ "${#NAMES[@]}" -ne 1 ]; then
    usage >&2
    die "exactly one name=<n> is required"
  fi
  case "${NAMES[0]}" in
    ""|*/*) die "invalid name '${NAMES[0]}'" ;;
  esac
}

# --- repo resolution --------------------------------------------------------

# Sets REPO (absolute path to the main worktree) and BASENAME.
resolve_repo() {
  local candidate
  if [ -n "$REPO_ARG" ]; then
    candidate="${REPO_ARG/#\~/$HOME}"
    [ -d "$candidate" ] || die "repo not found: $candidate"
    candidate="$(realpath "$candidate")"
  else
    candidate="$PWD"
  fi
  # The first entry of `git worktree list` is always the main worktree, so
  # running from inside a linked worktree still resolves to the main repo.
  REPO="$(git -C "$candidate" worktree list --porcelain 2>/dev/null \
    | head -n 1 | sed 's/^worktree //')"
  [ -n "$REPO" ] || die "not a git repo: $candidate (pass repo=<path>)"
  BASENAME="$(basename "$REPO")"
}

worktree_path() {
  echo "$HOME/src/${BASENAME}-$1"
}

# Claude Code keys project dirs by replacing every non-alphanumeric character
# in the absolute cwd with '-'.
claude_project_dir() {
  echo "$HOME/.claude/projects/$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '-')"
}

list_worktree_names() {
  local prefix="$HOME/src/${BASENAME}-"
  git -C "$REPO" worktree list --porcelain \
    | sed -n 's/^worktree //p' \
    | while read -r path; do
        case "$path" in "$prefix"*) echo "${path#"$prefix"}" ;; esac
      done
}

# --- subcommands ------------------------------------------------------------

switch_to_worktree() {
  local name="$1"
  local worktree
  worktree="$(worktree_path "$name")"

  if tmux select-window -t "=$name" 2>/dev/null; then
    return 0
  fi

  local match
  match=$(tmux list-panes -a -F '#{window_id} #{pane_current_path}' \
    | while read -r wid wpath; do
        case "$wpath" in "$worktree"*) echo "$wid"; break;; esac
      done)
  if [ -n "$match" ]; then
    tmux select-window -t "$match"
  else
    echo "No tmux window found for worktree '$name'" >&2
    return 1
  fi
}

remove_worktree() {
  local name="$1"
  local worktree
  worktree="$(worktree_path "$name")"
  echo "Removing $name..."
  tmux kill-window -t "=$name" 2>/dev/null || true

  # Rename the worktree out of the way (instant same-filesystem rename),
  # prune git's metadata, then delete the contents asynchronously. The big
  # cost is unlinking node_modules; doing it in the background returns
  # control to the user in well under a second.
  if [ -d "$worktree" ]; then
    local trash="$HOME/src/.wt-trash-${BASENAME}-${name}-$$"
    mv "$worktree" "$trash"
    ( nohup rm -rf "$trash" >/dev/null 2>&1 & )
  fi
  git -C "$REPO" worktree prune

  echo "  Done"
}

# Trash dirs from a prior wt rm are expected to linger for a few minutes
# while their background rm runs (node_modules is slow to unlink). Only treat
# a dir as orphaned when no rm is working on it, and relaunch the delete.
reap_orphaned_trash() {
  local dir
  for dir in "$HOME"/src/.wt-trash-*; do
    [ -d "$dir" ] || continue
    if pgrep -f "rm -rf $dir" >/dev/null 2>&1; then
      continue
    fi
    echo "Relaunching delete of orphaned trash dir: $dir" >&2
    ( nohup rm -rf "$dir" >/dev/null 2>&1 & )
  done
}

json_string() {
  # Minimal JSON string escaping; paths and names never contain control chars.
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

cmd_new() {
  require_single_name
  local name="${NAMES[0]}"
  [ -n "$REPO_ARG" ] || die "repo=<path> is required for 'wt new'"
  resolve_repo

  if [ "$SUBDIR_GIVEN" -eq 0 ]; then
    wt_hook_defaults "$BASENAME"
  fi
  SUBDIR="${SUBDIR#/}"
  SUBDIR="${SUBDIR%/}"

  local worktree dir
  worktree="$(worktree_path "$name")"
  [ ! -e "$worktree" ] || die "already exists: $worktree"
  if [ -n "$SUBDIR" ]; then
    dir="$worktree/$SUBDIR"
  else
    dir="$worktree"
  fi

  git -C "$REPO" worktree add "$worktree" >&2

  wt_hook_post_new "$BASENAME" "$REPO" "$worktree"

  # Memory lives with the main repo's project dir (the subdir one when the
  # repo has a subdir) and is symlinked into each worktree's project dirs, so
  # memories are shared regardless of which cwd Claude is started from.
  local canonical
  if [ -n "$SUBDIR" ]; then
    canonical="$(claude_project_dir "$REPO/$SUBDIR")/memory"
  else
    canonical="$(claude_project_dir "$REPO")/memory"
  fi
  mkdir -p "$canonical"

  local proj_dirs=("$(claude_project_dir "$worktree")")
  if [ -n "$SUBDIR" ]; then
    proj_dirs+=("$(claude_project_dir "$dir")")
  fi
  local proj
  for proj in "${proj_dirs[@]}"; do
    mkdir -p "$proj"
    rm -rf "$proj/memory" 2>/dev/null
    ln -s "$canonical" "$proj/memory"
  done

  if [ ! -d "$dir" ]; then
    echo "wt: subdir '$SUBDIR' not found in worktree; opening at its root" >&2
    dir="$worktree"
  fi

  local window_name="${WINDOW:-$name}"
  local window_id=""
  if window_id="$(tmux new-window -P -F '#{window_id}' -n "$window_name" -c "$dir" 2>/dev/null)"; then
    tmux send-keys -t "$window_id" nvim Space . Enter
  else
    window_id=""
    echo "wt: tmux window not created (is tmux running?)" >&2
  fi

  if [ "$JSON" -eq 1 ]; then
    local branch
    branch="$(git -C "$worktree" rev-parse --abbrev-ref HEAD)"
    printf '{"name":%s,"path":%s,"branch":%s,"window_id":%s,"subdir":%s}\n' \
      "$(json_string "$name")" \
      "$(json_string "$worktree")" \
      "$(json_string "$branch")" \
      "$([ -n "$window_id" ] && json_string "$window_id" || echo null)" \
      "$(json_string "$SUBDIR")"
  else
    echo "$worktree"
  fi
}

cmd_ls() {
  [ "${#NAMES[@]}" -eq 0 ] || die "'wt ls' takes no name="
  resolve_repo
  local worktrees
  worktrees="$(list_worktree_names)"

  if [ "$INTERACTIVE" -eq 0 ]; then
    [ -n "$worktrees" ] && echo "$worktrees"
    return 0
  fi

  if [ -z "$worktrees" ]; then
    echo "No worktrees found"
    return 0
  fi
  local selected
  selected=$(echo "$worktrees" | fzf --layout=reverse --prompt="Select worktree: ") || return 0
  switch_to_worktree "$selected"
}

cmd_switch() {
  require_single_name
  resolve_repo
  switch_to_worktree "${NAMES[0]}"
}

cmd_rm() {
  resolve_repo
  reap_orphaned_trash

  if [ "$INTERACTIVE" -eq 1 ]; then
    local worktrees selected name
    worktrees="$(list_worktree_names)"
    if [ -z "$worktrees" ]; then
      echo "No worktrees found"
      return 0
    fi
    selected=$(echo "$worktrees" | fzf --multi --layout=reverse --prompt="Select worktrees to remove (TAB to multi-select): ") || return 0
    for name in $selected; do
      remove_worktree "$name"
    done
    return 0
  fi

  if [ "${#NAMES[@]}" -eq 0 ]; then
    usage >&2
    die "at least one name=<n> is required (or -i)"
  fi
  local name
  for name in "${NAMES[@]}"; do
    case "$name" in ""|*/*) die "invalid name '$name'" ;; esac
    remove_worktree "$name"
  done
}

# --- dispatch ---------------------------------------------------------------

cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
  new)    parse_args "$@"; cmd_new ;;
  ls)     parse_args "$@"; cmd_ls ;;
  switch) parse_args "$@"; cmd_switch ;;
  rm)     parse_args "$@"; cmd_rm ;;
  -i)     parse_args "$@"; INTERACTIVE=1; cmd_ls ;;
  -h|--help|help) usage ;;
  "")     usage; exit 1 ;;
  *)      usage >&2; die "unknown command '$cmd'" ;;
esac
