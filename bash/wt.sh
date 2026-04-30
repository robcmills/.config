#!/usr/bin/env bash
set -euo pipefail

# Populate per-project vars used by the subcommands below.
#   REPO              — path to the main repo
#   PROJECT_NAME      — prefix used for worktree dirs (~/src/<project>-<name>)
#   SUBDIR            — subdir within the worktree to cd into (may be empty)
#   CANONICAL_MEMORY  — memory/ dir shared across all worktrees of this project
get_project_config() {
  case "${1:-openspace}" in
    openspace)
      REPO="$HOME/src/openspace"
      PROJECT_NAME="openspace"
      SUBDIR="web/icedemon"
      CANONICAL_MEMORY="$HOME/.claude/projects/-Users-robcmills-src-openspace-web-icedemon/memory"
      ;;
    osutils)
      REPO="$HOME/src/osutils"
      PROJECT_NAME="osutils"
      SUBDIR=""
      CANONICAL_MEMORY="$HOME/.claude/projects/-Users-robcmills-src-osutils/memory"
      ;;
    *)
      echo "Unknown project: $1 (expected: openspace, osutils)"
      exit 1
      ;;
  esac
}

is_project() {
  case "$1" in
    openspace|osutils) return 0 ;;
    *) return 1 ;;
  esac
}

list_worktree_names() {
  git -C "$REPO" worktree list --porcelain \
    | grep '^worktree ' \
    | sed 's/^worktree //' \
    | grep "/${PROJECT_NAME}-" \
    | sed "s|.*/${PROJECT_NAME}-||"
}

switch_to_worktree() {
  local name="$1"
  local worktree_path="$HOME/src/${PROJECT_NAME}-$name"

  if tmux select-window -t "$name" 2>/dev/null; then
    return 0
  fi

  local match
  match=$(tmux list-panes -a -F '#{window_id} #{pane_current_path}' \
    | while read -r wid wpath; do
        case "$wpath" in "$worktree_path"*) echo "$wid"; break;; esac
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
  local worktree="$HOME/src/${PROJECT_NAME}-$name"
  echo "Removing $name..."
  tmux kill-window -t "$name" 2>/dev/null || true
  if ! git -C "$REPO" worktree remove "$worktree" --force 2>/dev/null; then
    rm -rf "$worktree"
    git -C "$REPO" worktree prune
  fi
  echo "  Done"
}

case "${1:-}" in
  new)
    name="${2:-}"
    project="${3:-openspace}"
    if [ -z "$name" ]; then
      echo "Usage: wt new <name> [project]"
      exit 1
    fi

    get_project_config "$project"

    worktree="$HOME/src/${PROJECT_NAME}-$name"
    if [ -n "$SUBDIR" ]; then
      dir="$worktree/$SUBDIR"
    else
      dir="$worktree"
    fi

    git -C "$REPO" worktree add "$worktree" || exit 1

    # Ensure the canonical memory dir exists so the symlinks below aren't
    # dangling on first use for a project.
    mkdir -p "$CANONICAL_MEMORY"

    # Pre-create Claude Code project dirs and symlink memory/ to the canonical
    # location so memories/feedback are shared across all worktrees of this
    # project regardless of which cwd Claude is started from.
    proj_dirs=("$HOME/.claude/projects/-Users-robcmills-src-${PROJECT_NAME}-${name}")
    if [ -n "$SUBDIR" ]; then
      subdir_dashed=$(echo "$SUBDIR" | tr '/' '-')
      proj_dirs+=("$HOME/.claude/projects/-Users-robcmills-src-${PROJECT_NAME}-${name}-${subdir_dashed}")
    fi
    for proj in "${proj_dirs[@]}"; do
      mkdir -p "$proj"
      rm -rf "$proj/memory" 2>/dev/null
      ln -s "$CANONICAL_MEMORY" "$proj/memory"
    done

    tmux new-window -n "$name" -c "$dir"
    tmux send-keys -t "$name" nvim Space . Enter
    ;;

  ls)
    shift
    interactive=0
    if [ "${1:-}" = "-i" ]; then
      interactive=1
      shift
    fi
    project="${1:-openspace}"
    get_project_config "$project"

    worktrees=$(list_worktree_names)

    if [ "$interactive" -eq 0 ]; then
      # Non-interactive: just print names, one per line.
      [ -n "$worktrees" ] && echo "$worktrees"
      exit 0
    fi

    if [ -z "$worktrees" ]; then
      echo "No worktrees found"
      exit 0
    fi

    selected=$(echo "$worktrees" | fzf --layout=reverse --prompt="Select worktree: ") || exit 0
    switch_to_worktree "$selected"
    ;;

  switch)
    name="${2:-}"
    project="${3:-openspace}"
    if [ -z "$name" ]; then
      echo "Usage: wt switch <name> [project]" >&2
      exit 1
    fi
    get_project_config "$project"
    switch_to_worktree "$name"
    ;;

  rm)
    shift
    interactive=0
    if [ "${1:-}" = "-i" ]; then
      interactive=1
      shift
    fi

    # Separate trailing project arg (if any) from worktree names.
    project="openspace"
    names=()
    for arg in "$@"; do
      names+=("$arg")
    done
    if [ "${#names[@]}" -gt 0 ] && is_project "${names[-1]}"; then
      project="${names[-1]}"
      unset 'names[-1]'
    fi

    get_project_config "$project"

    if [ "$interactive" -eq 1 ]; then
      worktrees=$(list_worktree_names)
      if [ -z "$worktrees" ]; then
        echo "No worktrees found"
        exit 0
      fi
      selected=$(echo "$worktrees" | fzf --multi --layout=reverse --prompt="Select worktrees to remove (TAB to multi-select): ") || exit 0
      for name in $selected; do
        remove_worktree "$name"
      done
    else
      if [ "${#names[@]}" -eq 0 ]; then
        echo "Usage: wt rm <name...> [project]   (or: wt rm -i [project])" >&2
        exit 1
      fi
      for name in "${names[@]}"; do
        remove_worktree "$name"
      done
    fi
    ;;

  *)
    echo "Usage:"
    echo "  wt new <name> [project]"
    echo "  wt ls [-i] [project]            # default: print names; -i: fzf picker + switch"
    echo "  wt switch <name> [project]"
    echo "  wt rm [-i] <name...> [project]  # default: remove named; -i: fzf multi-select"
    echo "  project: openspace (default), osutils"
    ;;
esac
