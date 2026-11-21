/**
 * auto-route — virtual model `auto/auto`: full automatic routing.
 *
 * /model → "auto":
 * - candidates = paid reasoning chat models with valid credentials, excluding
 *   free models, training models (`contributor`) and retired generations
 *   (`gemini-2.5-*`);
 * - capacity tiers built at runtime (output cost as a proxy);
 * - difficulty of each NEW turn: ONE classification when a classifier model is
 *   available (auto-detected from any provider with working credentials, free
 *   ones first); otherwise — or on any failure (no classifier, low
 *   confidence, timeout, error) — a local bilingual (FR + EN) heuristic scores
 *   the message, as a silent fallback;
 * - difficulty → tier + thinking: heuristic thresholds and classifier answers
 *   map onto the same four tiers;
 * - the thinking level chosen in pi (`shift+tab`) acts as a CEILING;
 * - failover on retry (429/5xx) plus a `message_end` listener that bans
 *   PERMANENTLY models returning 400/404 (pi does not retry non-429 4xx);
 *   429 "provider quota" errors, which pi treats as non-retryable, are
 *   rewritten into retryable 429s so the same failover (cross-provider)
 *   runs instead of letting the turn die;
 * - selecting `auto` starts at thinking `low` by default (ceiling, raise it
 *   later with shift+tab);
 * - ONE discreet status line (`⚡ model · thinking · source`);
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
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const EDIT_TOOLS = new Set(["edit", "write"]);

/** Output cost assumed for models without pricing data: mid-tier, neither free nor frontier. */
const UNKNOWN_OUTPUT_COST = 1;

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

/**
 * pi's agent config dir: honors PI_CODING_AGENT_DIR (its own env var, tilde
 * expanded), else falls back to ~/.pi/agent.
 */
function agentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
	if (envDir) return envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir;
	return join(homedir(), ".pi", "agent");
}
/** File of permanently banned models (400/404/410 discovered on the fly). */
const DENYLIST_FILE = join(agentDir(), "auto-route-denylist.json");

type Thinking = "off" | "low" | "medium" | "high" | "xhigh";
type TierName = "frontier" | "strong" | "standard" | "eco";
const THINKING_ORDER: Thinking[] = ["off", "low", "medium", "high", "xhigh"];

interface RouteState {
	modelId: string;
	providerId: string;
	thinking: Thinking;
	/** provider/id entries avoided for THIS turn (transient failures). */
	avoid: string[];
	/** Where the tier decision came from: "local" or the classifier's key. */
	source?: string;
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
		a.avoid.every((v, i) => v === b.avoid[i]) &&
		a.source === b.source
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

/** Permanent failure (model retired, 404/410, refuses training, unsupported region, disabled model access…). */
export function isPermanentFailure(message: string): boolean {
	return /no longer available|not found|\b404\b|\b410\b|ModelDeprecated|deprecated|discontinued|trains on request data|hosted outside Europe|requires Global regions|does not exist|no API implementation|unsupported|permission_error|model access is disabled|access to this model|do not have access/i.test(
		message,
	);
}

/**
 * Any provider-wide limit (quota, rate limit, billing, bare 429): used on retry
 * to decide provider-wide avoidance — an account-level limit hits every model
 * of that provider, so failing over within it would fail again immediately.
 */
export const PROVIDER_LIMIT_RE =
	/gousagelimiterror|freeusagelimiterror|usage limit|available balance|credit balance|insufficient_quota|out of budget|out of credit|quota|billing|subscription_sharing|resource_exhausted|rate.?limit|too many requests|\b429\b/i;

/**
 * The subset pi classifies as NON-retryable (its retry would never start, so
 * the turn dies). Only those get rewritten into a retryable 429 by
 * `toFailoverRetryMessage`; already-retryable errors (transient rate limits,
 * 5xx…) keep their original text untouched. Two families: provider-wide
 * quota/billing limits, and model access disabled on the account (a 403 the
 * provider never lifts for this key — same account, other models, still
 * usable, so the model alone is avoided and the turn continues elsewhere).
 */
const NON_RETRYABLE_QUOTA_RE =
	/gousagelimiterror|freeusagelimiterror|monthly usage limit reached|available balance|insufficient balance|credit balance|insufficient_quota|out of budget|out of credit|quota exceeded|exceeded your current quota|billing|subscription_sharing|resource_exhausted|permission_error|model access is disabled|access to this model|do not have access/i;

/**
 * Model-access family (subset of NON_RETRYABLE_QUOTA_RE): the account cannot
 * use THIS model. Unlike a quota, other models of the same provider may still
 * work, so the retry avoids the model alone, not the whole provider.
 */
const MODEL_ACCESS_RE =
	/permission_error|model access is disabled|access to this model|do not have access|not enabled on this account/i;

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
		!NON_RETRYABLE_QUOTA_RE.test(msg.errorMessage)
	) {
		return undefined;
	}
	const modelAccess = MODEL_ACCESS_RE.test(msg.errorMessage);
	return {
		...msg,
		errorMessage: modelAccess
			? `auto-route: 429 model access — ${msg.provider}/${msg.model} not enabled on this account; retrying on another model`
			: `auto-route: 429 provider quota — ${msg.provider}/${msg.model} at limit; retrying on another model`,
	};
}

// Dynamic catalog

function candidateModels(ctx: ExtensionContext): Model<never>[] {
	return (ctx.modelRegistry.getAvailable() as Model<never>[]).filter((m) => {
		if (permanentDenylist.has(modelKey(m))) return false;
		if (EXCLUDED_MODEL_RE.test(m.id) || EXCLUDED_MODEL_RE.test(m.name)) return false;
		// A model is free only when its pricing says so; missing pricing means
		// unknown, not free, so it stays a candidate.
		const free = m.cost !== undefined && m.cost.input === 0 && m.cost.output === 0;
		return m.reasoning !== false && !free;
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
		// Unknown pricing ranks as mid cost so pricing-less models land in the
		// middle tiers instead of being dumped into eco or promoted to frontier.
		const ca = a.cost?.output ?? UNKNOWN_OUTPUT_COST;
		const cb = b.cost?.output ?? UNKNOWN_OUTPUT_COST;
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
	source?: string,
): void {
	const shown = source ?? "local";
	try {
		const dim = ctx.ui.theme?.fg?.bind(ctx.ui.theme) ?? ((_: string, s: string) => s);
		ctx.ui.setStatus("auto", dim("dim", `⚡ ${modelKey(m)} · ${thinking} · ${shown}`));
	} catch {
		ctx.ui.setStatus("auto", `${modelKey(m)} · ${thinking} · ${shown}`);
	}
	pi.events.emit("auto-route:routed", {
		provider: m.provider,
		modelId: m.id,
		thinking,
		source: shown,
	});
}

function toRoute(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	m: Model<never>,
	thinking: Thinking,
	source: string | undefined,
	prevState?: RouteState,
	nextState?: RouteState,
): ModelRoute<RouteState> {
	setStatusLine(pi, ctx, m, thinking, source);
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
/**
 * Construction / modification / analysis verbs → the agent is about to do work.
 * The colloquial imperatives (fais, regarde, prend, donne, met, lance, écris,
 * essaie, montre) are as frequent as the formal ones in real prompts: leaving
 * them out scored "fais le portage français" at 0.10 and routed a turn of 49
 * tool calls and 82k output tokens to the eco tier. English stems a French
 * pattern already covers (impl-, develop-, gener-, analy-, test, install: the
 * accent classes hold the plain letters too) are not repeated.
 */
const ACTION =
	/\b(reprend\w*|construi\w*|impl[ée]ment\w*|cré[ée]r?|cree\w*|g[ée]n[èe]r\w*|d[ée]velop\w*|migre\w*|refais|refaire|transforme\w*|modifi\w*|ajout\w*|supprim\w*|corrige\w*|corrig\w*|install\w*|configure\w*|[ée]crase\w*|r[ée]pare\w*|optimise\w*|nettoie\w*|remplace\w*|relance\w*|trouve\w*|cherch\w*|analy\w*|examin\w*|v[ée]rifi\w*|test\w*|fais\w*|faire|regarde\w*|prends?\b|donnes?\b|mets?\b|lance\w*|[ée]cris\b|essaie\w*|montre\w*|make|do(es)?\b|build|creat\w*|migrat\w*|redo|transform|modif\w*|add\w*|remov\w*|delet\w*|fix\w*|repair|configur\w*|overwrit\w*|optimi[sz]\w*|clean|replac\w*|relaunch|restart|find\w*|search\w*|exam\w*|check\w*|look\w*|take|put|launch\w*|run\b|writes?\b|try\b|show\w*|open\w*|read\w*|updat\w*|refactor\w*)\b/i;
/** Explicit intent from the requester, in French or English. */
const WANT =
	/\b(je veux|fais en sorte|fais[- ]moi|il faut|on pourrait|peux[- ]tu|besoin de|i want|make sure|i need|can you|could you|we could|need to|please\b)\b/i;
/** Conceptual question → asks for a solid explanation. */
const QUESTION =
	/\b(pourquoi|explique\w*|c'est quoi|c est quoi|comment (?:ça|ca) marche|diff[ée]rence entre|quelle est|quel est|est[- ]ce que|why\b|explain\w*|what (?:is|are|does)|what's|how (?:does|do|to)|difference between|which (?:is|one)|is there)\b/i;
/** Concept keywords, counted (up to 3); French and English stems. */
const CONCEPTS =
	/\b(architecture|conception|refactor|d[ée]bogu|debug|optimi[sz]|s[ée]curit|security|timing|algorithme|algorithm|compar|pourquoi|analyse|syst[èe]me|system|protocole|protocol|concept|tradeoff|modul\w*|scal\w*)\b/gi;
/** Explicit breakage / regression report, in French or English. */
const REGRESSION =
	/\b(pas le m[êe]me|r[ée]gression|cass[ée]|fuit|bloqu[ée]|corriger|not the same|broken|broke\b|leak\w*|blocked|stuck|crash\w*|fails?\b|error\w*|wrong)\b/i;
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
	// Thresholds raised from 0.50/0.70 to 0.60/0.75 on 926 real turns, after the
	// ACTION regex picked up the colloquial imperatives: with both changes a
	// path + verb pair no longer justifies an expensive tier ("corrige le bug
	// dans src/foo.ts" used to reach strong). Measured against the real-difficulty
	// proxy: expensive routings 104 → 85, heaviest-quartile turns sent to eco
	// 82 → 53, light turns in an expensive tier 52 → 44, Spearman +0.288 → +0.339.
	if (score >= 0.75) return { tier: "frontier", thinking: "xhigh" };
	if (score >= 0.6) return { tier: "strong", thinking: "high" };
	if (score >= 0.3) return { tier: "standard", thinking: "medium" };
	return { tier: "eco", thinking: "low" };
}

function capThinking(auto: Thinking, userSelected: Thinking): Thinking {
	return THINKING_ORDER[Math.min(THINKING_ORDER.indexOf(auto), THINKING_ORDER.indexOf(userSelected))];
}

// Hybrid classifier (optional; auto-detected, silent fallback)

/** Tier decision handed back by a classifier: target tier plus provenance. */
export interface TierDecision {
	tier: TierName;
	thinking: Thinking;
	via: string;
}

/** Classifier answer → tier, mirroring `tierAndThinking`'s thresholds. */
const CHOICE_TO_TIER: Record<string, { tier: TierName; thinking: Thinking }> = {
	light: { tier: "eco", thinking: "low" },
	standard: { tier: "standard", thinking: "medium" },
	complex: { tier: "strong", thinking: "high" },
	heavy: { tier: "frontier", thinking: "xhigh" },
};

/**
 * Asks an available classifier model to sort a turn into a tier: the catalog is
 * auto-detected across every provider with working credentials, free
 * classifiers first, then the cheaper ones. Only the user prompt is sent,
 * truncated to 16k characters — never the system prompt, the history or tool
 * results. The question is asked in English: classifiers are multilingual.
 * Never throws: no classifier, a 4-second timeout, an abort, an unexpected
 * answer or one below 0.50 confidence all return undefined, so the caller
 * silently falls back to the local heuristic.
 */
export async function classifyTier(
	ctx: ExtensionContext,
	text: string,
	signal?: AbortSignal,
): Promise<TierDecision | undefined> {
	try {
		const available = (await ctx.modelRegistry.getAvailableOfType("classifier")) ?? [];
		const candidates: Array<{ model: (typeof available)[number]; apiKey?: string }> =
			available.map((model) => ({ model }));
		// OpenCode's free classifier (opencode/jev-1.13-free) lives under the
		// "opencode" provider in pi's catalog, yet accepts an "opencode-go" key
		// at zero cost. Passing that key per request unlocks Jev for Go users
		// without enabling "opencode" globally (which would flood /model with
		// pay-as-you-go Zen chat models that fail with HTTP 402).
		if (!candidates.some((c) => c.model.provider === "opencode")) {
			const freeOc = (ctx.modelRegistry.getModelsOfType?.("classifier", "opencode") ?? []).filter(
				(m) => m.cost?.input === 0,
			);
			if (freeOc.length > 0) {
				const goKey = await ctx.modelRegistry.getApiKeyForProvider?.("opencode-go");
				if (goKey) {
					for (const model of freeOc) candidates.push({ model, apiKey: goKey });
				}
			}
		}
		if (candidates.length === 0) return undefined;
		// Free classifiers first, then ascending input cost; unknown pricing
		// ranks last. Array sort is stable, so the catalog order survives.
		const picked = [...candidates].sort((a, b) => {
			const freeA = a.model.cost?.input === 0;
			const freeB = b.model.cost?.input === 0;
			if (freeA !== freeB) return freeA ? -1 : 1;
			return (
				(a.model.cost?.input ?? Number.POSITIVE_INFINITY) -
				(b.model.cost?.input ?? Number.POSITIVE_INFINITY)
			);
		})[0];
		if (!picked) return undefined;
		const timeoutSignal = AbortSignal.timeout(4_000);
		const result = await ctx.modelRegistry.classify(
			picked.model,
			{
				state: { prompt: text.slice(0, 16_000) },
				questions: {
					difficulty: {
						type: "choice",
						instructions:
							"How demanding is the software engineering work requested in prompt?",
						criteria: {
							light: "A quick question, a short follow-up, or a trivial change",
							standard: "An ordinary feature, fix, review, or explanation",
							complex: "Subtle design, cross-cutting changes, or hard debugging",
							heavy: "Architecture-level rework or a long multi-step implementation",
						},
					},
				},
			},
			{
				signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
				...(picked.apiKey ? { apiKey: picked.apiKey } : {}),
			},
		);
		if (result.stopReason !== "stop") return undefined;
		const answer = result.answers?.difficulty;
		if (answer?.type !== "choice") return undefined;
		const decision = CHOICE_TO_TIER[answer.choice];
		if (!decision) return undefined;
		const probability = answer.probabilities[answer.choice] ?? answer.confidence ?? 0;
		if (probability < 0.5) return undefined;
		return { ...decision, via: modelKey(picked.model) };
	} catch {
		return undefined;
	}
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
 * continuation (current model banned/missing): decide the tier of the current
 * message — ONE classifier call when a classifier is available, the local
 * bilingual heuristic otherwise. `avoid` is empty on a new turn, preserved on
 * a safety re-route.
 */
async function rerouteCurrentTurn(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	request: ModelRouteRequest<RouteState>,
	avoid: string[],
	userCap: Thinking,
	prevState?: RouteState,
): Promise<ModelRoute<RouteState>> {
	const text = lastUserText(request.messages);
	// Classifier first; the local bilingual heuristic is the silent fallback.
	const decision = await classifyTier(ctx, text, request.signal);
	let tier: TierName;
	let thinking: Thinking;
	let source: string;
	if (decision) {
		({ tier, thinking } = decision);
		source = decision.via;
	} else {
		({ tier, thinking } = tierAndThinking(difficultyScore(text)));
		source = "local";
	}
	const th = capThinking(thinking, userCap);
	const m = buildTiers(ctx, avoid)[tier];
	return toRoute(pi, ctx, m, th, source, prevState, {
		modelId: m.id,
		providerId: m.provider,
		thinking: th,
		avoid,
		source,
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
						// Model access disabled on the account: a per-model problem — other
						// models of the same provider may still work, so avoid the model
						// alone. Provider quota: avoid the whole provider, otherwise the
						// failover lands on another of its models and fails again at once.
						MODEL_ACCESS_RE.test(request.failed.message?.errorMessage ?? "")
							? failedKey
							: PROVIDER_LIMIT_RE.test(request.failed.message?.errorMessage ?? "")
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
				return toRoute(pi, ctx, chosen, th, baseState.source, prevState, {
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
					return toRoute(pi, ctx, eco, th, prevState.source, prevState, {
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
						return toRoute(pi, ctx, m, th, prevState.source, prevState, {
							...prevState,
							thinking: th,
						});
					}
				}
				// Safety fallback: current model banned/missing → re-route the SAME
				// turn (classifier or local score on the current message, `avoid` kept).
				return await rerouteCurrentTurn(pi, ctx, request, prevState.avoid, userCap, prevState);
			}

			// NEW TURN (user message): one classifier call, else the local heuristic.
			return await rerouteCurrentTurn(pi, ctx, request, [], userCap, prevState);
		},
	});
}
