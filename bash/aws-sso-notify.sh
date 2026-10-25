#!/usr/bin/env bash
# credential_process for AWS profiles that front an SSO profile, so an expired
# SSO login turns into a macOS notification instead of a silent failure.
#
# Usage (in ~/.aws/config):
#   [profile os-dev]
#   credential_process = /Users/robcmills/.config/bash/aws-sso-notify.sh os-dev-sso
#
# Prints the SSO profile's credentials in credential_process format. Valid
# credentials are cached until five minutes before they expire, since each
# `aws configure export-credentials` costs a Python startup. On failure it
# passes the CLI's error through, notifies at most once per profile every
# NOTIFY_INTERVAL seconds, and exits non-zero. It never logs in.

set -uo pipefail

profile="${1:?usage: aws-sso-notify.sh <sso-profile>}"
NOTIFY_INTERVAL=300
REFRESH_MARGIN=300

state_dir="${XDG_CACHE_HOME:-$HOME/.cache}/aws-sso-notify"
umask 077
mkdir -p "$state_dir"
cache="$state_dir/$profile.json"
stamp="$state_dir/$profile.notified"

now=$(date +%s)

if [ -s "$cache" ]; then
  expires=$(jq -r '.Expiration | sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601' "$cache" 2>/dev/null)
  if [ -n "$expires" ] && [ "$expires" -gt $((now + REFRESH_MARGIN)) ] 2>/dev/null; then
    cat "$cache"
    exit 0
  fi
fi

err=$(mktemp "$state_dir/err.XXXXXX")
trap 'rm -f "$err"' EXIT

if out=$(aws configure export-credentials --profile "$profile" --format process 2>"$err"); then
  printf '%s\n' "$out" >"$cache.tmp" && mv "$cache.tmp" "$cache"
  rm -f "$stamp"
  printf '%s\n' "$out"
  exit 0
fi

cat "$err" >&2
rm -f "$cache"

last=$(stat -f %m "$stamp" 2>/dev/null || echo 0)
if [ $((now - last)) -ge "$NOTIFY_INTERVAL" ]; then
  touch "$stamp"
  msg="Run: aws sso login --profile $profile"
  if ! grep -qiE 'sso|token|expired' "$err"; then
    msg="Credential lookup failed: $(head -c 150 "$err" | tr '\n"\\' '   ')"
  fi
  ( osascript -e "display notification \"$msg\" with title \"AWS credentials: $profile\" sound name \"Funk\"" \
      >/dev/null 2>&1 & ) || true
fi
exit 1
