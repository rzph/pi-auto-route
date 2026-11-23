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

import type {
	Api,
	AssistantMessage,
	ClassifierApi,
	ClassifierModel,
	Message,
	Model,
	ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRoute,
	ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const EDIT_TOOLS = new Set(["edit", "write"]);

/** Output cost assumed for models without pricing data: mid-tier, neither free nor frontier. */
const UNKNOWN_OUTPUT_COST = 1;

/** Number of turn-local failures (`avoid` entries) after which the retry ladder drops the `strong` tier. */
const DEGRADE_AFTER_FAILURES = 3;

/**
 * ID/name patterns excluded up front:
 * - `free`: tight quotas / constant timeouts;
 * - `contributor`: OpenCode endpoints that train on your requests;
 * - `gemini-2.5-`: retired by Google for new accounts (404);
 * - `mimo-v2.5`: deprecated on OpenCode Go (410 ModelDeprecated);
 * - `mimo-v2.6`: emits raw XML `<tool_call>` tags alongside empty `tool_calls`
 *   deltas (`id: ""`, `name: ""`), poisoning the session transcript;
 * - `computer-use` / `robotics` / `deep-research`: specialized non-code models.
 */
const EXCLUDED_MODEL_RE =
	/free|contributor|gemini-2\.5-|mimo-v2\.[56]\b|computer-use|robotics|deep-research/i;

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

type Thinking = ModelThinkingLevel;
type TierName = "frontier" | "strong" | "standard" | "eco";
const THINKING_ORDER: readonly Thinking[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

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

/** Clears the in-memory and on-disk permanent denylist (used by tests). */
export function resetDenylist(): void {
	permanentDenylist.clear();
	try {
		rmSync(DENYLIST_FILE, { force: true });
	} catch {
		// best effort
	}
}

// Error classification & pi-ai retry compatibility
//
// Inside `pi`, `@earendil-works/pi-ai` resolves via jiti; under `node --test`
// without a local `node_modules/`, the dynamic import falls back to the exact
// two regexes from `@earendil-works/pi-ai/dist/utils/retry.js`.

const PI_NON_RETRYABLE_LIMIT_RE =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing|subscription_sharing_usage_limit_exceeded|subscription_sharing_workplace_individual_usage_limit_exceeded|"code"\s*:\s*"?1308(?![0-9])/i;

const PI_RETRYABLE_ERROR_RE =
	/overloaded|server_busy|servers are currently busy|currently experiencing high demand|model is at capacity|rate.?limit|too many requests|(?<![a-z0-9])(?:429|500|502|503|504|520|524)(?![a-z0-9])|service.?(?:is.?)?(?:temporarily.?)?unavailable|server.?error|internal.?error|provider.?returned.?(?:an.?)?error|exceeded request buffer limit while retrying upstream|unable to forward upstream|upstream.?request.?failed|upstream_stream_read_error|stream was interrupted|http\/?2 stream failed|network.?error|connection.?error|connection.?refused|connection.?lost|connection.?closed|other side closed|fetch failed|request to \S+ failed, reason:|getaddrinfo|(?<![a-z0-9_])(?:ECONNRESET|ECONNABORTED|ECONNREFUSED|ETIMEDOUT|EPIPE)(?![a-z0-9_])|connection reset by peer|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|terminated|websocket.?closed|websocket.?error|websocket.?connection.?limit.?reached|ended without|stream ended before message_stop|stream ended before a terminal response event|http2 request did not get a response|stream disconnected before completion|cut short after the reply had begun|pending stream has been canceled|retry delay|you can retry your request|try your request again|please retry your request|ResourceExhausted|subscription_sharing_usage_unavailable|subscription_sharing_user_unavailable/i;

function fallbackIsRetryableAssistantError(msg: AssistantMessage): boolean {
	if (msg.stopReason !== "error" || !msg.errorMessage) return false;
	if (PI_NON_RETRYABLE_LIMIT_RE.test(msg.errorMessage)) return false;
	return PI_RETRYABLE_ERROR_RE.test(msg.errorMessage);
}

const isRetryableAssistantError: (msg: AssistantMessage) => boolean =
	(await import("@earendil-works/pi-ai")
		.then((m) => m.isRetryableAssistantError)
		.catch(() => undefined)) ?? fallbackIsRetryableAssistantError;

export type FailureKind = "permanent" | "model-access" | "provider-limit" | "transient";

const MODEL_ACCESS_FAILURE_RE =
	/429 model access|permission_error|model access is disabled|access to this model|do not have access|not enabled on this account/i;

const PERMANENT_FAILURE_RE =
	/\b404\b|\b410\b|no longer available|model[^\n]*not found|not found for api version|does not exist|ModelDeprecated|deprecated|discontinued|trains on request data|hosted outside Europe|requires Global regions|no API implementation|unsupported (?:model|region|location|country|feature|endpoint)/i;

const PROVIDER_LIMIT_FAILURE_RE =
	/gousagelimiterror|freeusagelimiterror|usage limit|available balance|insufficient balance|credit balance|insufficient_quota|out of budget|out of credit|quota|billing|subscription_sharing|resource_exhausted|"code"\s*:\s*"?1308(?![0-9])|rate.?limit|too many requests|(?<![a-z0-9])429(?![a-z0-9])/i;

const TRANSCRIPT_TOOL_CALL_FAILURE_RE =
	/tool_call_id|function_response\.name|tool_use_id|tool_call.*must include|Name cannot be empty/i;

const MISSING_TOOL_NAME = "__missing_tool_name__";

/**
 * Classifies an assistant error message into one of four disjoint failure kinds:
 * - `"model-access"`: account cannot use THIS model (403 permission_error) — ban
 *   the model permanently, avoid the model alone, and rewrite into a retryable 429;
 * - `"permanent"`: model retired, 404/410, policy/region rejection — ban the
 *   model permanently;
 * - `"provider-limit"`: provider-wide quota, balance, billing, or rate limit —
 *   avoid the whole provider on retry, and rewrite when pi considers it non-retryable;
 * - `"transient"`: everything else (5xx, network, request-specific 400…) — avoid
 *   only the failed model for the current turn.
 */
export function classifyFailure(message: string): FailureKind {
	if (MODEL_ACCESS_FAILURE_RE.test(message)) return "model-access";
	if (PERMANENT_FAILURE_RE.test(message)) return "permanent";
	if (PROVIDER_LIMIT_FAILURE_RE.test(message)) return "provider-limit";
	return "transient";
}

/**
 * Turns a non-retryable provider-quota, model-access, or transcript tool-call
 * schema error (e.g. Google 400 `function_response.name: Name cannot be empty`)
 * into a "429" pi is willing to retry. Pi drops these errors (retrying the same
 * provider is pointless); under auto-route the failover changes provider or
 * model, so a retry becomes useful: pi then calls `route(reason: "retry")` and
 * the router switches. Already-retryable errors (transient 429 rate limits,
 * Google `RESOURCE_EXHAUSTED` without billing/quota-exceeded wording, 5xx…)
 * keep their original text untouched.
 */
export function toFailoverRetryMessage(msg: AssistantMessage): AssistantMessage | undefined {
	if (msg.stopReason !== "error" || !msg.errorMessage) return undefined;
	if (isRetryableAssistantError(msg)) return undefined;
	const kind = classifyFailure(msg.errorMessage);
	if (kind === "model-access") {
		return {
			...msg,
			errorMessage: `auto-route: 429 model access — ${msg.provider}/${msg.model} not enabled on this account; retrying on another model`,
		};
	}
	if (kind === "provider-limit") {
		return {
			...msg,
			errorMessage: `auto-route: 429 provider quota — ${msg.provider}/${msg.model} at limit; retrying on another model`,
		};
	}
	if (kind === "transient" && TRANSCRIPT_TOOL_CALL_FAILURE_RE.test(msg.errorMessage)) {
		return {
			...msg,
			errorMessage: `auto-route: 429 tool schema — ${msg.provider}/${msg.model} rejected a malformed tool call in history; retrying on another model`,
		};
	}
	return undefined;
}

/**
 * Repairs assistant `toolCall` blocks that carry an empty `id` or `name` before
 * pi executes or persists them, so no `toolResult` with `toolCallId: ""` or
 * `toolName: ""` can ever enter the session transcript.
 */
export function sanitizeAssistantToolCalls(msg: AssistantMessage): AssistantMessage | undefined {
	if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return undefined;
	let changed = false;
	const content = msg.content.map((block, i) => {
		if (block.type !== "toolCall") return block;
		const rawId = typeof block.id === "string" ? block.id.trim() : "";
		const rawName = typeof block.name === "string" ? block.name.trim() : "";
		const id = rawId || `call_fallback_${msg.timestamp || i}_${i}`;
		const name = rawName || MISSING_TOOL_NAME;
		if (id !== block.id || name !== block.name) {
			changed = true;
			return { ...block, id, name };
		}
		return block;
	});
	return changed ? { ...msg, content } : undefined;
}

/**
 * Repairs already-persisted `toolCall` / `toolResult` pairs with empty `id` or
 * `name` in the in-flight conversation context, so existing sessions poisoned by
 * a broken tool call never trigger 400 errors on OpenAI or Google providers.
 */
export function sanitizeContextMessages(messages: readonly Message[]): Message[] | undefined {
	let changed = false;
	let seq = 0;
	const pendingQueue: Array<{ id: string; name: string }> = [];

	const out = messages.map((m) => {
		if (m.role === "assistant" && Array.isArray(m.content)) {
			let blockChanged = false;
			const content = m.content.map((block) => {
				if (block.type !== "toolCall") return block;
				const rawId = typeof block.id === "string" ? block.id.trim() : "";
				const rawName = typeof block.name === "string" ? block.name.trim() : "";
				const id = rawId || `call_repaired_${++seq}`;
				const name = rawName || MISSING_TOOL_NAME;
				if (!rawId || !rawName) {
					pendingQueue.push({ id, name });
				}
				if (id !== block.id || name !== block.name) {
					blockChanged = true;
					return { ...block, id, name };
				}
				return block;
			});
			if (blockChanged) {
				changed = true;
				return { ...m, content };
			}
			return m;
		}
		if (m.role === "toolResult") {
			const rawId = typeof m.toolCallId === "string" ? m.toolCallId.trim() : "";
			const rawName = typeof m.toolName === "string" ? m.toolName.trim() : "";
			if (!rawId || !rawName) {
				const paired = pendingQueue.shift();
				const toolCallId = rawId || paired?.id || `call_repaired_${++seq}`;
				const toolName = rawName || paired?.name || MISSING_TOOL_NAME;
				changed = true;
				return { ...m, toolCallId, toolName };
			}
		}
		return m;
	});

	return changed ? out : undefined;
}

// Dynamic catalog

function candidateModels(ctx: ExtensionContext): Model<Api>[] {
	return ctx.modelRegistry.getAvailable().filter((m) => {
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
	const at = (frac: number): Model<Api> =>
		sorted[Math.min(sorted.length - 1, Math.floor(frac * sorted.length))];
	return {
		frontier: at(0),
		strong: at(0.33),
		standard: at(0.66),
		eco: sorted[sorted.length - 1],
	} as const;
}

// Status (one discreet line)

function setStatusLine(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	m: Model<Api>,
	thinking: Thinking,
	source?: string,
): void {
	const shown = source ?? "local";
	const text = `⚡ ${modelKey(m)} · ${thinking} · ${shown}`;
	ctx.ui.setStatus("auto", ctx.ui.theme ? ctx.ui.theme.fg("dim", text) : text);
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
	m: Model<Api>,
	thinking: Thinking,
	source: string | undefined,
	state?: RouteState,
): ModelRoute<RouteState> {
	setStatusLine(pi, ctx, m, thinking, source);
	return {
		model: m,
		thinkingLevel: thinking,
		state,
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
	const autoIdx = THINKING_ORDER.indexOf(auto);
	const userIdx = THINKING_ORDER.indexOf(userSelected);
	if (autoIdx === -1 || userIdx === -1) return auto;
	return THINKING_ORDER[Math.min(autoIdx, userIdx)];
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
 * Providers whose zero-cost classifiers accept another provider's API key per
 * request. OpenCode's free classifier (opencode/jev-1.13-free) lives under
 * "opencode" in pi's catalog, yet accepts an OpenCode-family key at zero cost:
 * passing that key per request unlocks Jev without enabling "opencode"
 * globally (which would flood /model with pay-as-you-go Zen chat models that
 * fail with HTTP 402).
 */
const BORROWED_CLASSIFIER_PROVIDERS: ReadonlyArray<string> = ["opencode"];

/** Providers whose key authenticates against the target, tried first. */
const KEY_PREFERENCE: ReadonlyArray<string> = ["opencode-go", "opencode"];

/** Every provider that currently holds a usable key, OpenCode keys first. */
async function providersWithKeys(
	ctx: ExtensionContext,
): Promise<Array<{ provider: string; apiKey: string }>> {
	const seen = new Set<string>();
	for (const model of ctx.modelRegistry.getAll?.() ?? []) seen.add(model.provider);
	const withKeys: Array<{ provider: string; apiKey: string }> = [];
	for (const provider of seen) {
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider?.(provider);
		if (apiKey) withKeys.push({ provider, apiKey });
	}
	const rank = (provider: string) => {
		const index = KEY_PREFERENCE.indexOf(provider);
		return index === -1 ? KEY_PREFERENCE.length : index;
	};
	return withKeys.sort((a, b) => rank(a.provider) - rank(b.provider));
}

/**
 * Borrowed candidates for the free classifiers of the target providers: one
 * entry per (model, key) pair, the keys that authenticate first. Any provider
 * that holds a key can supply the identity token, so a Google or Anthropic
 * account works too — a key the classifier rejects is simply skipped by the
 * caller trying the next entry.
 */
async function borrowedFreeClassifiers(
	ctx: ExtensionContext,
	available: readonly ClassifierModel<ClassifierApi>[],
): Promise<Array<{ model: ClassifierModel<ClassifierApi>; apiKey: string }>> {
	const borrowed: Array<{ model: ClassifierModel<ClassifierApi>; apiKey: string }> = [];
	const freeModels: ClassifierModel<ClassifierApi>[] = [];
	for (const provider of BORROWED_CLASSIFIER_PROVIDERS) {
		if (available.some((m) => m.provider === provider)) continue;
		for (const model of ctx.modelRegistry.getModelsOfType?.("classifier", provider) ?? []) {
			if (model.cost?.input === 0) freeModels.push(model);
		}
	}
	if (freeModels.length === 0) return borrowed;
	for (const { apiKey } of await providersWithKeys(ctx)) {
		for (const model of freeModels) borrowed.push({ model, apiKey });
	}
	return borrowed;
}

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
		const candidates: Array<{
			model: ClassifierModel<ClassifierApi>;
			apiKey?: string;
		}> = [...available.map((model) => ({ model })), ...(await borrowedFreeClassifiers(ctx, available))];
		if (candidates.length === 0) return undefined;
		// Free classifiers first, then ascending input cost; unknown pricing
		// ranks last. Array sort is stable, so the catalog order survives.
		const ordered = [...candidates].sort((a, b) => {
			const freeA = a.model.cost?.input === 0;
			const freeB = b.model.cost?.input === 0;
			if (freeA !== freeB) return freeA ? -1 : 1;
			return (
				(a.model.cost?.input ?? Number.POSITIVE_INFINITY) -
				(b.model.cost?.input ?? Number.POSITIVE_INFINITY)
			);
		});
		if (ordered.length === 0) return undefined;
		const timeoutSignal = AbortSignal.timeout(4_000);
		const questions = {
			difficulty: {
				type: "choice" as const,
				instructions: "How demanding is the software engineering work requested in prompt?",
				criteria: {
					light: "A quick question, a short follow-up, or a trivial change",
					standard: "An ordinary feature, fix, review, or explanation",
					complex: "Subtle design, cross-cutting changes, or hard debugging",
					heavy: "Architecture-level rework or a long multi-step implementation",
				},
			},
		};
		// Borrowed candidates are tried in order: a key the classifier rejects
		// moves on to the next one instead of falling back to the heuristic.
		for (const candidate of ordered) {
			const result = await ctx.modelRegistry.classify(
				candidate.model,
				{ state: { prompt: text.slice(0, 16_000) }, questions },
				{
					signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
					...(candidate.apiKey ? { apiKey: candidate.apiKey } : {}),
				},
			);
			if (result.stopReason !== "stop") continue;
			const answer = result.answers?.difficulty;
			if (answer?.type !== "choice") continue;
			const decision = CHOICE_TO_TIER[answer.choice];
			if (!decision) continue;
			const probability = answer.probabilities[answer.choice] ?? answer.confidence;
			if (probability < 0.5) continue;
			return { ...decision, via: modelKey(candidate.model) };
		}
		return undefined;
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
		.some((m) => m.role === "toolResult" && EDIT_TOOLS.has(m.toolName) && !m.isError);
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
	return toRoute(pi, ctx, m, th, source, {
		modelId: m.id,
		providerId: m.provider,
		thinking: th,
		avoid,
		source,
	});
}

export default function (pi: ExtensionAPI) {
	// Sanitize already-persisted toolCall / toolResult messages with empty IDs or
	// names before each provider request, healing sessions poisoned earlier.
	pi.on("context", (event) => {
		const messages = sanitizeContextMessages(event.messages);
		if (messages) return { messages };
	});

	// Pi does NOT trigger `route(reason: "retry")` on 400/404 errors nor on
	// provider-quota 429s (non-retryable classes). We listen to `message_end` to:
	// 1. repair malformed assistant toolCalls (`id: ""` or `name: ""`) before pi
	//    executes or persists them;
	// 2. permanently ban models with permanent failures (404/410, retired models,
	//    disabled model access…) — passively even when a physical model is
	//    selected outside `auto/auto`, so the denylist learns dead endpoints
	//    opportunistically;
	// 3. rewrite quota/access/tool-schema errors into a retryable 429 when
	//    `auto/auto` is active, so pi starts its retry → route(reason: "retry")
	//    → failover.
	pi.on("message_end", (event, ctx) => {
		const msg = event.message as AssistantMessage;
		if (msg?.role !== "assistant") return;
		const repaired = sanitizeAssistantToolCalls(msg);
		if (msg.stopReason !== "error" || !msg.errorMessage) {
			if (repaired) return { message: repaired };
			return;
		}
		const target = repaired ?? msg;
		const kind = classifyFailure(target.errorMessage!);
		if (kind === "permanent" || kind === "model-access") {
			banPermanently(target.provider, target.model);
		}
		if (ctx.model?.provider === "auto" && ctx.model?.id === "auto") {
			const replacement = toFailoverRetryMessage(target);
			if (replacement) return { message: replacement };
		}
		if (repaired) return { message: repaired };
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
			const userCap = request.thinkingLevel;

			// Compaction/summaries outside the agent loop: no session state.
			if (request.reason === "direct") {
				return {
					model: buildTiers(ctx).eco,
					thinkingLevel: "low",
				};
			}

			const prevState = request.state;

			// RETRY / failover (429 / 5xx, or router-level retry when `failed` is absent)
			if (request.reason === "retry") {
				let avoid = prevState?.avoid ?? [];
				if (request.failed) {
					const failedKey = modelKey(request.failed.model);
					const kind = classifyFailure(request.failed.message?.errorMessage ?? "");
					if (kind === "permanent" || kind === "model-access") {
						banPermanently(request.failed.model.provider, request.failed.model.id);
					}
					// Model access disabled on the account or tool-schema 400: a per-model
					// problem — other models of the same provider may still work, so avoid
					// the model alone. Provider limit: avoid the whole provider, otherwise
					// the failover lands on another of its models and fails again at once.
					const errText = request.failed.message?.errorMessage ?? "";
					const isPerModelRewrite = /429 (?:model access|tool schema)/i.test(errText);
					const avoidEntry =
						kind === "provider-limit" && !isPerModelRewrite
							? request.failed.model.provider
							: failedKey;
					avoid = [...new Set([...avoid, avoidEntry])];
				}
				const tiers = buildTiers(ctx, avoid);
				const ladder: TierName[] =
					avoid.length >= DEGRADE_AFTER_FAILURES
						? ["standard", "eco"]
						: ["strong", "standard", "eco"];
				const chosen =
					ladder
						.map((t) => tiers[t])
						.find((m) => !avoid.includes(modelKey(m)) && !avoid.includes(m.provider)) ??
					tiers.eco;
				const baseThinking = prevState?.thinking ?? request.failed?.thinkingLevel ?? "medium";
				const th = capThinking(baseThinking, userCap);
				const source = prevState?.source;
				return toRoute(pi, ctx, chosen, th, source, {
					modelId: chosen.id,
					providerId: chosen.provider,
					thinking: th,
					avoid,
					source,
				});
			}

			// CONTINUATION (same turn, after tool calls)
			if (request.reason === "continuation" && prevState) {
				const { avoid } = prevState;

				// First successful edit/write of the turn → switch to the eco tier for
				// the rest of the turn (editedThisTurn stays true: toolResults accumulate).
				if (editedThisTurn(request.messages)) {
					const eco = buildTiers(ctx, avoid).eco;
					const th = capThinking("medium", userCap);
					const changed =
						prevState.modelId !== eco.id ||
						prevState.providerId !== eco.provider ||
						prevState.thinking !== th;
					return toRoute(
						pi,
						ctx,
						eco,
						th,
						prevState.source,
						changed
							? {
									...prevState,
									modelId: eco.id,
									providerId: eco.provider,
									thinking: th,
								}
							: undefined,
					);
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
					const m = ctx.modelRegistry.find(prevState.providerId, prevState.modelId);
					if (m) {
						const th = capThinking(prevState.thinking, userCap);
						return toRoute(
							pi,
							ctx,
							m,
							th,
							prevState.source,
							th !== prevState.thinking ? { ...prevState, thinking: th } : undefined,
						);
					}
				}
				// Safety fallback: current model banned/missing → re-route the SAME
				// turn (classifier or local score on the current message, `avoid` kept).
				return await rerouteCurrentTurn(pi, ctx, request, avoid, userCap);
			}

			// NEW TURN (user message): one classifier call, else the local heuristic.
			return await rerouteCurrentTurn(pi, ctx, request, [], userCap);
		},
	});
}
