#!/usr/bin/env bash
# Install git pre-commit hook that runs gitleaks before every commit.
# Run once after cloning: bash scripts/install-hooks.sh

set -euo pipefail

HOOK=".git/hooks/pre-commit"

cat > "$HOOK" <<'EOF'
#!/usr/bin/env bash
# Run gitleaks secret scan before commit.
# Requires gitleaks to be installed: https://github.com/gitleaks/gitleaks#installing

if ! command -v gitleaks &>/dev/null; then
  echo "[pre-commit] gitleaks not found — skipping secret scan."
  echo "             Install it: https://github.com/gitleaks/gitleaks#installing"
  exit 0
fi

gitleaks protect --staged --config .gitleaks.toml --verbose
EOF

chmod +x "$HOOK"
echo "[install-hooks] Pre-commit hook installed at $HOOK"
