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

/**
 * Motifs d'ID/nom exclus d'office :
 * - `free` : quotas serrés / timeouts constants ;
 * - `contributor` : endpoints OpenCode qui entraînent sur tes requêtes ;
 * - `gemini-2.5-` : retirés par Google pour les nouveaux comptes (404) ;
 * - `mimo-v2.5` : déprécié sur OpenCode Go (410 ModelDeprecated) ;
 * - `computer-use` / `robotics` / `deep-research` : modèles spécialisés non-code.
 */
const EXCLUDED_MODEL_RE =
	/free|contributor|gemini-2\.5-|mimo-v2\.5\b|computer-use|robotics|deep-research/i;

/** Fichier des modèles bannis définitivement (400/404/410 découverts au vol). */
const DENYLIST_FILE = `${process.env.HOME ?? ""}/.pi/agent/auto-route-denylist.json`;

type Thinking = "off" | "low" | "medium" | "high" | "xhigh";
type TierName = "frontier" | "strong" | "standard" | "eco";
const THINKING_ORDER: Thinking[] = ["off", "low", "medium", "high", "xhigh"];

interface RouteState {
	phase: "start" | "impl";
	modelId: string;
	providerId: string;
	thinking: Thinking;
	/** provider/id exclus pour CE tour (échecs transitoires). */
	avoid: string[];
}

function modelKey(m: { provider: string; id: string }): string {
	return `${m.provider}/${m.id}`;
}

function sameState(a: RouteState | undefined, b: RouteState): boolean {
	if (!a) return false;
	return (
		a.phase === b.phase &&
		a.modelId === b.modelId &&
		a.providerId === b.providerId &&
		a.thinking === b.thinking &&
		a.avoid.length === b.avoid.length &&
		a.avoid.every((v, i) => v === b.avoid[i])
	);
}

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
	const k = modelKey({ provider, id: modelId });
	if (!permanentDenylist.has(k)) {
		permanentDenylist.add(k);
		saveDenylist(permanentDenylist);
	}
}

/** Erreur définitive (modèle retiré, 404/410, refuse sans training, région non autorisée…). */
function isPermanentFailure(message: string): boolean {
	return /no longer available|not found|\b404\b|\b410\b|ModelDeprecated|deprecated|discontinued|trains on request data|hosted outside Europe|requires Global regions|does not exist|no API implementation|unsupported/i.test(
		message,
	);
}

// ---------- Catalogue dynamique ----------

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
		throw new Error("auto-route : aucun modèle candidat disponible (vérifie tes clés API)");
	}
	const avoidSet = new Set(avoid);
	const filtered = allCandidates.filter((m) => !avoidSet.has(modelKey(m)));
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

// ---------- Statut (une seule ligne, discrète) ----------

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
	// Ne retourner un nouvel objet state que lorsqu'il change réellement (évite d'écrire
	// une entrée dans l'arbre de session Pi à chaque requête de continuation).
	const stateToStore =
		nextState && !sameState(prevState, nextState) ? nextState : undefined;
	return {
		model: m,
		thinkingLevel: thinking,
		state: stateToStore,
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

function tierAndThinking(score: number): { tier: TierName; thinking: Thinking } {
	if (score >= 0.7) return { tier: "frontier", thinking: "xhigh" };
	if (score >= 0.45) return { tier: "strong", thinking: "high" };
	if (score >= 0.25) return { tier: "standard", thinking: "medium" };
	return { tier: "eco", thinking: "low" };
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
			const userCap = (request.thinkingLevel ?? "xhigh") as Thinking;

			// Compaction / résumés hors boucle agent : pas d'état de session.
			if (request.reason === "direct") {
				return {
					model: buildTiers(ctx).background,
					thinkingLevel: "low",
				};
			}

			const prevState = request.state;

			// ---- RETRY / failover (429 / 5xx) ----
			if (request.reason === "retry" && request.failed) {
				const failedKey = modelKey(request.failed.model);
				if (isPermanentFailure(request.failed.message?.errorMessage ?? "")) {
					banPermanently(request.failed.model.provider, request.failed.model.id);
				}
				const baseState: RouteState = prevState ?? {
					phase: "start",
					modelId: request.failed.model.id,
					providerId: request.failed.model.provider,
					thinking: (request.failed.thinkingLevel ?? "medium") as Thinking,
					avoid: [],
				};
				const avoid = [...new Set([...baseState.avoid, failedKey])];
				const tiers = buildTiers(ctx, avoid);
				const ladder: TierName[] =
					avoid.length >= 3 ? ["standard", "eco"] : ["strong", "standard", "eco"];
				const chosen =
					ladder.map((t) => tiers[t]).find((m) => m && !avoid.includes(modelKey(m))) ??
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

			// ---- CONTINUATION (suite du même tour après appels d'outils) ----
			if (request.reason === "continuation" && prevState) {
				const avoid = prevState.avoid ?? [];

				// Premier edit/write réussi au cours de ce tour → bascule unique en phase "impl" (eco).
				if (prevState.phase !== "impl" && editedThisTurn(request.messages)) {
					const eco = buildTiers(ctx, avoid).eco;
					const th = capThinking("medium", userCap);
					return toRoute(pi, ctx, eco, th, prevState, {
						phase: "impl",
						modelId: eco.id,
						providerId: eco.provider,
						thinking: th,
						avoid,
					});
				}

				// Sinon (phase "start" après read/bash, ou déjà en phase "impl"),
				// on conserve le même modèle pour préserver le cache de prompt et la liste `avoid`.
				const currentKey = modelKey({ provider: prevState.providerId, id: prevState.modelId });
				if (!permanentDenylist.has(currentKey) && !avoid.includes(currentKey)) {
					const m = ctx.modelRegistry.find(prevState.providerId, prevState.modelId) as
						| Model<never>
						| undefined;
					if (m) {
						const th = capThinking(prevState.thinking, userCap);
						return toRoute(pi, ctx, m, th, prevState, { ...prevState, thinking: th });
					}
				}
			}

			// ---- NOUVEAU TOUR (`reason === "user"`, ou repli si modèle banni) ----
			// Si on vient d'un `continuation` dont le modèle a été banni, on garde `avoid` du tour ;
			// pour un nouveau message utilisateur (`reason === "user"`), on repart avec `avoid: []`.
			const avoid = request.reason === "user" ? [] : (prevState?.avoid ?? []);
			const score = difficultyScore(lastUserText(request.messages));
			const { tier, thinking: autoTh } = tierAndThinking(score);
			const th = capThinking(autoTh, userCap);
			const m = buildTiers(ctx, avoid)[tier];
			return toRoute(pi, ctx, m, th, prevState, {
				phase: "start",
				modelId: m.id,
				providerId: m.provider,
				thinking: th,
				avoid,
			});
		},
	});
}
