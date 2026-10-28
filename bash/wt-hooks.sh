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

# Install deps and generated sources in the background so the tmux window
# opens right away. The log lives in the worktree's git dir, out of `git
# status`, and goes away with `wt rm`. Every fd is redirected so callers that
# read wt's stdout/stderr (jarvis new) don't wait on the install.
wt_openspace_install() {
  local worktree="$1"
  local icedemon="$worktree/web/icedemon"
  local log
  log="$(git -C "$worktree" rev-parse --absolute-git-dir)/wt-install.log"
  # Resolve pnpm before fnm switches node: ~/.local/shims/pnpm supplies
  # NPM_TOKEN, and fnm exec would put node's own pnpm ahead of it on PATH.
  local pnpm node_version
  pnpm="$(command -v pnpm)" || { echo "wt: pnpm not found; skipping install" >&2; return 0; }
  node_version="$(cat "$icedemon/.nvmrc" 2>/dev/null || true)"
  local -a run=()
  if [ -n "$node_version" ] && command -v fnm >/dev/null 2>&1; then
    run=(fnm exec --using="$node_version" --)
  fi
  # The shim execs the first other pnpm on PATH. If node's bin dir has no
  # pnpm, that is another node's corepack shim, which crashes under this
  # node (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING). So give this node its own
  # pnpm via its own corepack, which still honours packageManager.
  local script='
    echo "[wt] $(date) pnpm install"
    bin=$(dirname "$(command -v node)")
    if [ ! -x "$bin/pnpm" ]; then
      if [ -x "$bin/corepack" ]; then
        echo "[wt] node $(node -v) has no pnpm; running corepack enable pnpm"
        "$bin/corepack" enable pnpm || { echo "[wt] corepack enable pnpm failed"; echo "[wt] $(date) exit 1"; exit 1; }
      else
        echo "[wt] node $(node -v) has neither pnpm nor corepack in $bin; install pnpm for this node"
        echo "[wt] $(date) exit 1"; exit 1
      fi
    fi
    "$1" install && "$1" after-install; rc=$?; echo "[wt] $(date) exit $rc"'
  (
    cd "$icedemon" || exit 1
    nohup ${run[@]+"${run[@]}"} bash -c "$script" \
      _ "$pnpm" </dev/null >"$log" 2>&1 &
  )
  echo "wt: pnpm install running in background; log: $log" >&2
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
      wt_openspace_install "$worktree"
      ;;
  esac
}
