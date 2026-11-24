#!/usr/bin/env bash
# Start the Inkling 2 Mini llama-server (Vulkan) in the background and return.
#
# Prints one status line the pi extension parses:
#   already-running | starting pid=N | launched pid=N | failed ...
#
# Every path is overridable so the script is not tied to one machine:
#   INKLING_LLAMA_DIR  llama.cpp build directory (contains llama-server)
#   INKLING_MODEL      path to the .gguf file
#   INKLING_PORT       port to listen on (default 8080)
#   INKLING_CTX        context tokens (default 4096, see README: more OOMs here)
#   INKLING_VK_DEVICE  Vulkan device index (default 1 = the NVIDIA GPU)
set -uo pipefail

LLAMA_DIR=${INKLING_LLAMA_DIR:-/data/llm/llama.cpp/llama-b12674}
MODEL=${INKLING_MODEL:-/data/llm/inkling/Inkling-2-Mini-AD-IQ1_M.gguf}
PORT=${INKLING_PORT:-8080}
CTX=${INKLING_CTX:-6144}
VK_DEVICE=${INKLING_VK_DEVICE:-1}
LOG=${INKLING_LOG:-${MODEL%/*}/server.log}
PIDFILE=${LOG%.*}.pid
BASE_URL="http://127.0.0.1:$PORT"

if curl -fsS --max-time 2 "$BASE_URL/health" >/dev/null 2>&1; then
	echo "already-running"
	exit 0
fi

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
	echo "starting pid=$(cat "$PIDFILE")"
	exit 0
fi

if [ ! -x "$LLAMA_DIR/llama-server" ] || [ ! -f "$MODEL" ]; then
	echo "failed missing $LLAMA_DIR/llama-server or $MODEL"
	exit 1
fi

export LD_LIBRARY_PATH="$LLAMA_DIR"
export GGML_VK_VISIBLE_DEVICES="$VK_DEVICE"
cd "$LLAMA_DIR" || { echo "failed cannot enter $LLAMA_DIR"; exit 1; }

# setsid + nohup: the server must outlive the pi process that started it.
setsid nohup ./llama-server \
	-m "$MODEL" \
	--jinja \
	--temp 1.0 --top-p 1.0 --top-k 0 --min-p 0 \
	--reasoning-effort low \
	-c "$CTX" --fit on --fit-target 512 -np 1 \
	--host 127.0.0.1 --port "$PORT" \
	>"$LOG" 2>&1 </dev/null &

echo $! >"$PIDFILE"
echo "launched pid=$(cat "$PIDFILE")"
