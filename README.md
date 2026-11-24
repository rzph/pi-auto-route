# auto-route

A virtual model for [pi](https://github.com/earendil-works/pi-coding-agent) that sends every request to the right physical model based on how hard the task looks, to cut token spend without losing quality.

[![npm](https://img.shields.io/npm/v/pi-auto-route)](https://www.npmjs.com/package/pi-auto-route) ![harness](https://img.shields.io/badge/harness-pi--coding--agent-blue)

**pi-specific.** This extension uses pi's extension API (`pi.registerVirtualModel`, `ModelRegistry`); it does not port as-is to Claude Code, Codex or other harnesses. See [Portability](#portability).

## Install

```bash
pi install npm:pi-auto-route
```

Then in pi: `/reload`, and pick **auto → auto** in the model selector (`/model`). It shows up as "Auto (routing + thinking + failover)".

- update: `pi update --extensions`
- remove: `pi remove npm:pi-auto-route`
- without npm: `pi install git:github.com/rzph/pi-auto-route`, or copy `auto-route.ts` into `~/.pi/agent/extensions/` by hand

Optional add-on, not installed by `pi install`: [inkling/](inkling/README.md) routes short tool-free prompts to a local llama.cpp model (zero cost, offline). Copy `inkling/inkling-auto-router.ts` into `~/.pi/agent/extensions/` to enable it.

Selecting `auto` starts at thinking `low`. That level is a **ceiling**, not a target: raise it with `shift+tab` when you want the router to think harder.

## Usage

Once selected, you do nothing else. On every turn the router picks a model on its own and shows one discreet status line: `⚡ provider/model · thinking · local` — the last tag is the source of the difficulty call, `local` or the classifier id (e.g. `jev-1.13-free`).

Three things worth knowing up front:

- **Language.** The local heuristic reads both French and English: every signal regex carries French and English alternations. When a classifier model is available on any of your providers, routing uses it instead — classifiers are language-agnostic. The regex path stays as the zero-dependency fallback.
- **One switch per turn.** The first model plans and makes the first `edit`/`write`; the rest of the turn runs on the cheapest tier. The prompt cache therefore breaks only once per turn, which is why the trade-off favours turns with several tool calls.
- **You stay in control.** `/model` to any real model takes over immediately; switch back to `auto` on the next turn to resume routing. To force one model for a single turn, switch away and back.

## Requirements

- pi with at least one provider that has valid credentials. Nothing is hardcoded to a specific provider: the candidate catalog, the tiers and the failover are all built from your own model registry at runtime.
- No API key of its own: without a classifier, the difficulty heuristic runs entirely locally, with no network calls.
- A classifier model from any provider is optional and auto-detected; without one the local heuristic is used, so no extra credential is ever required.
- Only to run the test suite: Node.js 22.6 or newer (`npm test`), and `npm run typecheck` for the API-type check (`npm install` first).

## How it works

On each turn, in order:

1. **Score the message.** The router tries a classifier first. Any classifier model in your registry is auto-detected across all providers (TypeSafe Jev, OpenRouter decision models, Cloudflare Clef, GitHub Copilot decision models, OpenCode `jev-1.13-free`…); free ones are preferred, then the cheaper ones. The router asks it one multiple-choice question on your last message — light, standard, complex or heavy — sending only that message, truncated to 16k characters: never the system prompt, the history or tool results. One classification runs per new turn, never on retries or ordinary continuations (except as a safety fallback if the active model becomes unavailable mid-turn). Confidence below 0.50, a 4-second timeout, any classifier error, or no classifier at all falls back silently to the local heuristic. That heuristic is now bilingual: regex patterns read your last message in French and English and produce a score from 0 to 1. Signals of real work: a path or repo, action verbs, explicit intent, a conceptual question, code blocks, length. A terminal paste (three or more `$`/`sudo` lines) is penalised — a wall of shell output is not a hard task.
2. **Pick a tier.** Your model catalog is sorted by output cost, used as a proxy for capacity (ties broken by the larger context window), and split into four tiers:
   - score ≥ 0.75 — heavy work, several independent signals → most capable tier, thinking `xhigh`
   - score ≥ 0.6 → strong tier, thinking `high`
   - score ≥ 0.3 → standard tier, thinking `medium`
   - score < 0.3 — short follow-ups, quick questions → lightest tier, thinking `low`

   The two upper thresholds are deliberately high: a path plus one verb is a routine request, not a hard one, and should not buy an expensive model. The thresholds apply to the local score only; a classifier answer (light / standard / complex / heavy) maps straight onto the same four tiers with their thinking levels.
3. **Hand off after the first edit.** The chosen model plans and makes the first `edit`/`write`; the turn continues on the lightest tier (see Usage).
4. **Compaction and invisible summaries** always go to the lightest model — the token leak nobody sees.
5. **Failover instead of a crash.** A timeout or overload (429/5xx) moves to the next model of the ladder. A **429 provider-quota** error — which pi treats as non-retryable, so the turn would die — is rewritten into a retryable one, and the router then avoids the **whole provider**: the turn continues on another provider instead. Permanent errors (400/404/410, and messages like "trains on request data" or "unsupported region") ban the model persistently. See `failover.test.ts`.

### Free classifiers and borrowed keys

A classifier can be free (cost 0) while living under a provider you never configured. OpenCode's `jev-1.13-free` sits under `opencode`, which most users only meet as the pay-as-you-go Zen endpoint; enabling that provider just to reach the classifier would flood `/model` with chat models that fail with HTTP 402.

So when no classifier of that provider is available, the router borrows a key. It scans every provider in your registry that holds one (`getAll` + `getApiKeyForProvider`), prefers an OpenCode key when there is one, and passes it per request — only for the classification call, only to the free classifier. The classifier costs nothing, so no quota is consumed and nothing is enabled globally.

Keys are tried in order, and a key the classifier rejects moves on to the next candidate instead of ending the turn. There is one limit: OpenCode validates the credential itself, so a Google key is answered with 401 and never unlocks Jev. With no usable key left, the turn falls back to the local heuristic.

### Excluded from the candidates

- **free** models (tight quotas, constant timeouts);
- **non-reasoning** models;
- any model whose provider has no valid credentials;
- **`contributor`** models (OpenCode endpoints that train on your requests);
- retired or deprecated generations: `gemini-2.5-*` (Google 404), `mimo-v2.5` (OpenCode 410);
- specialized non-code models (`computer-use`, `robotics`, `deep-research`);
- anything in pi's agent dir as `auto-route-denylist.json` (`$PI_CODING_AGENT_DIR` if set, else `~/.pi/agent/`) — models banned automatically and **persistently** as soon as they return a permanent error. Delete an entry from the file to restore a model.

A model is excluded as free only when its pricing says 0; missing pricing means unknown and stays a candidate, ranked at a mid cost. An empty tier falls back to the next one; if everything fails, you get an explicit error.

## Customize

Two files matter:

- `auto-route.ts`: the tier router;
- `inkling/inkling-auto-router.ts`: the optional local-model router (see [inkling/README.md](inkling/README.md)).

Everything is set at the top of `auto-route.ts`:

- `difficultyScore()`: the heuristic (signals plus length thresholds) — each signal is one commented regex; recalibrate and run `node --test *.test.ts` after any change (`heuristics.test.ts` for the score, `failover.test.ts` for the 429 handling and the default thinking);
- `tierAndThinking()`: the score → tier + thinking mapping;
- the filter in `candidateModels()` if you want free or non-reasoning models back.

## Calibration details

The heuristic is a hand-written rule, not a trained model; the numbers below only measure it, and they measure the local fallback path. They come from 926 real turns taken from local session logs (see `heuristics.test.ts`), scored against a real-difficulty proxy (the combined rank of a turn's tool calls and output tokens).

Current rule against the previous one:

- heaviest-quartile turns sent to the `eco` tier: **82/232 → 53/232** — fewer heavy turns left on the cheapest model;
- turns routed to an expensive tier: **104 → 85**;
- light turns that still reached an expensive tier: **52 → 44**;
- Spearman correlation between score and real difficulty: **+0.288 → +0.339**.

Both directions improved at once because two separate faults were fixed together: the verb list had missed the spoken imperatives (`fais`, `regarde`, `prend`, `donne`, `met`, `lance`), which sent turns like "fais le portage français" — 49 tool calls, 82k output tokens — to `eco`; and the upper thresholds let a path plus one verb reach `strong`. The first version of the rule scored +0.16 with 195/220 of the heaviest turns in `eco`.

Read the correlation honestly: the score is an **asymmetric umbrella** — it shields heavy messages from the `eco` tier and at worst bumps a simple one step up. It is not a precise classifier of difficulty, and fine-grained prediction should not be expected from it. Some heavy turns open with a single word ("tous") that no text heuristic can recognise from the message alone; those stay in `eco`. When a classifier model is available, the classifier path is the more precise one and needs no calibration.

## Portability

- **pi**: supported (this extension).
- **Claude Code**: not portable; close ideas: `jev-router` (gargpratyush), "model-router" skills.
- **Codex**: not portable; `jev-codex-router` (0xNatoshi): model + thinking per turn.
- **Hermes**: not portable; `hermes-jev-skills` (kerpopule).

The idea (plan strong, execute cheap, one switch per turn, compaction on a light model) ports everywhere; this implementation is tied to pi. Want a port for another harness? Open an issue.

## Key concepts

- **Prompt cache**: the router switches *once* per turn, after planning — every cross-provider switch invalidates the cache, so the trade-off favors turns with several tool calls.
- **Route state**: stored on the session branch by pi; it follows the session tree and survives compaction.
- **Capacity proxy**: output cost ranks models in the absence of per-task benchmarks. Home-grown benchmark data (reviewer catch rate, say) is a natural extension.

## License

MIT — see [LICENSE](LICENSE).
