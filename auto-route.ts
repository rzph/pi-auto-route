/**
 * auto-route — modèle virtuel `auto/auto` : routage automatique complet.
 *
 * Sélectionné via /model → « auto » :
 * - candidats = TOUS les modèles chat reasoning payants dont le provider
 *   a des credentials valides (gratuits exclus : quotas/timeout) ;
 * - paliers de capacité bâtis au runtime (coût de sortie comme proxy) ;
 * - difficulté estimée localement → palier + niveau de thinking ;
 * - le thinking sélectionné dans /model agit comme PLAFOND : tu peux
 *   toujours baisser, le routeur ne dépasse jamais ton choix ;
 * - FAILOVER : en cas d'échec (timeout, quota, erreur réseau), la retry
 *   part sur un autre modèle du même palier, puis sur un palier
 *   inférieur si ça récidive — l'échec et son modèle sont exclus ;
 * - le modèle physique courant est affiché dans la barre de statut ;
 * - une bascule de modèle max par tour (cache de prompt préservé) ;
 * - compaction/résumés → le plus léger.
 *
 * Pi-spec (pi.registerVirtualModel, ModelRegistry, ctx.ui.setStatus).
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

const EDIT_TOOLS = new Set(["edit", "write"]);

type Thinking = "off" | "low" | "medium" | "high" | "xhigh";
const THINKING_ORDER: Thinking[] = ["off", "low", "medium", "high", "xhigh"];

interface RouteState {
	phase: "start" | "impl";
	modelId: string;
	providerId: string;
	thinking: Thinking;
	/** provider/id des modèles exclus par échec dans ce tour. */
	avoid: string[];
}

type Req = ModelRouteRequest<RouteState>;

// ---------- Catalogue dynamique ----------

/**
 * Fournisseurs exclus par défaut. opencode-go entraîne sur les requêtes
 * (sauf réglage explicite côté OpenCode) : incompatible avec un usage
 * orienté vie privée. Retire-le de la liste seulement en connaissance de cause.
 */
const EXCLUDED_PROVIDERS = new Set<string>(["opencode-go"]);

function candidateModels(ctx: ExtensionContext): Model<never>[] {
	return (ctx.modelRegistry.getAvailable() as Model<never>[]).filter((m) => {
		if (EXCLUDED_PROVIDERS.has(m.provider)) return false;
		const free =
			/free/i.test(m.name) ||
			/free/i.test(m.id) ||
			(!m.cost || (m.cost.input === 0 && m.cost.output === 0));
		return m.reasoning !== false && !free;
	});
}

function buildTiers(ctx: ExtensionContext, avoid: string[] = []) {
	const pool = candidateModels(ctx).filter(
		(m) => !avoid.includes(`${m.provider}/${m.id}`),
	);
	if (pool.length === 0) {
		// Tout est exclu : on retente sans exclusions plutôt que de mourir.
		return buildTiers(ctx, []);
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

function toRoute(
	request: Req,
	ctx: ExtensionContext,
	m: Model<never>,
	thinking: Thinking,
	state?: RouteState,
): ModelRoute<RouteState> {
	lastRouted = `${m.provider}/${m.id}`;
	ctx.ui.setStatus(
		"auto-route",
		`auto → ${m.provider}/${m.id} · thinking ${thinking}`,
	);
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

/** thinking automatique, plafonné par le choix explicite de l'utilisateur. */
function capThinking(auto: Thinking, userSelected: Thinking): Thinking {
	const autoIdx = THINKING_ORDER.indexOf(auto);
	const userIdx = THINKING_ORDER.indexOf(userSelected);
	return THINKING_ORDER[Math.min(autoIdx, userIdx)];
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

function key(m: Model<never>): string {
	return `${m.provider}/${m.id}`;
}

// ---------- Capteur de quota (en-têtes de réponse) ----------

const QUOTA_RE = /limit|ratelimit|rate-limit|remaining|reset|quota|budget|usage/i;
let lastRouted = "?";
let headersLogged = false;

function captureHeaders(pi: ExtensionAPI) {
	pi.on("after_provider_response", (event, ctx) => {
		// Premier batch : tout logguer pour découvrir ce que le fournisseur expose.
		if (!headersLogged) {
			headersLogged = true;
			try {
				// eslint-disable-next-line no-console
				console.error(
					`[auto-route] headers de ${lastRouted} (status ${event.status}) :\n` +
						Object.entries(event.headers)
							.map(([k, v]) => `  ${k}: ${v}`)
							.join("\n"),
				);
			} catch {
				// stderr peut être indisponible selon le mode d'exécution.
			}
		}
		const quota = Object.entries(event.headers).filter(([k]) => QUOTA_RE.test(k));
		if (quota.length > 0) {
			ctx.ui.setStatus(
				"auto-route-quota",
				quota.map(([k, v]) => `${k.replace(/^x-/i, "")}=${v}`).join(" · "),
			);
		}
	});
}

// Adaptateur : garde les appels courts au fil des routes.
function R(
	request: Req,
	ctx: ExtensionContext,
	m: Model<never>,
	thinking: Thinking,
	state?: RouteState,
): ModelRoute<RouteState> {
	return toRoute(request, ctx, m, thinking, state);
}

export default function (pi: ExtensionAPI) {
	captureHeaders(pi);
	pi.registerVirtualModel<RouteState>({
		provider: "auto",
		id: "auto",
		name: "Auto (routage + thinking + failover)",
		thinkingLevels: ["off", "low", "medium", "high", "xhigh"],
		contextWindow: 200_000,
		maxTokens: 64_000,
		async route(request, ctx) {
			// Appels hors boucle (compaction, résumés) → le plus léger.
			if (request.reason === "direct") {
				return R(request, ctx, buildTiers(ctx).background, "low");
			}

			// ---- RETRY : failover ----
			if (request.reason === "retry" && request.failed) {
				const failedKey = `${request.failed.model.provider}/${request.failed.model.id}`;
				const state: RouteState = request.state ?? {
					phase: "start",
					modelId: request.failed.model.id,
					providerId: request.failed.model.provider,
					thinking: (request.failed.thinkingLevel ?? "medium") as Thinking,
					avoid: [],
				};
				const avoid = [...new Set([...state.avoid, failedKey])];
				// Stratégie : d'abord un autre modèle du même palier ; si le
				// palier devient vide, buildTiers retombera sur un autre choix
				// (pool filtré). Si on accumule 3+ échecs, on repart d'un
				// palier plus léger pour garantir une réponse.
				const tiers = buildTiers(ctx, avoid);
				const candidates: Array<[keyof typeof tiers, Thinking]> =
					avoid.length >= 3
						? [["standard", state.thinking], ["eco", state.thinking]]
						: [["strong", state.thinking], ["standard", state.thinking], ["eco", state.thinking]];
				for (const [tier, th] of candidates) {
					const m = tiers[tier];
					if (m && !avoid.includes(key(m))) {
						return R(request, ctx, m, th, { ...state, avoid });
					}
				}
				// Dernier recours : le meilleur candidat restant, quel qu'il soit.
				const any = buildTiers(ctx, avoid).frontier;
				return R(request, ctx, any, state.thinking, { ...state, avoid });
			}

			const state = request.state;

			// Déjà en phase implémentation → reste sur le même modèle.
			if (state?.phase === "impl") {
				const m = ctx.modelRegistry.find(state.providerId, state.modelId);
				if (m) {
					const th = capThinking(state.thinking, request.thinkingLevel as Thinking);
					return R(request, ctx, m, th, state);
				}
			}

			// Premier edit/write réussi du tour → bascule implémentation.
			if (editedThisTurn(request.messages)) {
				const eco = buildTiers(ctx).eco;
				return R(request, ctx, eco, capThinking("medium", request.thinkingLevel as Thinking), {
					phase: "impl",
					modelId: eco.id,
					providerId: eco.provider,
					thinking: "medium",
					avoid: state?.avoid ?? [],
				});
			}

			// Nouveau tour → difficulté → palier + thinking (plafonné).
			const score = difficultyScore(lastUserText(request.messages));
			const tier = tierFor(score);
			const autoTh: Thinking = score >= 0.7 ? "xhigh" : score >= 0.45 ? "high" : score >= 0.25 ? "medium" : "low";
			const th = capThinking(autoTh, request.thinkingLevel as Thinking);
			const m = buildTiers(ctx, state?.avoid ?? [])[tier];
			return R(request, ctx, m, th, {
				phase: "start",
				modelId: m.id,
				providerId: m.provider,
				thinking: th,
				avoid: [],
			});
		},
	});
}
