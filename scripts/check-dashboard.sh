#!/bin/bash
# Validate the dashboard's inline client JS (tsc/tests can't — it's a string).
# Run after ANY dashboard.ts edit. Avoid regex literals in the template literal;
# backslashes collapse (e.g. /\/pull\// -> //pull/ which comments the line).
set -e
curl -s http://localhost:4317/ | sed -n '/<script>/,/<\/script>/p' | sed '1d;$d' > /tmp/loom-inline-check.js
if node --check /tmp/loom-inline-check.js 2>/tmp/loom-inline-err; then
  echo "✓ dashboard inline JS valid"
else
  echo "✗ dashboard inline JS BROKEN:"; cat /tmp/loom-inline-err; exit 1
fi
