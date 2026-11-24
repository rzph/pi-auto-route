# Inkling local router (optional add-on)

Routes short, tool-free prompts to a [llama.cpp](https://github.com/ggml-org/llama.cpp)
server running on your own machine, so the trivial turns cost nothing and never
leave the computer. It is the cheap floor under `auto`: a 26B model that answers
"bonjour" or "c'est quoi un mutex" locally, at zero token cost.

This is **opt-in and not part of `pi.extensions`**. Without a local server there
is nothing to route to, so shipping it enabled would only produce warnings. Copy
the files if you have the hardware.

## Two hard constraints, measured on a GTX 1050 Ti / 15 GB

They explain every number in the setup, so read them before tuning anything.

1. **A request bigger than the server's `-c` is refused before the model sees it**
   (`request (8584 tokens) exceeds the available context size (4096 tokens)`).
   Pi's system prompt *with tool declarations* is ~8.5k tokens; without tools it
   is ~730. So the tools must be off, and this extension turns them off for the
   whole time Inkling is selected — it is a chat model here, not an agent.
2. **Pi reserves `max(4096, 15 % of the input)` tokens of output headroom**
   (`CONTEXT_SAFETY_TOKENS` in `clampMaxTokensToContext`). A model declared with
   `contextWindow: 4096` therefore gets `max_completion_tokens: 1`: the answer
   comes back **silently empty**. The window must be at least
   `prompt + 4096 + desired output`.

With `-c 4096` the model loads but cannot answer. `-c 8192` needs a 4.5 GB Vulkan
compute buffer and dies with `ErrorOutOfDeviceMemory` on 4 GB. **`-c 6144` fits**
(3992 MiB used), which leaves a real answer budget of ~1300 tokens.

## Requirements

- ~7 GB free RAM/swap for the smallest usable quant, plus a Vulkan GPU.
- llama.cpp built with `inkling2_loop` support (b12674 or newer), Vulkan backend.
- Realistic expectation: **4–5 tokens/s generation, ~13 tokens/s prompt**, so a
  80-token answer costs ~20 s. This is a chat pet, not a coding agent.

## Setup

1. Binary and model (any paths, exported below or edited into the scripts):

   ```bash
   export INKLING_LLAMA_DIR=/data/llm/llama.cpp/llama-b12674
   export INKLING_MODEL=/data/llm/inkling/Inkling-2-Mini-AD-IQ1_M.gguf   # AD-IQ1_M, ~6.8 GiB
   ```

2. Copy `inkling/scripts/*.sh` somewhere and adjust the defaults at the top (or
   export the variables). `start-inkling-server.sh` launches llama-server
   detached and prints one status line (`launched pid=N` / `already-running` /
   `starting pid=N`); a server it did not start is never killed.

3. Declare the endpoint: merge `models.json.example` into `~/.pi/agent/models.json`
   (`contextWindow: 6144`, `maxTokens: 1300` — see constraint 2 above). `cost: 0`
   keeps it out of `auto`'s candidate pool: this router owns the model, not the
   tier logic.

4. Cap the compaction settings for this model, in `~/.pi/agent/settings.json`
   (the defaults, `reserveTokens: 16384` / `keepRecentTokens: 20000`, are larger
   than the whole window):

   ```json
   {
     "compaction": {
       "modelOverrides": {
         "inkling-local/inkling-2-mini-iq1m": { "reserveTokens": 1600, "keepRecentTokens": 1500 }
       }
     }
   }
   ```

5. Install the extension and reload pi:

   ```bash
   cp inkling/inkling-auto-router.ts ~/.pi/agent/extensions/
   ```

   Configure paths with `INKLING_START_SCRIPT`, `INKLING_STOP_SCRIPT`,
   `INKLING_PORT`, `INKLING_PROVIDER`, `INKLING_MODEL_ID` (defaults at the top of
   the file).

## What it does

`before_agent_start` classifies the prompt, and a turn goes local only when it is
short, free of code, free of paths, and free of tooling verbs — the gate is "does
this fit without tools", not "is this task easy" (that is `auto`'s question).
Then:

- the tools are stripped for the local answer and restored right after it, in
  `agent_settled`, together with the model you were on (recorded at entry, with
  `defaultModel` from the settings as fallback);
- a **manual** selection of Inkling is respected: the router starts the server and
  strips the tools, but never routes away from your choice;
- a cold server is **not** waited on: the current turn goes to your normal model
  while llama.cpp loads in the background, and the next simple prompt is local;
- `/inkling stop` shuts the server down, `/inkling status` reports
  `prêt | chargement en cours | arrêté`, `/inkling` starts and waits. On `/quit`
  the server is stopped only if this extension started it.

## Tuning the gate

`isSimplePrompt()` is the whole policy: a 300-character cap plus four regexes,
covered by `inkling.test.ts`. Widening it is easy and deliberately blunt — a
false positive costs answer quality (a 1.75 bpw model answers you), a false
negative costs nothing.
