# path

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
export CLICOLOR=1
export LSCOLORS=ExFxBxDxCxegedabagacad
parse_git_branch() {
  git branch 2> /dev/null | sed -n -e 's/^\* \(.*\)/[\1]/p'
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
source ~/.keys

# disk usage
alias dus="du -hs .[^.]* | sort -h"

# git
alias gs='git status --short --branch'
alias gsl='git status'
alias gstash='git stash --include-untracked'
alias gss='git stash show -p'
alias ga='git add --all :/'
alias gc="git add --all && git commit"
alias gd="git --no-pager diff"
alias gb="git branch"
alias gk="git checkout"
alias gp="git push"
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

# docker
alias d="docker"
alias dm="docker-machine"
alias dc="docker-compose"
alias dpsa="docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Size}}\t{{.Command}}\t{{.Status}}\t{{.Ports}}'"
alias dsa='docker stop $(docker ps -a -q)'

## OpenSpace

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
# use db pw from 1Password entries corresponding to the host
alias pd="psql -U openspace -d openspace -h development.db.osdevenv.net"
# as a single connection url: postgresql://openspace@development.db.osdevenv.net/openspace

alias pj="psql -U openspace -d openspace -h jpn-prod-ro.db.openspace.ai"
# cypress env is not an rds so use db pw from 1password "K8 DB creds (for dev ephemeral postgres containers)"
alias pc="psql -U openspace -d openspace -h postgres.cypress.svc.cluster.local"
# connect to ephemeral stack db
# password in is 1Password -> OpenSpace -> K8 DB creds (for dev ephemeral postgres containers)
alias pe="psql -U openspace -d openspace -h postgres.eng-23327.svc.cluster.local"
# as a single connection url: postgresql://openspace@postgres.eng-23327.svc.cluster.local/openspace
# url format: postgresql://[user]@[host]/[database]

# Production readonly replica
# passwords in 1Password -> OpenSpace -> DataOps
# alias pp='psql -h us-prod-ro.db.openspace.ai -U readonly -d openspace'
alias pp='psql -h openspace-prod-replica.cpk74q4e5ebg.us-west-2.rds.amazonaws.com -U readonly -d openspace'
# url format: postgresql://readonly@openspace-prod-replica.cpk74q4e5ebg.us-west-2.rds.amazonaws.com/openspace

# Set up fzf key bindings and fuzzy completion
eval "$(fzf --bash)"

# Automatically added stuff

# nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH=$BUN_INSTALL/bin:$PATH

#THIS MUST BE AT THE END OF THE FILE FOR SDKMAN TO WORK!!!
export SDKMAN_DIR="$HOME/.sdkman"
[[ -s "$HOME/.sdkman/bin/sdkman-init.sh" ]] && source "$HOME/.sdkman/bin/sdkman-init.sh"
