# Changelog

## 1.3.2

- OpenCode Go subscribers now get `opencode/jev-1.13-free` classification out of the box without configuring the `opencode` Zen provider globally (which would otherwise expose pay-as-you-go chat models that fail with HTTP 402).

## 1.3.1

- npm version badge and package link in the README.
- Releases now publish to npm through trusted publishing (GitHub Actions OIDC): pushing a `v*` tag publishes the matching package.json version, no npm token on disk.

## 1.3.0

- Bilingual heuristic: every signal regex gained English alternations; the French patterns stay. Paths, code blocks, message length and the terminal-paste penalty were already language-neutral.
- Hybrid classifier mode: when a classifier model is available — auto-detected across all providers (TypeSafe Jev, OpenRouter decision models, Cloudflare Clef, GitHub Copilot decision models, OpenCode `jev-1.13-free`) — the router asks it one multiple-choice question (light / standard / complex / heavy) and maps the answer straight to the four tiers with their thinking levels. Only the user message is sent, truncated to 16k chars; never the system prompt, history or tool results. Free classifiers are preferred, then the cheaper ones; one classification per new turn, never on retries or continuations. The status line now shows the source: `local` or the classifier id (e.g. `jev-1.13-free`).
- The zero-requirements install keeps working: confidence below 0.50, a 4-second timeout, any classifier error, or no classifier at all silently falls back to the local bilingual heuristic — no key, no config, no network.

## 1.2.0

- Economy and quality fixed together, measured on 926 real turns:
  - turns routed to an expensive tier: 104 → 85;
  - heaviest-quartile turns sent to the cheapest tier: 82/232 → 53/232;
  - Spearman correlation with real difficulty: +0.288 → +0.339.
- The `ACTION` verb list now recognises the spoken French imperatives (`fais`, `faire`, `regarde`, `prend`, `donne`, `met`, `lance`, `écris`, `essaie`, `montre`). They were as frequent as the formal verbs in real prompts but matched nothing, so "fais le portage français" — 49 tool calls, 82k output tokens — scored 0.10 and landed in `eco`.
- Upper thresholds raised from 0.50/0.70 to 0.60/0.75: a path plus one verb is a routine request and no longer reaches `strong` ("corrige le bug dans src/foo.ts" used to).
- Tests: 20 cases (the threshold table, the spoken imperatives, and a regression guard on the path-plus-verb over-provisioning).

## 1.1.0

- Provider-agnostic: the failover now recognizes provider-wide limits from any provider (Anthropic rate limits, Google `RESOURCE_EXHAUSTED`, OpenAI `insufficient_quota`, OpenCode usage limits), not only OpenCode-specific errors.
- Transient rate limits keep their original message text; only errors pi refuses to retry are rewritten into a retryable 429.
- Models without pricing data are no longer dropped from the catalog; they rank at a mid cost.
- The denylist path honors `PI_CODING_AGENT_DIR` instead of a hardcoded home directory.
- Packaged as a pi package: install with `pi install npm:pi-auto-route`.
- Tests: 18 cases covering the heuristic calibration and the failover lifecycle.

## 1.0.0

- Initial release.
- `auto` virtual model routing every turn by a locally calibrated difficulty heuristic (0.30 / 0.50 / 0.70 thresholds, 880 real turns).
- Four tiers (eco, standard, strong, frontier) with a thinking-level cap per tier.
- One model switch per turn: the starting model plans and makes the first `edit`/`write`.
- Automatic failover on timeouts and overloads, provider-wide avoidance on quota 429s, persistent denylist for permanent errors (400/404/410).
