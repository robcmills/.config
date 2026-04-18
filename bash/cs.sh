#!/usr/bin/env bash
# cs — Claude Switcher. List all running Claude Code instances, jump to one.
set -euo pipefail

SRC_DIR="$HOME/src/"

status_priority() {
  case "$1" in
    waiting) echo 1 ;;
    done)    echo 2 ;;
    working) echo 3 ;;
    error)   echo 4 ;;
    idle)    echo 5 ;;
    *)       echo 9 ;;
  esac
}

format_age() {
  local started_ms=$1
  local now_s diff_s
  now_s=$(date +%s)
  diff_s=$(( now_s - started_ms / 1000 ))
  if   (( diff_s < 60 ));    then echo "${diff_s}s"
  elif (( diff_s < 3600 ));  then echo "$((diff_s/60))m"
  elif (( diff_s < 86400 )); then echo "$((diff_s/3600))h"
  else                            echo "$((diff_s/86400))d"
  fi
}

relative_cwd() {
  local cwd=$1
  if   [[ "$cwd" == "$SRC_DIR"* ]]; then echo "${cwd#"$SRC_DIR"}"
  elif [[ "$cwd" == "$HOME/"*  ]]; then echo "~/${cwd#"$HOME/"}"
  else echo "$cwd"
  fi
}

# Infer agent status from transcript tail.
# Echoes one of: idle, working, done. (waiting/error deferred per plan.)
infer_status() {
  local trans=$1
  [[ -z "$trans" || ! -s "$trans" ]] && { echo "idle"; return; }
  local last
  last=$(jq -c 'select(.type=="user" or .type=="assistant")' "$trans" 2>/dev/null | tail -1)
  [[ -z "$last" ]] && { echo "idle"; return; }
  local t ctype
  t=$(jq -r '.type' <<<"$last")
  if [[ "$t" == "assistant" ]]; then
    ctype=$(jq -r '.message.content[0].type // "unknown"' <<<"$last")
    [[ "$ctype" == "text" ]] && { echo "done"; return; }
  fi
  echo "working"
}

# First user-submitted prompt (string content), trimmed to 120 chars, newlines flattened.
first_user_prompt() {
  local trans=$1
  [[ -z "$trans" || ! -s "$trans" ]] && return
  jq -r 'select(.type=="user" and (.message.content|type)=="string") | .message.content' "$trans" 2>/dev/null \
    | head -1 \
    | tr '\n\t' '  ' \
    | awk '{ if (length($0) > 120) print substr($0, 1, 117) "..."; else print $0 }'
}

# Walk $1's PPID ancestor chain; echoes ancestors space-separated, closest first.
ancestors_of() {
  local p=$1 out=""
  while [[ -n "$p" && "$p" != "1" && "$p" != "0" ]]; do
    out="$out $p"
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
  echo "$out"
}

# Build map: tmux pane_pid → "window_id pane_id"
declare -A PANE_MAP=()
if [[ -n "${TMUX:-}" ]]; then
  while read -r ppid wid pid; do
    [[ -n "$ppid" ]] && PANE_MAP["$ppid"]="$wid $pid"
  done < <(tmux list-panes -a -F '#{pane_pid} #{window_id} #{pane_id}' 2>/dev/null || true)
fi

find_tmux_target() {
  local cc_pid=$1
  (( ${#PANE_MAP[@]} == 0 )) && return
  local a
  for a in $(ancestors_of "$cc_pid"); do
    if [[ -n "${PANE_MAP[$a]:-}" ]]; then
      echo "${PANE_MAP[$a]}"
      return
    fi
  done
}

rows=()
shopt -s nullglob
for sf in "$HOME"/.claude/sessions/*.json; do
  pid=$(jq -r .pid "$sf" 2>/dev/null) || continue
  kind=$(jq -r .kind "$sf")
  entry=$(jq -r '.entrypoint // ""' "$sf")
  [[ "$kind" != "interactive" ]] && continue
  # Skip subagents (sdk-cli) — they share sessionId with the user-facing cli instance.
  [[ "$entry" != "cli" ]] && continue
  kill -0 "$pid" 2>/dev/null || continue

  sid=$(jq -r .sessionId "$sf")
  cwd=$(jq -r .cwd "$sf")
  started=$(jq -r .startedAt "$sf")

  trans=""
  for t in "$HOME/.claude/projects/"*/"$sid.jsonl"; do
    [[ -f "$t" ]] && { trans=$t; break; }
  done

  status=$(infer_status "$trans")
  snippet=$(first_user_prompt "$trans")
  [[ -z "$snippet" ]] && snippet="(no prompt yet)"
  age=$(format_age "$started")
  cwd_rel=$(relative_cwd "$cwd")

  target=$(find_tmux_target "$pid" || true)
  wid="${target%% *}"
  pane_id=""
  [[ -n "$target" && "$target" == *" "* ]] && pane_id="${target##* }"

  prio=$(status_priority "$status")

  # Single line, tab-separated:
  # col1 = padded display (what fzf shows); cols 2+ are hidden payload
  display=$(printf '%-30s  %-8s  %4s  %s' "$cwd_rel" "$status" "$age" "$snippet")
  rows+=("$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' \
    "$prio	$display" "$pid" "$wid" "$pane_id" "$sid" "$cwd" "${trans:-}" "$status")")
done

(( ${#rows[@]} == 0 )) && { echo "No running Claude Code instances."; exit 0; }

# Sort by priority prefix (first tab field, numeric), then strip prefix before display.
sorted=$(printf '%s\n' "${rows[@]}" | sort -t$'\t' -k1,1n | sed $'s/^[0-9]*\t//')

preview_cmd='
  pid={2}; sid={5}; cwd={6}; trans={7}; status={8}
  printf "pid:         %s\n" "$pid"
  printf "session:     %s\n" "$sid"
  printf "status:      %s\n" "$status"
  printf "cwd:         %s\n" "$cwd"
  printf "transcript:  %s\n" "$trans"
  if [ -n "$trans" ] && [ -s "$trans" ]; then
    printf "\n── first user message ──\n"
    jq -r "select(.type==\"user\" and (.message.content|type)==\"string\") | .message.content" "$trans" 2>/dev/null | head -20
    printf "\n── last assistant message ──\n"
    jq -rs "map(select(.type==\"assistant\") | .message.content // [] | map(select(.type==\"text\") | .text) | join(\"\n\")) | map(select(length > 0)) | last // \"\"" "$trans" 2>/dev/null | head -20
  fi
'

selected=$(printf '%s\n' "$sorted" | fzf \
  --layout=reverse \
  --delimiter=$'\t' \
  --with-nth=1 \
  --prompt='cs> ' \
  --preview="$preview_cmd" \
  --preview-window=down:60%:wrap) || exit 0

IFS=$'\t' read -r _display pid wid pane_id sid cwd trans status <<<"$selected"

if [[ -z "${TMUX:-}" ]]; then
  echo "Not inside tmux; selected session: pid=$pid cwd=$cwd"
  exit 0
fi

if [[ -z "$wid" ]]; then
  echo "No tmux window found for session (pid=$pid, cwd=$cwd)"
  exit 1
fi

tmux select-window -t "$wid"

# Best-effort: focus the matching terminal buffer inside nvim.
if [[ -n "$pane_id" ]]; then
  pane_pid=$(tmux display -p -t "$pane_id" '#{pane_pid}' 2>/dev/null || true)
  if [[ -n "$pane_pid" ]]; then
    nvim_pid=""
    comm=$(ps -o comm= -p "$pane_pid" 2>/dev/null | awk '{print $NF}')
    if [[ "$comm" == *nvim* ]]; then
      nvim_pid=$pane_pid
    else
      nvim_pid=$(pgrep -P "$pane_pid" nvim 2>/dev/null | head -1 || true)
    fi
    if [[ -n "$nvim_pid" ]]; then
      socket=$(ls "${TMPDIR%/}/nvim.$USER/"*/"nvim.$nvim_pid.0" 2>/dev/null | head -1 || true)
      if [[ -n "$socket" ]]; then
        nvim --server "$socket" --remote-expr "v:lua.require('cs').focus($pid)" >/dev/null 2>&1 || true
      fi
    fi
  fi
fi
