/**
 * auto-route — modèle virtuel `auto/auto` : routage automatique complet.
 *
 * Sélectionné via /model → « auto ». Alors :
 * - les candidats = TOUS les modèles chat raisonnables de TON catalogue
 *   dont le provider a des credentials valides. Sont exclus :
 *   les modèles gratuits (noms contenant « free », coût nul) et les
 *   modèles non-reasoning — comme demandé : pas de timeouts, pas de
 *   perte de performance.
 * - le routeur classe le catalogue par capacité (coût de sortie comme
 *   proxy) et choisit le palier + le niveau de thinking selon la
 *   difficulté estimée de la tâche (heuristique locale, 0 classe
 *   externe).
 * - un tour = au plus UNE bascule de modèle (après le premier
 *   edit/write réussi) pour préserver le cache de prompt.
 * - la compaction/résumés partent sur le modèle le plus léger.
 *
 * Usage : pi -e ~/.pi/agent/extensions/auto-route.ts
 *         puis /model → auto
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

interface RouteState {
	phase: "start" | "impl";
	modelId: string;
	providerId: string;
	thinking: ModelThinkingLevel;
}

type Req = ModelRouteRequest<RouteState>;
type ModelThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh";

// ---------- Catalogue dynamique ----------

/** Filtre les modèles candidats : chat, reasoning, non gratuits, auth OK. */
function candidateModels(ctx: ExtensionContext): Model<never>[] {
	return (ctx.modelRegistry.getAvailable() as Model<never>[]).filter((m) => {
		const free =
			/free/i.test(m.name) ||
			/free/i.test(m.id) ||
			(!m.cost || (m.cost.input === 0 && m.cost.output === 0));
		return m.reasoning !== false && !free;
	});
}

/**
 * Classe les candidats par capacité, découpe en 4 paliers et renvoie un
 * accès palier → modèle. Coût de sortie ≈ proxy de capacité ; à coût
 * proche, le plus grand contextWindow gagne.
 */
function buildTiers(ctx: ExtensionContext) {
	const sorted = [...candidateModels(ctx)].sort((a, b) => {
		const ca = a.cost?.output ?? 0;
		const cb = b.cost?.output ?? 0;
		if (Math.abs(ca - cb) < 0.01) return (b.contextWindow ?? 0) - (a.contextWindow ?? 0);
		return cb - ca;
	});
	if (sorted.length === 0) throw new Error("auto-route : aucun modèle candidat (auth ?)");
	const at = (frac: number): Model<never> => sorted[Math.min(sorted.length - 1, Math.floor(frac * sorted.length))];
	return {
		frontier: at(0),      // le plus cher = le plus capable
		strong: at(0.33),
		standard: at(0.66),
		eco: sorted[sorted.length - 1], // le moins cher qui passe le filtre
		background: sorted[sorted.length - 1],
	} as const;
}

function toRoute(
	request: Req,
	m: Model<never>,
	thinking: ModelThinkingLevel,
	state?: RouteState,
): ModelRoute<RouteState> {
	return {
		model: m,
		thinkingLevel: thinking,
		state: state ?? { phase: "start", modelId: m.id, providerId: m.provider, thinking },
	};
}

// ---------- Heuristique de difficulté (score continu 0..1) ----------

function difficultyScore(text: string): number {
	const t = text.trim();
	let score = 0.15; // une demande simple a une base non nulle
	if (t.length < 120 && !/[;{}`]|def |const |class /.test(t)) return 0.1;
	const kw = t.match(
		/\b(architecture|conception|refactor|d[ée]bogu|debug|optimis|s[ée]curit|timing|algorithme|compar|pourquoi|analyse|syst[èe]me|protocole)\b/gi,
	);
	score += Math.min(0.4, (kw?.length ?? 0) * 0.1); // jusqu'à 4 mots-clés
	if (t.length > 800) score += 0.15;
	if (t.length > 2000) score += 0.15;
	if (/```/.test(t)) score += 0.15; // du code dans la demande
	if (/\b(pas le m[êe]me|r[ée]gression|cass[ée]|fuit|bloqu[ée]|corriger)\b/i.test(t)) score += 0.1;
	return Math.min(1, score);
}

function tierAndThinking(score: number): { tier: string; thinking: ModelThinkingLevel } {
	if (score >= 0.7) return { tier: "frontier", thinking: "xhigh" };
	if (score >= 0.45) return { tier: "strong", thinking: "high" };
	if (score >= 0.25) return { tier: "standard", thinking: "medium" };
	return { tier: "eco", thinking: "low" };
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
		name: "Auto (routage + thinking auto)",
		thinkingLevels: ["off", "low", "medium", "high", "xhigh"],
		contextWindow: 200_000,
		maxTokens: 64_000,
		async route(request, ctx) {
			// Appels hors boucle (compaction, résumés) → le plus léger.
			if (request.reason === "direct") {
				return toRoute(request, buildTiers(ctx).background, "low");
			}

			const state = request.state;

			// Déjà en phase implémentation → reste sur le modèle éco, thinking conservé.
			if (state?.phase === "impl") {
				const m = ctx.modelRegistry.find(state.providerId, state.modelId);
				if (m) return { model: m, thinkingLevel: state.thinking, state };
			}

			// Premier edit/write réussi du tour → bascule implémentation.
			if (editedThisTurn(request.messages)) {
				const tiers = buildTiers(ctx);
				return toRoute(request, tiers.eco, "medium", {
					phase: "impl",
					modelId: tiers.eco.id,
					providerId: tiers.eco.provider,
					thinking: "medium",
				});
			}

			// Nouveau tour (ou session neuve) → difficulté → palier + thinking.
			const score = difficultyScore(lastUserText(request.messages));
			const { tier, thinking } = tierAndThinking(score);
			const m = buildTiers(ctx)[tier as keyof ReturnType<typeof buildTiers>];
			return toRoute(request, m, thinking, {
				phase: "start",
				modelId: m.id,
				providerId: m.provider,
				thinking,
			});
		},
	});
}
