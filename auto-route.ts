/**
 * auto-route — virtual model `auto/auto`: full automatic routing.
 *
 * /model → "auto":
 * - candidates = paid reasoning chat models with valid credentials, excluding
 *   free models, training models (`contributor`) and retired generations
 *   (`gemini-2.5-*`);
 * - capacity tiers built at runtime (output cost as a proxy);
 * - locally estimated difficulty → tier + thinking;
 * - the thinking level chosen in pi (`shift+tab`) acts as a CEILING;
 * - failover on retry (429/5xx) plus a `message_end` listener that bans
 *   PERMANENTLY models returning 400/404 (pi does not retry non-429 4xx);
 *   429 "provider quota" errors, which pi treats as non-retryable, are
 *   rewritten into retryable 429s so the same failover (cross-provider)
 *   runs instead of letting the turn die;
 * - selecting `auto` starts at thinking `low` by default (ceiling, raise it
 *   later with shift+tab);
 * - ONE discreet status line (`⚡ model · thinking`);
 * - one model switch per turn (prompt cache preserved);
 * - compaction/summaries → the lightest model.
 *
 * Usage: pi -e ~/.pi/agent/extensions/auto-route.ts then /model → auto
 */

import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRoute,
	ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const EDIT_TOOLS = new Set(["edit", "write"]);

/**
 * ID/name patterns excluded up front:
 * - `free`: tight quotas / constant timeouts;
 * - `contributor`: OpenCode endpoints that train on your requests;
 * - `gemini-2.5-`: retired by Google for new accounts (404);
 * - `mimo-v2.5`: deprecated on OpenCode Go (410 ModelDeprecated);
 * - `computer-use` / `robotics` / `deep-research`: specialized non-code models.
 */
const EXCLUDED_MODEL_RE =
	/free|contributor|gemini-2\.5-|mimo-v2\.5\b|computer-use|robotics|deep-research/i;

/** File of permanently banned models (400/404/410 discovered on the fly). */
const DENYLIST_FILE = `${process.env.HOME ?? ""}/.pi/agent/auto-route-denylist.json`;

type Thinking = "off" | "low" | "medium" | "high" | "xhigh";
type TierName = "frontier" | "strong" | "standard" | "eco";
const THINKING_ORDER: Thinking[] = ["off", "low", "medium", "high", "xhigh"];

interface RouteState {
	modelId: string;
	providerId: string;
	thinking: Thinking;
	/** provider/id entries avoided for THIS turn (transient failures). */
	avoid: string[];
}

function modelKey(m: { provider: string; id: string }): string {
	return `${m.provider}/${m.id}`;
}

function sameState(a: RouteState | undefined, b: RouteState): boolean {
	if (!a) return false;
	return (
		a.modelId === b.modelId &&
		a.providerId === b.providerId &&
		a.thinking === b.thinking &&
		a.avoid.length === b.avoid.length &&
		a.avoid.every((v, i) => v === b.avoid[i])
	);
}

// Persistent denylist

function loadDenylist(): Set<string> {
	try {
		const raw = JSON.parse(readFileSync(DENYLIST_FILE, "utf8")) as string[];
		return new Set(Array.isArray(raw) ? raw : []);
	} catch {
		return new Set();
	}
}

function saveDenylist(set: Set<string>): void {
	try {
		mkdirSync(dirname(DENYLIST_FILE), { recursive: true });
		writeFileSync(DENYLIST_FILE, JSON.stringify([...set], null, 1));
	} catch {
		// best effort
	}
}

const permanentDenylist = loadDenylist();

function banPermanently(provider: string, modelId: string): void {
	const k = modelKey({ provider, id: modelId });
	if (!permanentDenylist.has(k)) {
		permanentDenylist.add(k);
		saveDenylist(permanentDenylist);
	}
}

/** Permanent failure (model retired, 404/410, refuses training, unsupported region…). */
function isPermanentFailure(message: string): boolean {
	return /no longer available|not found|\b404\b|\b410\b|ModelDeprecated|deprecated|discontinued|trains on request data|hosted outside Europe|requires Global regions|does not exist|no API implementation|unsupported/i.test(
		message,
	);
}

/**
 * 429 "provider quota limit" (subscription/quota exhausted). Original patterns
 * (the class pi marks NON-retryable: retrying the same provider is pointless
 * for it) plus the marker rewritten by `toFailoverRetryMessage` — single source
 * of truth for the check, both in `message_end` and in `route(reason: "retry")`.
 */
const PROVIDER_LIMIT_RE =
	/gousagelimiterror|freeusagelimiterror|monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing|subscription_sharing|resource_exhausted|exceeded your current quota|429 provider quota/i;

/**
 * Turns a provider-quota error into a "429" pi is willing to retry. Pi drops
 * these errors (retrying the same provider is pointless); under auto-route the
 * failover changes provider, so a retry becomes useful: pi then calls
 * `route(reason: "retry")` and the router switches. The rewritten text carries
 * pi's retryable "429" pattern and avoids its non-retryable ones (billing,
 * quota exceeded…); it also reads as a clear marker in the transcript.
 * Returns undefined when there is nothing to rewrite.
 */
export function toFailoverRetryMessage(msg: AssistantMessage): AssistantMessage | undefined {
	if (
		msg.stopReason !== "error" ||
		!msg.errorMessage ||
		!msg.provider ||
		!msg.model ||
		!PROVIDER_LIMIT_RE.test(msg.errorMessage)
	) {
		return undefined;
	}
	return {
		...msg,
		errorMessage: `auto-route: 429 provider quota — ${msg.provider}/${msg.model} at limit; retrying on another model`,
	};
}

// Dynamic catalog

function candidateModels(ctx: ExtensionContext): Model<never>[] {
	return (ctx.modelRegistry.getAvailable() as Model<never>[]).filter((m) => {
		if (permanentDenylist.has(modelKey(m))) return false;
		if (EXCLUDED_MODEL_RE.test(m.id) || EXCLUDED_MODEL_RE.test(m.name)) return false;
		const zeroCost = !m.cost || (m.cost.input === 0 && m.cost.output === 0);
		return m.reasoning !== false && !zeroCost;
	});
}

function buildTiers(ctx: ExtensionContext, avoid: string[] = []) {
	const allCandidates = candidateModels(ctx);
	if (allCandidates.length === 0) {
		throw new Error("auto-route: no candidate model available (check your API keys)");
	}
	const avoidSet = new Set(avoid);
	// `avoid` holds either `provider/id` keys (one model) or a bare `provider`
	// (whole provider, quota exhausted: all of its models would fail alike).
	const filtered = allCandidates.filter(
		(m) => !avoidSet.has(modelKey(m)) && !avoidSet.has(m.provider),
	);
	const pool = filtered.length > 0 ? filtered : allCandidates;
	const sorted = [...pool].sort((a, b) => {
		const ca = a.cost?.output ?? 0;
		const cb = b.cost?.output ?? 0;
		if (Math.abs(ca - cb) < 0.01) return (b.contextWindow ?? 0) - (a.contextWindow ?? 0);
		return cb - ca;
	});
	const at = (frac: number): Model<never> =>
		sorted[Math.min(sorted.length - 1, Math.floor(frac * sorted.length))];
	return {
		frontier: at(0),
		strong: at(0.33),
		standard: at(0.66),
		eco: sorted[sorted.length - 1],
		background: sorted[sorted.length - 1],
	} as const;
}

// Status (one discreet line)

function setStatusLine(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	m: Model<never>,
	thinking: Thinking,
): void {
	try {
		const dim = ctx.ui.theme?.fg?.bind(ctx.ui.theme) ?? ((_: string, s: string) => s);
		ctx.ui.setStatus("auto", dim("dim", `⚡ ${modelKey(m)} · ${thinking}`));
	} catch {
		ctx.ui.setStatus("auto", `${modelKey(m)} · ${thinking}`);
	}
	pi.events.emit("auto-route:routed", {
		provider: m.provider,
		modelId: m.id,
		thinking,
	});
}

function toRoute(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	m: Model<never>,
	thinking: Thinking,
	prevState?: RouteState,
	nextState?: RouteState,
): ModelRoute<RouteState> {
	setStatusLine(pi, ctx, m, thinking);
	// Only return a new state object when it actually changed (avoids writing a
	// session-tree entry on every continuation request).
	const stateToStore =
		nextState && !sameState(prevState, nextState) ? nextState : undefined;
	return {
		model: m,
		thinkingLevel: thinking,
		state: stateToStore,
	};
}

// Difficulty heuristic
//
// Calibrated on 2026-11-21 over 880 real turns extracted from
// ~/.pi/agent/sessions/*.jsonl. Before/after measurements (analysis script,
// real-difficulty proxy = combined rank of the turn's tool calls and output
// tokens):
// - Spearman score vs. tool calls: v1 +0.16 → v2 +0.28;
// - heaviest-quartile messages sent to the eco tier: v1 195/220 → v2 72/220;
// - distribution: v1 = 92 % of messages in {0.10, 0.15} → v2 spread over 8+
//   values.
// Every signal is independent and interpretable; no training, no data leaves
// the machine: the rule stays hand-written, the numbers only verify it.

/** Reference to a path, file or repo → work on an existing codebase. */
const PATHY =
	/(?:\/(?:home|data|tmp|etc|usr|opt|var|srv)\/|~\/|\b[\w.+-]+\/[\w.-]+\.[A-Za-z0-9]{1,6}\b|\b[\w.+-]+\/[\w-]*-[\w-]+\b)/;
/** Construction / modification / analysis verbs → the agent is about to do work. */
const ACTION =
	/\b(reprend\w*|construi\w*|impl[ée]ment\w*|cré[ée]r?|cree\w*|g[ée]n[èe]r\w*|d[ée]velop\w*|migre\w*|refais|refaire|transforme\w*|modifi\w*|ajout\w*|supprim\w*|corrige\w*|corrig\w*|install\w*|configure\w*|[ée]crase\w*|r[ée]pare\w*|optimise\w*|nettoie\w*|remplace\w*|relance\w*|trouve\w*|cherch\w*|analy\w*|examin\w*|v[ée]rifi\w*|test\w*)\b/i;
/** Explicit intent from the requester. */
const WANT = /\b(je veux|fais en sorte|fais[- ]moi|il faut|on pourrait|peux[- ]tu|besoin de)\b/i;
/** Conceptual question → asks for a solid explanation. */
const QUESTION =
	/\b(pourquoi|explique\w*|c'est quoi|c est quoi|comment (?:ça|ca) marche|diff[ée]rence entre|quelle est|quel est|est[- ]ce que)\b/i;
/** Concept keywords, counted (up to 3). */
const CONCEPTS =
	/\b(architecture|conception|refactor|d[ée]bogu|debug|optimis|s[ée]curit|timing|algorithme|compar|pourquoi|analyse|syst[èe]me|protocole)\b/gi;
/** Explicit breakage / regression report. */
const REGRESSION = /\b(pas le m[êe]me|r[ée]gression|cass[ée]|fuit|bloqu[ée]|corriger)\b/i;
/** Shell prompt line (terminal paste: form, not difficulty). */
const SHELLLINE = /^\s*(?:\$|sudo\s|#\s)/gm;

export function difficultyScore(text: string): number {
	const t = text.trim();
	let sig = Math.min(0.3, ((t.match(CONCEPTS) ?? []).length) * 0.1);
	if (PATHY.test(t)) sig += 0.25;
	if (ACTION.test(t)) sig += 0.2;
	if (WANT.test(t)) sig += 0.1;
	if (QUESTION.test(t)) sig += 0.1;
	if (t.includes("```")) sig += 0.1;
	if (t.length > 800) sig += 0.1;
	if (t.length > 2000) sig += 0.1;
	if (REGRESSION.test(t)) sig += 0.1;
	// Terminal paste (≥3 shell prompt lines): form, not difficulty.
	if ((t.match(SHELLLINE) ?? []).length >= 3) sig -= 0.15;
	// Base 0.10: short follow-up and neutral message → lightest tier.
	return Math.round(Math.min(1, 0.1 + Math.max(0, sig)) * 100) / 100;
}

export function tierAndThinking(score: number): { tier: TierName; thinking: Thinking } {
	// Thresholds calibrated on the 880 real turns (score → real-difficulty
	// quartile table: 0.10-0.20 ≈ quartile 1, 0.30-0.45 ≈ quartile 2,
	// ≥0.55 ≈ quartile 3).
	if (score >= 0.7) return { tier: "frontier", thinking: "xhigh" };
	if (score >= 0.5) return { tier: "strong", thinking: "high" };
	if (score >= 0.3) return { tier: "standard", thinking: "medium" };
	return { tier: "eco", thinking: "low" };
}

function capThinking(auto: Thinking, userSelected: Thinking): Thinking {
	return THINKING_ORDER[Math.min(THINKING_ORDER.indexOf(auto), THINKING_ORDER.indexOf(userSelected))];
}

// Utilities

function lastUserText(messages: readonly Message[]): string {
	const content = messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
	if (typeof content === "string") return content;
	return content
		.flatMap((b) => (b.type === "text" ? [b.text] : []))
		.join("\n");
}

function editedThisTurn(messages: readonly Message[]): boolean {
	const lastUser = messages.findLastIndex((m) => m.role === "user");
	return messages
		.slice(lastUser + 1)
		.some(
			(m) =>
				m.role === "toolResult" &&
				EDIT_TOOLS.has((m as { toolName?: string }).toolName ?? "") &&
				!(m as { isError?: boolean }).isError,
		);
}

/**
 * Shared entry point for a new turn and for the safety fallback of a
 * continuation (current model banned/missing): score the current message →
 * tier. `avoid` is empty on a new turn, preserved on a safety re-route.
 */
function rerouteCurrentTurn(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	request: Req,
	avoid: string[],
	userCap: Thinking,
	prevState?: RouteState,
): ModelRoute<RouteState> {
	const score = difficultyScore(lastUserText(request.messages));
	const { tier, thinking: autoTh } = tierAndThinking(score);
	const th = capThinking(autoTh, userCap);
	const m = buildTiers(ctx, avoid)[tier];
	return toRoute(pi, ctx, m, th, prevState, {
		modelId: m.id,
		providerId: m.provider,
		thinking: th,
		avoid,
	});
}

export default function (pi: ExtensionAPI) {
	// Pi does NOT trigger `route(reason: "retry")` on 400/404 errors nor on
	// provider-quota 429s (non-retryable classes). We listen to `message_end` to:
	// 1. permanently ban models with permanent failures (400/404/410…);
	// 2. rewrite quota 429s into a retryable error, so pi starts its retry →
	//    route(reason: "retry") → cross-provider failover instead of a dead turn.
	pi.on("message_end", (event, ctx) => {
		const msg = event.message as AssistantMessage;
		if (msg?.role !== "assistant" || msg.stopReason !== "error" || !msg.errorMessage) return;
		if (isPermanentFailure(msg.errorMessage) && msg.provider && msg.model) {
			banPermanently(msg.provider, msg.model);
		}
		if (ctx.model?.provider === "auto" && ctx.model?.id === "auto") {
			const replacement = toFailoverRetryMessage(msg);
			if (replacement) return { message: replacement };
		}
	});

	// Selecting `auto` starts at thinking `low` by default (ceiling, raise it
	// with shift+tab). `model_select` only fires on a user selection: pi never
	// emits it at startup or when restoring a session.
	pi.on("model_select", (event) => {
		if (event.model.provider === "auto" && event.model.id === "auto") {
			pi.setThinkingLevel("low");
		}
	});

	pi.registerVirtualModel<RouteState>({
		provider: "auto",
		id: "auto",
		name: "Auto (routing + thinking + failover)",
		thinkingLevels: ["off", "low", "medium", "high", "xhigh"],
		contextWindow: 200_000,
		maxTokens: 64_000,
		async route(request, ctx) {
			const userCap = (request.thinkingLevel ?? "xhigh") as Thinking;

			// Compaction/summaries outside the agent loop: no session state.
			if (request.reason === "direct") {
				return {
					model: buildTiers(ctx).background,
					thinkingLevel: "low",
				};
			}

			const prevState = request.state;

			// RETRY / failover (429 / 5xx)
			if (request.reason === "retry" && request.failed) {
				const failedKey = modelKey(request.failed.model);
				if (isPermanentFailure(request.failed.message?.errorMessage ?? "")) {
					banPermanently(request.failed.model.provider, request.failed.model.id);
				}
				const baseState: RouteState = prevState ?? {
					modelId: request.failed.model.id,
					providerId: request.failed.model.provider,
					thinking: (request.failed.thinkingLevel ?? "medium") as Thinking,
					avoid: [],
				};
				const avoid = [
					...new Set([
						...baseState.avoid,
						// Provider quota: avoid the whole provider, otherwise the failover
						// lands on another of its models and fails again immediately.
						PROVIDER_LIMIT_RE.test(request.failed.message?.errorMessage ?? "")
							? request.failed.model.provider
							: failedKey,
					]),
				];
				const tiers = buildTiers(ctx, avoid);
				const ladder: TierName[] =
					avoid.length >= 3 ? ["standard", "eco"] : ["strong", "standard", "eco"];
				const chosen =
					ladder
						.map((t) => tiers[t])
						.find((m) => m && !avoid.includes(modelKey(m)) && !avoid.includes(m.provider)) ??
					tiers.frontier;
				const th = capThinking(baseState.thinking, userCap);
				return toRoute(pi, ctx, chosen, th, prevState, {
					...baseState,
					modelId: chosen.id,
					providerId: chosen.provider,
					thinking: th,
					avoid,
				});
			}

			// CONTINUATION (same turn, after tool calls)
			if (request.reason === "continuation" && prevState) {
				const avoid = prevState.avoid ?? [];

				// First successful edit/write of the turn → switch to the eco tier for
				// the rest of the turn (editedThisTurn stays true: toolResults accumulate).
				if (editedThisTurn(request.messages)) {
					const eco = buildTiers(ctx, avoid).eco;
					const th = capThinking("medium", userCap);
					return toRoute(pi, ctx, eco, th, prevState, {
						...prevState,
						modelId: eco.id,
						providerId: eco.provider,
						thinking: th,
						avoid,
					});
				}

				// No edit yet → keep the current model to preserve the prompt cache
				// and the `avoid` list; if it was banned meanwhile, fall through to
				// the safety fallback below.
				const currentKey = modelKey({ provider: prevState.providerId, id: prevState.modelId });
				if (
					!permanentDenylist.has(currentKey) &&
					!avoid.includes(currentKey) &&
					!avoid.includes(prevState.providerId)
				) {
					const m = ctx.modelRegistry.find(prevState.providerId, prevState.modelId) as
						| Model<never>
						| undefined;
					if (m) {
						const th = capThinking(prevState.thinking, userCap);
						return toRoute(pi, ctx, m, th, prevState, { ...prevState, thinking: th });
					}
				}
				// Safety fallback: current model banned/missing → re-route the SAME
				// turn (difficultyScore on the current message, `avoid` kept).
				return rerouteCurrentTurn(pi, ctx, request, prevState.avoid, userCap, prevState);
			}

			// NEW TURN (user message)
			return rerouteCurrentTurn(pi, ctx, request, [], userCap, prevState);
		},
	});
}
