# path

# pico8
export PATH=~/pico8/bin:$PATH

# aws cli
export PATH=~/.local/bin:$PATH

# homebrew
export PATH=/opt/homebrew/bin:$PATH

# yarn
export PATH="$HOME/.yarn/bin:$PATH"
alias y='yarn'
alias yd='yarn dev'

# prompt
# Set colors for bash using escape sequences
COLOR_DEF='\[\e[0m\]' # Default color
COLOR_USR='\[\e[38;5;243m\]' # User color (grey)
COLOR_DIR='\[\e[38;5;82m\]' # Directory color (green)
COLOR_GIT='\[\e[38;5;39m\]' # Git branch color (blue)
COLOR_VENV='\[\e[38;5;213m\]' # Virtual env color (pink)

export CLICOLOR=1
export LSCOLORS=ExFxBxDxCxegedabagacad

parse_git_branch() {
  git branch 2> /dev/null | sed -n -e 's/^\* \(.*\)/[\1]/p'
}

show_virtual_env() {
  if [ -n "$VIRTUAL_ENV" ]; then
    echo "($(basename $VIRTUAL_ENV))"
  fi
}

PS1="${COLOR_DIR}\w ${COLOR_GIT}\$(parse_git_branch)${COLOR_DEF}\n» "

export SHELL='/opt/homebrew/bin/bash'

# neovim
export EDITOR='nvim'
alias nv='nvim'

# edit bash profile
alias ebp='nv ~/.bash_profile'
# source bash profile
alias sbp='source ~/.bash_profile'

alias c='clear'

# tmux
export TMUX_CONFIG='~/.config/tmux/.tmux.conf'
alias tn="tmux -u -f $TMUX_CONFIG new"
alias ta="tmux -u -f $TMUX_CONFIG attach"
alias tt="nv $TMUX_CONFIG"

# git
function recent_branches() {
  local branches
  branches=$(git for-each-ref --count=9 --sort=-committerdate refs/heads/ --format="%(refname:short)")
  echo "Recent branches:"
  echo "0) Cancel"
  echo "$branches" | nl -w 1 -n ln -s ') '
  read -p "Select a branch: " choice

  if ! [[ $choice =~ ^[0-9]+$ ]]; then
    echo "Invalid selection. Must be a number."
    return 1
  fi

  if [ "$choice" -eq 0 ]; then
    echo "Operation cancelled"
    return 0
  fi

  if [ "$choice" -gt $(echo "$branches" | wc -l) ]; then
    echo "Invalid selection."
    return 1
  fi

  selected_branch=$(echo "$branches" | sed -n "${choice}p")
  git checkout "$selected_branch"
}
alias gt='recent_branches'

# password
alias pw="~/password.sh"
# api keys env vars and secrets
source ~/.keys

# disk usage
alias dus="du -hs .[^.]* | sort -h"

# git
alias gs='git status --short --branch'
alias gsl='git status'
alias gst='git stash --include-untracked'
alias gss='git stash show -p'
alias ga='git add --all :/'
alias gc="git add --all && git commit"
alias gd="git --no-pager diff"
alias gb="git branch"
alias gk="git checkout"
alias gl="git pull"
alias gf="git fetch"
alias gr="git reset --hard"
alias gu="git push --set-upstream origin "
alias gv="git checkout development"
alias gmv="git merge development"
alias gm="git checkout master"
alias gmm="git merge master"
alias gnd="git clean -n" # dry
alias gn="git clean -fd"
alias gla="git reflog | cut -f 1 -d ' ' | head -n 1000 | xargs git log" # git log all
alias gbd="git branch | grep -v 'master' | xargs git branch -D"
alias greport="git log --format='%cd %Cgreen %s %Cred %D %Creset' --date=short --all --since=4.days.ago --author=robcmills"
alias gg="git log -n 10 --oneline"
alias gcm="git cherry -v master" # show only non-merge commits
alias gcv="git cherry -v development" # show only non-merge commits
alias gx="git diff --name-only --diff-filter=U" # show only conflicted files

function notify_success() {
  osascript -e "display notification \"$1\" with title \"Git Push\" subtitle \"Success\""
}
function notify_failure() {
  osascript -e "display notification \"Failed: $2\" with title \"Git Push\" subtitle \"Error\""
}

# background git push
function git_push() {
  (
    local log_file="/tmp/git-push-$(date +%Y%m%d-%H%M%S).log"
    git push > "$log_file" 2>&1
    if [ $? -eq 0 ]; then
      notify_success "Git push completed successfully!" "$log_file"
      rm "$log_file"
    else
      notify_failure "Git push failed! Check log: $log_file"
    fi
    sleep 10
  ) &
  echo "[Background] Git push started (PID: $!)"
}
alias gp="git_push"


# docker
alias d="docker"
alias dm="docker-machine"
alias dc="docker-compose"
alias dpsa="docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Size}}\t{{.Command}}\t{{.Status}}\t{{.Ports}}'"
alias dsa='docker stop $(docker ps -a -q)'

## OpenSpace

# https://nexus.osdevenv.net/#browse/browse

export OPENSPACE_EMAIL=rob@openspace.ai

alias brave='open -a "Brave Browser"'
alias chrome='open -a "Google Chrome"'
# reviews (PR's that need review assigned to me)
alias rev='brave "https://github.com/openspacelabs/openspace/pulls/review-requested/robcmills"'

# frontend
alias ice='cd ~/src/openspace/web/icedemon/ && nv .'

# nvm
export NVM_DIR="$HOME/.nvm"
alias lnvm=". $NVM_DIR/nvm.sh"

# Automatically switch to the Node version specified in the .nvmrc file
nvm_auto_switch() {
  if [[ -f .nvmrc && -r .nvmrc ]]; then
  lnvm
  export PATH="$NVM_DIR/versions/node/$(nvm current)/bin:$PATH"
  nvm use
  fi
}
# Override the 'cd' command
cd() {
  builtin cd "$@" && nvm_auto_switch
}

nvm_auto_switch

# backend

# ensure java is available to yarn install which runs openapi-codegen-cli
export JAVA_HOME="$HOME/.sdkman/candidates/java/current"
# source "$HOME/.sdkman/bin/sdkman-init.sh"

# aws auth
export AWS_PROFILE=os-dev 
export AWS_REGION=us-west-2
alias al='aws sso login --profile os-dev'
alias ai='aws sts get-caller-identity'

# https://docs.anthropic.com/en/docs/claude-code/amazon-bedrock
# Enable Bedrock integration for Claude Code
# export CLAUDE_CODE_USE_BEDROCK=1
# aws bedrock list-inference-profiles --region us-west-2 | jq '[.[][] | .inferenceProfileId]'
# export ANTHROPIC_MODEL='us.anthropic.claude-sonnet-4-20250514-v1:0'
# export ANTHROPIC_SMALL_FAST_MODEL='us.anthropic.claude-3-5-haiku-20241022-v1:0'
# Recommended output token settings for Bedrock
# export CLAUDE_CODE_MAX_OUTPUT_TOKENS=4096
# export MAX_THINKING_TOKENS=1024

# make local (this is the one Chris Hut uses)
alias ml='make e2e-local-build WORKERS=1 UPLOADS=1 ONEX_ENABLED=1 ONER_ENABLED=0 ONEX2_ENABLED=0 Z1_ENABLED=0 X3_ENABLED=0 SPHERE_ENABLED=0 SKIP_TESTS=TRUE'

alias dda='make docker-destroy-all'
alias gradleGenerateJooq='./gradlew :db:jooq:generateJooq'
alias gradleCompileJava='./gradlew compileJava'
alias format='make format-all' # run from repo root

# https://openspaceai.atlassian.net/wiki/spaces/ENG/pages/46956545/E2E+Tests#Local-Bind-Ports-(Postgres%2C-Redis)
export E2E_BIND_REDIS_PORT=6379
export E2E_BIND_PGPORT=5432

## psql connections

# tailscale: https://openspaceai.atlassian.net/wiki/spaces/ENG/pages/1300955174/Tailscale+Quick+Start

# staging.db.osdevenv.net
# as a single connection url: postgresql://openspace@staging.db.osdevenv.net/openspace

# use db pw from 1Password entries corresponding to the host (development.db.osdevenv.net)
alias pd="psql -U openspace -d openspace -h development.db.osdevenv.net"
# as a single connection url: postgresql://openspace@development.db.osdevenv.net/openspace

alias pj="psql -U openspace -d openspace -h jpn-prod-ro.db.openspace.ai"

# cypress env is not an rds so use db pw from 1password "K8 DB creds (for dev ephemeral postgres containers)"
alias pc="psql -U openspace -d openspace -h postgres.cypress.svc.cluster.local"
# as a single connection url: postgresql://openspace@postgres.cypress.svc.cluster.local/openspace

# connect to ephemeral stack db
# password in is 1Password -> OpenSpace -> K8 DB creds (for dev ephemeral postgres containers)
alias pe="psql -U openspace -d openspace -h postgres.eng-23327.svc.cluster.local"
# https://rad-1795-members.osdevenv.net/orgs
# as a single connection url: postgresql://openspace@postgres.rad-1795-members.svc.cluster.local/openspace
# as a single connection url: postgresql://openspace@postgres.pr-8099.svc.cluster.local/openspace
# as a single connection url: postgresql://openspace@postgres.group-admin.svc.cluster.local/openspace
# as a single connection url: postgresql://openspace@postgres.rad-5186.svc.cluster.local/openspace
# as a single connection url: postgresql://openspace@postgres.perseus.svc.cluster.local/openspace
# url format: postgresql://[user]@[host]/[database]

# Production readonly replica
# passwords in 1Password -> OpenSpace -> DataOps
# alias pp='psql -h us-prod-ro.db.openspace.ai -U readonly -d openspace'
alias pp='psql -h openspace-prod-replica.cpk74q4e5ebg.us-west-2.rds.amazonaws.com -U readonly -d openspace'

# url format: postgresql://readonly@openspace-prod-replica.cpk74q4e5ebg.us-west-2.rds.amazonaws.com/openspace
# url format: postgresql://readonly@us-prod-ro.db.openspace.ai/openspace
# latest: us-prod-ro.db.openspace.ai

# Set up fzf key bindings and fuzzy completion
# eval "$(fzf --bash)"

# Automatically added stuff

# nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH=$BUN_INSTALL/bin:$PATH

# ANSI color codes
ESC=$(printf '\033')
BLUE="${ESC}[34m"
CYAN="${ESC}[36m"
GREEN="${ESC}[32m"
NC="${ESC}[0m"
PURPLE="${ESC}[35m"
RED="${ESC}[31m"
YELLOW="${ESC}[33m"

git_search_recent() {
  query="$1"
  git --no-pager log -G "$query" -n 10 -p --date=short --pretty=format:'%h - %an - %ad %n%b' \
    | grep -E "(^[0-9a-f]{7,40}|^diff|$query)" \
    | sed -E "s/^([a-f0-9]+) - (.+) - ([0-9-]+)/\n${PURPLE}\1${NC} - ${CYAN}\2${NC} - ${GREEN}\3${NC}/g" \
    | sed -E "s/^diff --git a\/(.*) b\/.*/${YELLOW}\1${NC}/" \
    | sed -E "s/($query)/${BLUE}\1${NC}/g"
}

alias gsr=git_search_recent


rm_node_modules_progress() {
  # Count total files first
  total=$(find node_modules -type f | wc -l)
  # Use pv to show progress
  find node_modules -type f -print0 | pv -0 -l -s $total | xargs -0 rm -f
  rm -rf node_modules
}

alias rmn=rm_node_modules_progress

# https://github.com/openspacelabs/openspace/pull/2356
debugprod() {
  echo "get https://openspace.ai/api/self/cookie-jar
  save as ~/cookie-jar.txt
  Open config/local/BuildDev.js file.
  Set devServer property to:
  devServer: {
    url: 'https://openspace.ai',
    cookieJar: '~/cookie-jar.txt',
  },
  then run dev server\n"
}

alias dbp=debugprod

# fix type errors with ai agent

# Cron job that runs every day and pulls translations from lokalise and uploads to s3
# https://tc-ci.openspace.ai/buildConfiguration/Openspace_ReleaseManagementBuild_Translations/443157?expandBuildDeploymentsSection=false&hideTestsFromDependencies=false&hideProblemsFromDependencies=false&expandBuildChangesSection=true&showLog=443157_281_142&logView=flowAware

# python
# Setting PATH for Python 3.12
# The original version is saved in .bash_profile.pysave
PATH="/Library/Frameworks/Python.framework/Versions/3.12/bin:${PATH}"
export PATH

# Python is installed as
#   /opt/homebrew/bin/python3.11
#
# Unversioned and major-versioned symlinks `python`, `python3`, `python-config`, `python3-config`, `pip`, `pip3`, etc. pointing to
# `python3.11`, `python3.11-config`, `pip3.11` etc., respectively, are installed into
#   /opt/homebrew/opt/python@3.11/libexec/bin
#
# You can install Python packages with
#   pip3.11 install <package>
# They will install into the site-package directory
#   /opt/homebrew/lib/python3.11/site-packages
#
# `idle3.11` requires tkinter, which is available separately:
#   brew install python-tk@3.11
#
# gdbm (`dbm.gnu`) is no longer included in this formula, but it is available separately:
#   brew install python-gdbm@3.11
# `dbm.ndbm` changed database backends in Homebrew Python 3.11.
# If you need to read a database from a previous Homebrew Python created via `dbm.ndbm`,
# you'll need to read your database using the older version of Homebrew Python and convert to another format.
# `dbm` still defaults to `dbm.gnu` when it is installed.
#
# If you do not need a specific version of Python, and always want Homebrew's `python3` in your PATH:
#   brew install python3
#
# For more information about Homebrew and Python, see: https://docs.brew.sh/Homebrew-and-Python

# deno
. "/Users/robcmills/.deno/env"

# rust
. "$HOME/.cargo/env"

#THIS MUST BE AT THE END OF THE FILE FOR SDKMAN TO WORK!!!
export SDKMAN_DIR="$HOME/.sdkman"
[[ -s "$HOME/.sdkman/bin/sdkman-init.sh" ]] && source "$HOME/.sdkman/bin/sdkman-init.sh"

