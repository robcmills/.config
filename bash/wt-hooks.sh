# Per-repo hooks for wt.sh, keyed by the main repo's basename.
# Sourced by wt.sh; nothing here runs on its own.
#
# wt_hook_defaults <basename>
#   Runs after `wt new` resolves the repo and before the worktree exists.
#   May set SUBDIR when the caller did not pass subdir=.
#
# wt_hook_post_new <basename> <repo> <worktree>
#   Runs after `git worktree add` succeeds and before the tmux window opens.

wt_hook_defaults() {
  case "$1" in
    openspace)
      : "${SUBDIR:=web/icedemon}"
      ;;
  esac
}

wt_hook_post_new() {
  local basename="$1" repo="$2" worktree="$3"
  case "$basename" in
    openspace)
      # Local build config is gitignored but required by the dev server.
      local src_local="$repo/web/icedemon/config/local"
      local dst_local="$worktree/web/icedemon/config/local"
      mkdir -p "$dst_local"
      cp "$src_local/BuildDev.js" "$dst_local/BuildDev.js"
      cp "$src_local/BuildProd.js" "$dst_local/BuildProd.js"
      ;;
  esac
}
