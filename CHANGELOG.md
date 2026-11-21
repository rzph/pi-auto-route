# Changelog

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
