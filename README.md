# auto-route

A virtual model for [pi](https://github.com/earendil-works/pi-coding-agent) that routes every turn to the right physical model by task difficulty and adjusts the thinking level, to cut token spend without losing quality.

![harness](https://img.shields.io/badge/harness-pi--coding--agent-blue)

**pi-specific.** This extension uses pi's extension API (`pi.registerVirtualModel`, `ModelRegistry`). It does not port as-is to Claude Code, Codex or other harnesses; see [Portability](#portability) for close equivalents.

## How it works

Pick **auto → auto** in the model selector (`/model`). Then, on every turn:

1. **Difficulty estimate** (local heuristic, no external API): a cited path or repo, action verbs ("resume", "modify", "find"…), explicit intent ("I want"), a conceptual question, keyword matches (debugging, architecture…), length, code, a terminal-paste penalty → a continuous score from 0 to 1. Calibrated on 880 real turns (see `heuristics.test.ts`); read the numbers honestly:
   - heaviest-quartile messages sent to `eco`: **195/220 → 72/220** (the real win: less under-routing);
   - Spearman score vs. tool calls: +0.16 → **+0.28**;
   - overall quartile agreement: **30 % against 25 % for chance** — the score is an *asymmetric umbrella* (it shields heavy messages from the `eco` tier and at worst bumps simple ones one step), not a precise classifier. Do not overestimate fine-grained prediction.
2. **Tier choice** inside YOUR real catalog (discovered at runtime via `getAvailable()`, nothing hardcoded):
   - score ≥ 0.7 — heavy work, several signals → most capable tier, thinking `xhigh`
   - score ≥ 0.5 → strong tier, thinking `high`
   - score ≥ 0.3 → standard tier, thinking `medium`
   - score < 0.3 — short follow-ups, quick questions → lightest tier, thinking `low`
3. **One switch per turn**: the starting model plans and makes the first `edit`/`write`; the rest of the turn continues on the lightest model. The prompt cache breaks only once per turn.
4. **Compaction and invisible summaries** always go to the lightest model — the token leak nobody sees.
5. **Automatic failover instead of a crash**: a timeout or overload (429/5xx) moves to the next model of the ladder; a **429 "provider quota"** error (which pi treats as non-retryable) is rewritten into a retryable one, and the router then avoids the **whole provider** — the turn continues instead of dying. Permanent errors (400/404/410) ban the model through the denylist. See `failover.test.ts`.

### Excluded from the candidates

- **free** models (tight quotas, constant timeouts);
- **non-reasoning** models;
- any model whose provider has no valid credentials;
- **`contributor`** models (OpenCode endpoints that train on your requests);
- retired or deprecated generations: `gemini-2.5-*` (Google 404), `mimo-v2.5` (OpenCode 410);
- specialized non-code models (`computer-use`, `robotics`, `deep-research`);
- anything listed in pi's agent dir as `auto-route-denylist.json` (`$PI_CODING_AGENT_DIR` if set, else `~/.pi/agent/`) — banned automatically and **persistently** as soon as it returns a permanent error (400/404/410, "trains on request data", unsupported region…). Delete an entry from the file to restore a model.

Capacity ranking uses **output cost** as a proxy (ties broken by the largest contextWindow). A model is excluded as free only when its pricing says 0; missing pricing means unknown and stays a candidate, ranked at a mid cost. An empty tier falls back to the next one; if everything fails, you get an explicit error.

## Requirements

- pi with at least one provider that has valid credentials. Nothing is hardcoded to a specific provider: the candidate catalog, the tiers and the failover are all built from your own model registry at runtime.
- No API key of its own and no network calls: the difficulty heuristic runs entirely locally.
- Only to run the test suite: Node.js 22.6 or newer (`node --test *.test.ts`).

## Install

```bash
# for the session:
pi -e /path/to/auto-route.ts

# or permanent (loaded at every pi start):
cp /path/to/auto-route.ts ~/.pi/agent/extensions/auto-route.ts
```

Then `/model` → **auto → auto** (shown as "Auto (routing + thinking + failover)"). Selecting it starts at thinking **`low`** — that level is a ceiling: raise it with `shift+tab` when you want the router to think harder.

## Customize

Everything is set at the top of the file:

- `difficultyScore()`: the heuristic (signals plus length thresholds) — each signal is one commented regex; recalibrate and run `node --test *.test.ts` after any change (`heuristics.test.ts` for the score, `failover.test.ts` for the 429 handling and the default thinking);
- `tierAndThinking()`: the score → tier + thinking mapping;
- the filter in `candidateModels()` if you want free or non-reasoning models back.

To force one specific model for a single turn: switch to a real model with `/model`, then back to `auto` on the next turn.

## Portability

- **pi**: supported (this extension).
- **Claude Code**: not portable; close ideas: `jev-router` (gargpratyush), "model-router" skills (Claude Code internals).
- **Codex**: not portable; `jev-codex-router` (0xNatoshi): model + thinking per turn.
- **Hermes**: not portable; `hermes-jev-skills` (kerpopule).

The idea (plan strong, execute cheap, one switch per turn, degenerate compaction on a light model) ports everywhere; this implementation is tied to pi. Want a port for another harness? Open an issue.

## Key concepts

- **Prompt cache**: the router switches *once* per turn, after planning — every cross-provider switch invalidates the cache, so the trade-off favors turns with several tool calls.
- **Route state**: stored on the session branch by pi; it follows the session tree and survives compaction.
- **Capacity proxy**: output cost ranks models in the absence of per-task benchmarks. Home-grown benchmark data (reviewer catch rate, say) is a natural extension.

## License

MIT — see [LICENSE](LICENSE).
