/**
 * auto-route — modèle virtuel `auto/auto` : routage automatique complet.
 *
 * /model → « auto » :
 * - candidats = modèles chat reasoning payants, credentials valides,
 *   hors modèles gratuits (`free`), modèles d'entraînement (`contributor`),
 *   et générations retirées (`gemini-2.5-*`) ;
 * - paliers de capacité construits au runtime (coût de sortie ≈ proxy) ;
 * - difficulté estimée localement → palier + thinking ;
 * - le thinking choisi dans pi (`shift+tab`) agit comme PLAFOND ;
 * - failover sur retry (429/5xx) + écoute de `message_end` pour bannir
 *   PERSISTAMMENT les modèles qui renvoient 400/404 (car pi ne retry pas
 *   les 4xx autres que 429) ;
 * - UNE ligne de statut discrète (`⚡ modèle · thinking`) ;
 * - une bascule de modèle max par tour (cache de prompt préservé) ;
 * - compaction/résumés → le plus léger.
 *
 * Usage : pi -e ~/.pi/agent/extensions/auto-route.ts puis /model → auto
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

/** Fournisseurs exclus en bloc (aucun par défaut). */
const EXCLUDED_PROVIDERS = new Set<string>([]);

/**
 * Motifs d'ID/nom exclus d'office :
 * - `free` : quotas serrés / timeouts constants ;
 * - `contributor` : endpoints OpenCode qui entraînent sur tes requêtes ;
 * - `gemini-2.5-` : retirés par Google pour les nouveaux comptes (404) ;
 * - `computer-use` / `robotics` / `deep-research` : modèles spécialisés non-code.
 */
const EXCLUDED_MODEL_RE = /free|contributor|^gemini-2\.5-|computer-use|robotics|deep-research/i;

/** Fichier des modèles bannis définitivement (400/404 découverts au vol). */
const DENYLIST_FILE = `${process.env.HOME ?? ""}/.pi/agent/auto-route-denylist.json`;

type Thinking = "off" | "low" | "medium" | "high" | "xhigh";
const THINKING_ORDER: Thinking[] = ["off", "low", "medium", "high", "xhigh"];

interface RouteState {
	phase: "start" | "impl";
	modelId: string;
	providerId: string;
	thinking: Thinking;
	/** provider/id exclus pour CE tour (échecs transitoires). */
	avoid: string[];
}

type Req = ModelRouteRequest<RouteState>;

// ---------- Denylist persistante ----------

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
	const k = `${provider}/${modelId}`;
	if (!permanentDenylist.has(k)) {
		permanentDenylist.add(k);
		saveDenylist(permanentDenylist);
	}
}

/** Erreur définitive (modèle retiré, 404, refuse sans training, …). */
function isPermanentFailure(message: string): boolean {
	return /no longer available|not found|404|trains on request data|invalid_request_error|does not exist|deprecated|discontinued|unsupported/i.test(
		message,
	);
}

// ---------- Catalogue dynamique ----------

function candidateModels(ctx: ExtensionContext): Model<never>[] {
	const excluded = new Set([...EXCLUDED_PROVIDERS, ...permanentDenylist]);
	return (ctx.modelRegistry.getAvailable() as Model<never>[]).filter((m) => {
		if (excluded.has(m.provider) || excluded.has(`${m.provider}/${m.id}`)) return false;
		if (EXCLUDED_MODEL_RE.test(m.id) || EXCLUDED_MODEL_RE.test(m.name)) return false;
		const zeroCost = !m.cost || (m.cost.input === 0 && m.cost.output === 0);
		return m.reasoning !== false && !zeroCost;
	});
}

function buildTiers(ctx: ExtensionContext, avoid: string[] = []) {
	let pool = candidateModels(ctx).filter((m) => !avoid.includes(`${m.provider}/${m.id}`));
	if (pool.length === 0) pool = candidateModels(ctx);
	if (pool.length === 0) {
		throw new Error("auto-route : aucun modèle candidat disponible (vérifie tes clés API)");
	}
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

// ---------- Statut (une seule ligne, discrète) ----------

function setStatusLine(ctx: ExtensionContext, m: Model<never>, thinking: Thinking): void {
	try {
		const dim = ctx.ui.theme?.fg?.bind(ctx.ui.theme) ?? ((_: string, s: string) => s);
		ctx.ui.setStatus("auto", dim("dim", `⚡ ${m.provider}/${m.id} · ${thinking}`));
	} catch {
		ctx.ui.setStatus("auto", `${m.provider}/${m.id} · ${thinking}`);
	}
}

function toRoute(
	ctx: ExtensionContext,
	m: Model<never>,
	thinking: Thinking,
	state?: RouteState,
): ModelRoute<RouteState> {
	setStatusLine(ctx, m, thinking);
	return {
		model: m,
		thinkingLevel: thinking,
		state:
			state ?? {
				phase: "start",
				modelId: m.id,
				providerId: m.provider,
				thinking,
				avoid: [],
			},
	};
}

// ---------- Heuristique de difficulté ----------

function difficultyScore(text: string): number {
	const t = text.trim();
	if (t.length < 120 && !/[;{}`]|def |const |class /.test(t)) return 0.1;
	let score = 0.15;
	const kw = t.match(
		/\b(architecture|conception|refactor|d[ée]bogu|debug|optimis|s[ée]curit|timing|algorithme|compar|pourquoi|analyse|syst[èe]me|protocole)\b/gi,
	);
	score += Math.min(0.4, (kw?.length ?? 0) * 0.1);
	if (t.length > 800) score += 0.15;
	if (t.length > 2000) score += 0.15;
	if (/```/.test(t)) score += 0.15;
	if (/\b(pas le m[êe]me|r[ée]gression|cass[ée]|fuit|bloqu[ée]|corriger)\b/i.test(t)) score += 0.1;
	return Math.min(1, score);
}

function tierFor(score: number): "frontier" | "strong" | "standard" | "eco" {
	if (score >= 0.7) return "frontier";
	if (score >= 0.45) return "strong";
	if (score >= 0.25) return "standard";
	return "eco";
}

function capThinking(auto: Thinking, userSelected: Thinking): Thinking {
	return THINKING_ORDER[Math.min(THINKING_ORDER.indexOf(auto), THINKING_ORDER.indexOf(userSelected))];
}

// ---------- Utilitaires ----------

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

export default function (pi: ExtensionAPI) {
	// Pi ne déclenche PAS `route(reason: "retry")` sur les erreurs 400/404.
	// On écoute donc `message_end` pour bannir définitivement le modèle fautif
	// dès qu'une telle erreur survient.
	pi.on("message_end", (event) => {
		const msg = event.message as AssistantMessage;
		if (msg?.role === "assistant" && msg.stopReason === "error" && msg.errorMessage) {
			if (isPermanentFailure(msg.errorMessage) && msg.provider && msg.model) {
				banPermanently(msg.provider, msg.model);
			}
		}
	});

	pi.registerVirtualModel<RouteState>({
		provider: "auto",
		id: "auto",
		name: "Auto (routage + thinking + failover)",
		thinkingLevels: ["off", "low", "medium", "high", "xhigh"],
		contextWindow: 200_000,
		maxTokens: 64_000,
		async route(request, ctx) {
			if (request.reason === "direct") {
				return toRoute(ctx, buildTiers(ctx).background, "low");
			}

			// ---- RETRY / failover (429 / 5xx) ----
			if (request.reason === "retry" && request.failed) {
				const failedKey = `${request.failed.model.provider}/${request.failed.model.id}`;
				if (isPermanentFailure(request.failed.message?.errorMessage ?? "")) {
					banPermanently(request.failed.model.provider, request.failed.model.id);
				}
				const state: RouteState = request.state ?? {
					phase: "start",
					modelId: request.failed.model.id,
					providerId: request.failed.model.provider,
					thinking: (request.failed.thinkingLevel ?? "medium") as Thinking,
					avoid: [],
				};
				const avoid = [...new Set([...state.avoid, failedKey])];
				const tiers = buildTiers(ctx, avoid);
				const ladder: Array<["frontier" | "strong" | "standard" | "eco", Thinking]> =
					avoid.length >= 3
						? [["standard", state.thinking], ["eco", state.thinking]]
						: [["strong", state.thinking], ["standard", state.thinking], ["eco", state.thinking]];
				for (const [tier, th] of ladder) {
					const m = tiers[tier];
					if (m && !avoid.includes(`${m.provider}/${m.id}`)) {
						return toRoute(ctx, m, th, { ...state, avoid });
					}
				}
				const any = buildTiers(ctx, avoid).frontier;
				return toRoute(ctx, any, state.thinking, { ...state, avoid });
			}

			const state = request.state;

			// Phase implémentation → même modèle (sauf s'il a été banni entre-temps).
			if (state?.phase === "impl" && !permanentDenylist.has(`${state.providerId}/${state.modelId}`)) {
				const m = ctx.modelRegistry.find(state.providerId, state.modelId);
				if (m) {
					const th = capThinking(state.thinking, request.thinkingLevel as Thinking);
					return toRoute(ctx, m, th, state);
				}
			}

			// Premier edit/write réussi → bascule implémentation (léger).
			if (editedThisTurn(request.messages)) {
				const eco = buildTiers(ctx, state?.avoid ?? []).eco;
				return toRoute(
					ctx,
					eco,
					capThinking("medium", request.thinkingLevel as Thinking),
					{
						phase: "impl",
						modelId: eco.id,
						providerId: eco.provider,
						thinking: "medium",
						avoid: state?.avoid ?? [],
					},
				);
			}

			// Nouveau tour → difficulté → palier + thinking (plafonné).
			const score = difficultyScore(lastUserText(request.messages));
			const tier = tierFor(score);
			const autoTh: Thinking =
				score >= 0.7 ? "xhigh" : score >= 0.45 ? "high" : score >= 0.25 ? "medium" : "low";
			const th = capThinking(autoTh, request.thinkingLevel as Thinking);
			const m = buildTiers(ctx, state?.avoid ?? [])[tier];
			return toRoute(ctx, m, th, {
				phase: "start",
				modelId: m.id,
				providerId: m.provider,
				thinking: th,
				avoid: [],
			});
		},
	});
}
