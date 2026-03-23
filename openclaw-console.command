#!/bin/bash
cd "$(dirname "$0")"
lsof -ti :9831 | xargs kill -9 2>/dev/null
sleep 0.3
node openclaw-console.mjs
