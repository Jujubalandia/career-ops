# Sourced by run-daily-scan.sh and run-manual-scan.sh (no shebang, not executable).
# One place for the environment cron does not give us and for the search profile.

# cron starts with a bare PATH: node lives under nvm, bun under ~/.bun. nvm.sh is not
# `set -u` safe, so relax it around the source.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  set +u; . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; set -u
fi
command -v node >/dev/null 2>&1 \
  || export PATH="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1):$PATH"
export PATH="$HOME/.bun/bin:$PATH"

# Freshness window, in calendar days: anything posted longer ago is discarded before it
# reaches data/pipeline.md (import: --jobage; scan.mjs: --since). Undated postings are kept
# and counted. Override for one run:  JOBAGE=7 scripts/run-manual-scan.sh
JOBAGE="${JOBAGE:-3}"

# Search profile (São Paulo hybrid/on-site, remote anywhere in Brazil, AI governance anywhere).
CITY='São Paulo'
KEEP_ANYWHERE='governan|governance'
# Titles must mention AI/data/governance/agents (used for the noisy fuzzy sources).
INCLUDE='\b(IA|AI|GenAI|LLM)\b|Intelig[eê]ncia Artificial|\bdados\b|\bdata\b|governan|agent'
EXCLUDE='Analista(?!.*Governan)|\bQA\b|Product Manager|Gerente de Produto|\bSAP\b|\bJR\b|J[uú]nior|Junior|Pleno|\bPL\b|Est[aá]gi|Intern|Instrutor|Diretor\(a\) de Arte|Executivo|Hunter|Engenheir[oa] de Dados|Data Engineer|Cientista|Scientist|Sales|Account|Marketing|Clinical|Designer|Dados Mestres|Master Data'

QUERIES=(
  "AI Engineer" "Agentic AI" "Engenheiro de IA" "Agente de IA" "GenAI" "LLM Engineer"
  "AI Governance" "Governança de IA" "Gestão de Dados" "Data Manager" "AI Manager"
  "Gestão IA" "Gestor Dados" "Gestor IA"
)
