#!/usr/bin/env bash
# Stop the Inkling llama-server started by start-inkling-server.sh.
set -uo pipefail

PORT=${INKLING_PORT:-8080}
MODEL=${INKLING_MODEL:-/data/llm/inkling/Inkling-2-Mini-AD-IQ1_M.gguf}
LOG=${INKLING_LOG:-${MODEL%/*}/server.log}
PIDFILE=${LOG%.*}.pid

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
	kill "$(cat "$PIDFILE")" 2>/dev/null
	rm -f "$PIDFILE"
	echo "stopped"
	exit 0
fi

# No pidfile (started by hand): match the binary + model instead.
if pkill -f "llama-server.*$(basename "$MODEL")"; then
	echo "stopped"
else
	echo "not-running"
fi
