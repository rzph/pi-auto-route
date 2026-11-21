/**
 * auto-route — modèle virtuel `auto/auto` : routage automatique complet.
 *
 * /model → « auto » :
 * - candidats = modèles chat reasoning payants, credentials valides,
 *   moins les fournisseurs exclus (voir EXCLUDED_PROVIDERS) ;
 * - paliers de capacité au runtime (coût de sortie ≈ proxy) ;
 * - difficulté estimée localement → palier + thinking ;
 * - le thinking choisi dans pi agit comme PLAFOND ;
 * - failover : échec → autre modèle du même palier ; 3 échecs → palier
 *   inférieur. Les erreurs « modèle retiré / indisponible » bannissent
 *   le modèle PERSISTAMMENT (fichier denylist partagé entre sessions) ;
 * - UNE ligne de statut max, discrète ;
 * - une bascule de modèle max par tour (cache de prompt) ;
 * - compaction/résumés → le plus léger.
 *
 * Usage : pi -e ~/.pi/agent/extensions/auto-route.ts puis /model → auto
 */

import type { Message } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRoute,
	ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const EDIT_TOOLS = new Set(["edit", "write"]);

/**
 * Fournisseurs exclus par défaut. opencode-go entraîne sur les requêtes
 * (sauf réglage explicite côté OpenCode) : incompatible avec un usage
 * orienté vie privée.
 */
const EXCLUDED_PROVIDERS = new Set<string>(["opencode-go"]);

/** Fichier des modèles bannis définitivement (retirés, 404, …). */
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

/** Erreur définitive (modèle retiré, indisponible) vs transitoire (timeout…). */
function isPermanentFailure(message: string): boolean {
	return /no longer available|not found|invalid_request_error|does not exist|deprecated|discontinued/i.test(
		message,
	);
}

// ---------- Catalogue dynamique ----------

function candidateModels(ctx: ExtensionContext): Model<never>[] {
	const excluded = new Set([...EXCLUDED_PROVIDERS, ...permanentDenylist]);
	return (ctx.modelRegistry.getAvailable() as Model<never>[]).filter((m) => {
		if (excluded.has(m.provider) || excluded.has(`${m.provider}/${m.id}`)) return false;
		const free =
			/free/i.test(m.name) ||
			/free/i.test(m.id) ||
			(!m.cost || (m.cost.input === 0 && m.cost.output === 0));
		return m.reasoning !== false && !free;
	});
}

function buildTiers(ctx: ExtensionContext, avoid: string[] = []) {
	let pool = candidateModels(ctx).filter((m) => !avoid.includes(`${m.provider}/${m.id}`));
	if (pool.length === 0) pool = candidateModels(ctx);
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

let lastRouted = "—";
function setStatusLine(ctx: ExtensionContext, m: Model<never>, thinking: Thinking): void {
	lastRouted = `${m.provider}/${m.id}`;
	try {
		const dim = ctx.ui.theme?.fg?.bind(ctx.ui.theme) ?? ((_: string, s: string) => s);
		ctx.ui.setStatus("auto", dim("dim", `⚡ ${m.id} · ${thinking}`));
	} catch {
		ctx.ui.setStatus("auto", `${m.id} · ${thinking}`);
	}
}

function toRoute(
	request: Req,
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
	pi.registerVirtualModel<RouteState>({
		provider: "auto",
		id: "auto",
		name: "Auto (routage + thinking + failover)",
		thinkingLevels: ["off", "low", "medium", "high", "xhigh"],
		contextWindow: 200_000,
		maxTokens: 64_000,
		async route(request, ctx) {
			if (request.reason === "direct") {
				return toRoute(request, ctx, buildTiers(ctx).background, "low");
			}

			// ---- RETRY / failover ----
			if (request.reason === "retry" && request.failed) {
				const failedKey = `${request.failed.model.provider}/${request.failed.model.id}`;
				// Échec définitif → bannissement persistant (toutes sessions).
				if (isPermanentFailure(request.failed.message?.errorMessage ?? "")) {
					permanentDenylist.add(failedKey);
					saveDenylist(permanentDenylist);
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
						return toRoute(request, ctx, m, th, { ...state, avoid });
					}
				}
				const any = buildTiers(ctx, avoid).frontier;
				return toRoute(request, ctx, any, state.thinking, { ...state, avoid });
			}

			const state = request.state;

			// Phase implémentation → même modèle, thinking plafonné.
			if (state?.phase === "impl") {
				const m = ctx.modelRegistry.find(state.providerId, state.modelId);
				if (m) {
					const th = capThinking(state.thinking, request.thinkingLevel as Thinking);
					return toRoute(request, ctx, m, th, state);
				}
			}

			// Premier edit/write réussi → bascule implémentation (léger).
			if (editedThisTurn(request.messages)) {
				const eco = buildTiers(ctx, state?.avoid ?? []).eco;
				return toRoute(
					request,
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
			return toRoute(request, ctx, m, th, {
				phase: "start",
				modelId: m.id,
				providerId: m.provider,
				thinking: th,
				avoid: [],
			});
		},
	});
}
