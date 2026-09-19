#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_VERSION:?RELEASE_VERSION is required}"

# A merge can advance main after checkout. Never publish until the version
# commit is on main; rebase and recheck the package if the push loses that race.
for attempt in 1 2 3; do
  if git push origin HEAD:main; then
    exit 0
  fi

  if [ "$attempt" -eq 3 ]; then
    echo "::error::Could not claim main for release after three attempts"
    exit 1
  fi

  git fetch origin main
  git rebase origin/main

  actual_version="$(node -p "require('./package.json').version")"
  if [ "$actual_version" != "$RELEASE_VERSION" ]; then
    echo "::error::Release version changed while rebasing main"
    exit 1
  fi

  npm ci
  npm run check
  npm run package:smoke
done
