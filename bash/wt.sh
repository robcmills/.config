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
    project="${2:-openspace}"
    get_project_config "$project"

    worktrees=$(git -C "$REPO" worktree list --porcelain \
      | grep '^worktree ' \
      | sed 's/^worktree //' \
      | grep "/${PROJECT_NAME}-" \
      | sed "s|.*/${PROJECT_NAME}-||")

    if [ -z "$worktrees" ]; then
      echo "No worktrees found"
      exit 0
    fi

    selected=$(echo "$worktrees" | fzf --layout=reverse --prompt="Select worktree: ") || exit 0
    worktree_path="$HOME/src/${PROJECT_NAME}-$selected"

    # Try matching by window name first
    if ! tmux select-window -t "$selected" 2>/dev/null; then
      # Fall back: find any pane (across all windows) inside the worktree directory
      match=$(tmux list-panes -a -F '#{window_id} #{pane_current_path}' \
        | while read -r wid wpath; do
            case "$wpath" in "$worktree_path"*) echo "$wid"; break;; esac
          done)
      if [ -n "$match" ]; then
        tmux select-window -t "$match"
      else
        echo "No tmux window found for worktree '$selected'"
        exit 1
      fi
    fi
    ;;

  rm)
    project="${2:-openspace}"
    get_project_config "$project"

    worktrees=$(git -C "$REPO" worktree list --porcelain \
      | grep '^worktree ' \
      | sed 's/^worktree //' \
      | grep "/${PROJECT_NAME}-" \
      | sed "s|.*/${PROJECT_NAME}-||")

    if [ -z "$worktrees" ]; then
      echo "No worktrees found"
      exit 0
    fi

    selected=$(echo "$worktrees" | fzf --multi --layout=reverse --prompt="Select worktrees to remove (TAB to multi-select): ") || exit 0

    for name in $selected; do
      worktree="$HOME/src/${PROJECT_NAME}-$name"
      echo "Removing $name..."
      tmux kill-window -t "$name" 2>/dev/null || true
      if ! git -C "$REPO" worktree remove "$worktree" --force 2>/dev/null; then
        rm -rf "$worktree"
        git -C "$REPO" worktree prune
      fi
      echo "  Done"
    done
    ;;

  *)
    echo "Usage: wt {new <name> [project] | ls [project] | rm [project]}"
    echo "  project: openspace (default), osutils"
    ;;
esac
