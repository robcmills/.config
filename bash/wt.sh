#!/usr/bin/env bash
set -euo pipefail

REPO="$HOME/src/openspace"

case "${1:-}" in
  new)
    name="${2:-}"
    if [ -z "$name" ]; then
      echo "Usage: wt new <name>"
      exit 1
    fi

    worktree="$HOME/src/openspace-$name"
    dir="$worktree/web/icedemon"

    git -C "$REPO" worktree add "$worktree" || exit 1
    tmux new-window -n "$name" -c "$dir"
    tmux send-keys -t "$name" nvim Space . Enter
    ;;

  ls)
    worktrees=$(git -C "$REPO" worktree list --porcelain \
      | grep '^worktree ' \
      | sed 's/^worktree //' \
      | grep '/openspace-' \
      | sed 's|.*/openspace-||')

    if [ -z "$worktrees" ]; then
      echo "No worktrees found"
      exit 0
    fi

    selected=$(echo "$worktrees" | fzf --layout=reverse --prompt="Select worktree: ") || exit 0
    worktree_path="$HOME/src/openspace-$selected"

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
    worktrees=$(git -C "$REPO" worktree list --porcelain \
      | grep '^worktree ' \
      | sed 's/^worktree //' \
      | grep '/openspace-' \
      | sed 's|.*/openspace-||')

    if [ -z "$worktrees" ]; then
      echo "No worktrees found"
      exit 0
    fi

    selected=$(echo "$worktrees" | fzf --multi --layout=reverse --prompt="Select worktrees to remove (TAB to multi-select): ") || exit 0

    for name in $selected; do
      worktree="$HOME/src/openspace-$name"
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
    echo "Usage: wt {new|ls|rm} [name]"
    ;;
esac
