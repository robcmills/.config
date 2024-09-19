cyan="${esc}[36m"
esc=$(printf '\033')
green="${esc}[32m"
nc="${esc}[0m"
red="${esc}[31m"
yellow="${esc}[33m"

# ANSI color codes
ESC=$(printf '\033')
BLUE="${ESC}[34m"
CYAN="${ESC}[36m"
GREEN="${ESC}[32m"
NC="${ESC}[0m"
PURPLE="${ESC}[35m"
RED="${ESC}[31m"
YELLOW="${ESC}[33m"

# echo "test" | sed "s/.*/${red}&${nc}/"

# ([a-f0-9]+)\ -\ (.+)\ -\ ([0-9-]+)$
# echo "797cc14263 - Dave Martinez - 2024-09-09" \
cat git-log-output.txt \
  | sed -E "s/^([a-f0-9]+) - (.+) - ([0-9-]+)/${PURPLE}\1${NC} - ${CYAN}\2${NC} - ${GREEN}\3${NC}/g" \
  | sed -E "s/^diff --git a\/(.*) b\/.*/${YELLOW}\1${NC}/" \
  | sed -E "s/(mutate)/${BLUE}\1${NC}/g"


  # | sed -E "s/^([a-f0-9]+)\ -\ (.+)\ -\ ([0-9-]+)$/${YELLOW}\1${NC} - ${CYAN}\2${NC} - ${GREEN}\3${NC}/g"
