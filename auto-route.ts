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
 *   les 4xx autres que 429) ; les 429 « quota fournisseur » que pi juge
 *   non-retryables sont réécrits en erreurs429 retryables pour déclencher
 *   ce même failover (cross-provider) au lieu de faire échouer le tour ;
 * - sélectionner `auto` part en thinking `low` par défaut (plafond modifiable
 *   ensuite via shift+tab) ;
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

/**
 * 429 « limite de quota fournisseur » (abonnement/quota consommé). Motifs d'origine
 * (classe que pi marque NON-retryable : retryer le même fournisseur est inutile pour
 * lui) + le marqueur réécrit par `toFailoverRetryMessage` — source unique de vérité
 * pour la détection, que ce soit dans `message_end` ou dans `route(reason: "retry")`.
 */
const PROVIDER_LIMIT_RE =
	/gousagelimiterror|freeusagelimiterror|monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing|subscription_sharing|resource_exhausted|exceeded your current quota|429 quota fournisseur/i;

/**
 * Convertit une erreur de quota fournisseur en erreur « 429 » que pi accepte de retry.
 * Pi laisse tomber ces erreurs (inutile sur le même fournisseur) ; sous auto-route le
 * failover change de fournisseur, donc le retry devient utile : pi rappelle alors
 * `route(reason: "retry")` et le routeur bascule. Le texte réécrit contient le motif
 * retryable « 429 » de pi et évite ses motifs non-retryables (billing, quota
 * exceeded…) ; c'est aussi un marqueur lisible dans la transcription.
 * Retourne undefined quand il n'y a rien à réécrire.
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
		errorMessage: `auto-route: 429 quota fournisseur — ${msg.provider}/${msg.model} en limite ; nouvelle tentative sur un autre modèle`,
	};
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
	// `avoid` accepte des clés `provider/id` (modèle) ou `provider` seul (fournisseur
	// entier, quota épuisé : tous ses modèles échoueraient pareil).
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
//
// Calibrée le 2026-11-21 sur 880 tours réels extraits de ~/.pi/agent/sessions/*.jsonl.
// Mesures avant/après (script d'analyse, proxy de difficulté réelle = rang combiné
// du nombre d'outils et des tokens de sortie du tour) :
// - corrélation de Spearman score↔nombre d'outils : v1 +0.16 → v2 +0.28 ;
// - messages du quartile le plus lourds envoyés en palier eco :
//     v1 195/220 → v2 72/220 ;
// - distribution : v1 = 92 % des messages en {0.10, 0.15} → v2 étalée sur 8+ valeurs.
// Chaque signal est indépendant et interprétable ; aucun entraînement, aucune donnée
// envoyée : la règle reste écrite à la main, les chiffres servent seulement à la vérifier.

/** Référence à un chemin, un fichier ou un dépôt → travail sur un codebase existant. */
const PATHY =
	/(?:\/(?:home|data|tmp|etc|usr|opt|var|srv)\/|~\/|\b[\w.+-]+\/[\w.-]+\.[A-Za-z0-9]{1,6}\b|\b[\w.+-]+\/[\w-]*-[\w-]+\b)/;
/** Verbes de construction / modification / analyse → l'agent va faire du travail. */
const ACTION =
	/\b(reprend\w*|construi\w*|impl[ée]ment\w*|cré[ée]r?|cree\w*|g[ée]n[èe]r\w*|d[ée]velop\w*|migre\w*|refais|refaire|transforme\w*|modifi\w*|ajout\w*|supprim\w*|corrige\w*|corrig\w*|install\w*|configure\w*|[ée]crase\w*|r[ée]pare\w*|optimise\w*|nettoie\w*|remplace\w*|relance\w*|trouve\w*|cherch\w*|analy\w*|examin\w*|v[ée]rifi\w*|test\w*)\b/i;
/** Intention explicite du demande. */
const WANT = /\b(je veux|fais en sorte|fais[- ]moi|il faut|on pourrait|peux[- ]tu|besoin de)\b/i;
/** Question conceptuelle → demande d'explication de bon niveau. */
const QUESTION =
	/\b(pourquoi|explique\w*|c'est quoi|c est quoi|comment (?:ça|ca) marche|diff[ée]rence entre|quelle est|quel est|est[- ]ce que)\b/i;
/** Mots-clés concepts, comptés (jusqu'à 3). */
const CONCEPTS =
	/\b(architecture|conception|refactor|d[ée]bogu|debug|optimis|s[ée]curit|timing|algorithme|compar|pourquoi|analyse|syst[èe]me|protocole)\b/gi;
/** Déclaration de panne / régression explicite. */
const REGRESSION = /\b(pas le m[êe]me|r[ée]gression|cass[ée]|fuit|bloqu[ée]|corriger)\b/i;
/** Ligne de prompt shell (copier-coller de terminal : forme, pas difficulté). */
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
	// Copier-coller de terminal (≥3 lignes de prompt shell) : forme, pas difficulté.
	if ((t.match(SHELLLINE) ?? []).length >= 3) sig -= 0.15;
	// Base 0.10 : relance courte et message neutre → palier le plus léger.
	return Math.round(Math.min(1, 0.1 + Math.max(0, sig)) * 100) / 100;
}

export function tierAndThinking(score: number): { tier: TierName; thinking: Thinking } {
	// Seuils calibrés sur les 880 tours réels (table score → quartile de difficulté
	// réelle : 0.10-0.20 ≈ quartile 1, 0.30-0.45 ≈ quartile 2, ≥0.55 ≈ quartile 3).
	if (score >= 0.7) return { tier: "frontier", thinking: "xhigh" };
	if (score >= 0.5) return { tier: "strong", thinking: "high" };
	if (score >= 0.3) return { tier: "standard", thinking: "medium" };
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

/**
 * Point d'entrée commun au nouveau tour et au repli de secours d'une continuation
 * (modèle courant banni/introuvable) : difficulté du message courant → palier.
 * `avoid` vide pour un nouveau tour, conservé pour un re-routage de secours.
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
	// Pi ne déclenche PAS `route(reason: "retry")` sur les erreurs 400/404 ni sur les
	// 429 de quota fournisseur (classes non-retryables). On écoute `message_end` pour :
	// 1. bannir définitivement les modèles en erreur définitive (400/404/410…) ;
	// 2. réécrire les 429 de quota en erreur retryable, pour que pi déclenche son
	//    retry → route(reason: "retry") → failover cross-provider au lieu du plantage.
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

	// Sélectionner `auto` part en thinking `low` par défaut (plafond modifiable via
	// shift+tab). `model_select` ne se déclenche que sur une sélection utilisateur :
	// pi ne l'émet ni au démarrage ni à la restauration de session.
	pi.on("model_select", (event) => {
		if (event.model.provider === "auto" && event.model.id === "auto") {
			pi.setThinkingLevel("low");
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
					modelId: request.failed.model.id,
					providerId: request.failed.model.provider,
					thinking: (request.failed.thinkingLevel ?? "medium") as Thinking,
					avoid: [],
				};
				const avoid = [
					...new Set([
						...baseState.avoid,
						// Quota fournisseur : on évite tout le fournisseur, sinon le failover
						// retombe sur un autre de ses modèles et re-échoue immédiatement.
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

			// ---- CONTINUATION (suite du même tour après appels d'outils) ----
			if (request.reason === "continuation" && prevState) {
				const avoid = prevState.avoid ?? [];

				// Premier edit/write réussi du tour → bascule sur le palier eco jusqu'à la fin
				// du tour (editedThisTurn reste vrai : les toolResult s'accumulent).
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

				// Pas d'edit → on garde le modèle courant pour préserver le cache de prompt
				// et la liste `avoid` ; s'il a été banni entre-temps, repli de secours ci-dessous.
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
				// Repli de secours : modèle courant banni/introuvable → re-routage du MÊME tour
				// (difficultyScore sur le message courant, `avoid` conservé).
				return rerouteCurrentTurn(pi, ctx, request, prevState.avoid, userCap, prevState);
			}

			// ---- NOUVEAU TOUR (message utilisateur) ----
			return rerouteCurrentTurn(pi, ctx, request, [], userCap, prevState);
		},
	});
}
