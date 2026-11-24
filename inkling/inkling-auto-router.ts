/**
 * inkling-auto-router — routes short, tool-free prompts to a local llama.cpp
 * server (Inkling 2 Mini, a 6144-token slot), then hands the session back to the
 * previous model.
 *
 * Companion to auto-route: auto-route chooses the right cloud model per turn;
 * this extension takes the trivial prompts off the cloud entirely. It stays out
 * of `pi.extensions` on purpose — without the local server it would do nothing
 * but warn. Setup: see inkling/README.md.
 *
 * Invariant: while Inkling is the current model, the tools are stripped (pi's
 * tool prompt is ~8.5k tokens and does not fit) and a restore point holds the
 * model and tool set to go back to. Both sides live in one place, the
 * `model_select` handler, which fires for manual picks and for pi.setModel()
 * alike. The tool set the session started with is the safety net for a session
 * restored directly on Inkling, where pi emits no model_select.
 *
 * The window is deliberately not the model's own limit: pi reserves
 * max(4096, 15 % of the input) tokens of output headroom, so a too small
 * `contextWindow` in models.json yields `max_completion_tokens: 1` and an
 * silently empty answer. See inkling/README.md.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// --- Configuration (env-overridable) ---------------------------------------

const PORT = Number(process.env.INKLING_PORT ?? 8080);
const SERVER_URL = `http://127.0.0.1:${PORT}`;
const PROVIDER = process.env.INKLING_PROVIDER ?? "inkling-local";
const MODEL_ID = process.env.INKLING_MODEL_ID ?? "inkling-2-mini-iq1m";
const START_SCRIPT = process.env.INKLING_START_SCRIPT ?? "/data/llm/scripts/start-inkling-server.sh";
const STOP_SCRIPT = process.env.INKLING_STOP_SCRIPT ?? "/data/llm/scripts/stop-inkling-server.sh";
const READY_TIMEOUT_MS = Number(process.env.INKLING_READY_TIMEOUT_MS ?? 180_000); // ~1-2 min here
const POLL_MS = 2_000;

// --- Prompt classification ---------------------------------------------------

/**
 * Whether Inkling can serve this prompt. The bar is not "is the task easy"
 * (auto-route's call) but "can a tool-less 6k-token model answer this".
 */
export function isSimplePrompt(prompt: string): boolean {
	const p = prompt.trim();
	if (!p.length || p.startsWith("/")) return false;
	if (p.length > 300) return false;
	if (/```|[{}]|<\//.test(p)) return false;
	if (/\b(file|read|write|edit|bash|run|test|build|code|repo|git|fichier|projet|script|draft|patch)\b/i.test(p)) return false;
	if (/\/(?:home|data|tmp|usr|etc|var)\/|~\//.test(p)) return false;
	return true;
}

// --- Server probe ------------------------------------------------------------

export type ServerState = "ready" | "starting" | "down";

export async function serverState(url = SERVER_URL, timeoutMs = 1_500): Promise<ServerState> {
	try {
		const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
		if (r.ok) return "ready";
		return r.status === 503 ? "starting" : "down";
	} catch {
		return "down";
	}
}

async function waitForReady(timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await serverState()) === "ready") return true;
		await new Promise((r) => setTimeout(r, POLL_MS));
	}
	return false;
}

// --- Extension ---------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	/** Session state, all of it: which model and tools to give back, who started
	 *  the server, and whether the routing was ours (a manual pick is respected). */
	let restore: { model?: Model<Api>; tools?: string[] } = {};
	let sessionTools: string[] = [];
	let autoRouted = false;
	let startedByUs = false;

	const isInkling = (m?: Model<Api> | null): boolean => !!m && m.provider === PROVIDER && m.id === MODEL_ID;

	/** pi.setModel throws when the provider has no credentials. */
	async function setModel(model: Model<Api>): Promise<boolean> {
		try {
			return await pi.setModel(model);
		} catch {
			return false;
		}
	}

	async function leaveInkling(ctx: ExtensionContext): Promise<void> {
		autoRouted = false;
		const { model, tools } = restore;
		restore = {}; // first: the model_select this triggers is then a no-op
		// Fall back to the configured default when there is no recorded model (a
		// session restored directly on Inkling) or when it left the catalog.
		const target =
			(model && ctx.modelRegistry.find(model.provider, model.id)) ?? defaultFromSettings(ctx);
		if (target && (await setModel(target))) pi.setActiveTools(tools ?? sessionTools);
	}

	function defaultFromSettings(ctx: ExtensionContext) {
		const { defaultProvider, defaultModel } = pi.getSettings();
		if (!defaultProvider || !defaultModel) return undefined;
		const found = ctx.modelRegistry.find(defaultProvider, defaultModel);
		return isInkling(found) ? undefined : found;
	}

	/**
	 * Starts the server when needed; never throws, answers "is it ready".
	 * - "wait": block until ready (manual `/inkling`, manual model selection).
	 * - "background": launch and return at once, so the current turn is never
	 *   stalled; the next simple prompt gets the local model.
	 */
	async function ensureServer(ctx: ExtensionContext, mode: "wait" | "background"): Promise<boolean> {
		const state = await serverState();
		if (state === "ready") return true;
		if (state === "starting") return mode === "wait" ? waitForReady(READY_TIMEOUT_MS) : false;

		ctx.ui.notify("Démarrage du serveur Inkling local…", "info");
		let result;
		try {
			result = await pi.exec("bash", [START_SCRIPT], { signal: ctx.signal, timeout: 30_000 });
		} catch (e) {
			ctx.ui.notify(`Démarrage Inkling impossible : ${e instanceof Error ? e.message : e}`, "error");
			return false;
		}
		if (result.code !== 0) {
			ctx.ui.notify(`Démarrage Inkling impossible : ${result.stderr.trim() || `code ${result.code}`}`, "error");
			return false;
		}
		startedByUs = result.stdout.includes("launched"); // "already-running" is not ours to kill

		if (mode === "background") {
			void waitForReady(READY_TIMEOUT_MS).then((ok) =>
				ctx.ui.notify(ok ? "Serveur Inkling prêt" : "Inkling : chargement trop long", ok ? "info" : "warning"),
			);
			return false;
		}
		const ok = await waitForReady(READY_TIMEOUT_MS);
		ctx.ui.notify(ok ? "Serveur Inkling prêt" : "Serveur Inkling indisponible", ok ? "info" : "error");
		return ok;
	}

	async function stopServer(ctx: ExtensionContext): Promise<void> {
		try {
			await pi.exec("bash", [STOP_SCRIPT], { timeout: 15_000 });
			startedByUs = false;
			ctx.ui.notify("Serveur Inkling arrêté", "info");
		} catch (e) {
			ctx.ui.notify(`Arrêt impossible : ${e instanceof Error ? e.message : e}`, "error");
		}
	}

	pi.registerCommand("inkling", {
		description: "Serveur Inkling local : (start) | stop | status",
		handler: async (args, ctx) => {
			const arg = (args || "").trim().toLowerCase();
			if (arg === "stop") return stopServer(ctx);
			if (arg === "status") {
				const s = await serverState(SERVER_URL, 3_000);
				const label = s === "ready" ? "prêt" : s === "starting" ? "chargement en cours" : "arrêté";
				ctx.ui.notify(`Inkling : ${label}`, "info");
				return;
			}
			await ensureServer(ctx, "wait");
		},
	});

	// Single home for the invariant: entering Inkling saves the restore point and
	// strips the tools; leaving it, by any path, puts them back.
	pi.on("model_select", async (event, ctx) => {
		if (isInkling(event.model)) {
			if (isInkling(event.previousModel)) return; // already on Inkling
			restore = { model: event.previousModel, tools: pi.getActiveTools() };
			pi.setActiveTools([]); // the tool prompt alone exceeds the local window
			if (await ensureServer(ctx, "wait")) return;
			ctx.ui.notify("Inkling indisponible, retour au modèle précédent", "warning");
			await leaveInkling(ctx);
			return;
		}
		if (restore.tools) pi.setActiveTools(restore.tools);
		restore = {};
		autoRouted = false; // whoever left Inkling, the local turn is over
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionTools = pi.getActiveTools();
		restore = {};
		autoRouted = false;
		if (isInkling(ctx.model)) {
			// pi restored the selection without emitting model_select.
			pi.setActiveTools([]);
			void ensureServer(ctx, "background");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const simple = event.messageType === "user" && isSimplePrompt(event.prompt ?? "");

		if (!isInkling(ctx.model)) {
			if (!simple) return;
			if ((await serverState()) !== "ready") {
				void ensureServer(ctx, "background"); // warm up for the next prompt
				return;
			}
			const local = ctx.modelRegistry.find(PROVIDER, MODEL_ID);
			if (!local) {
				ctx.ui.notify(`Modèle introuvable : ${PROVIDER}/${MODEL_ID}`, "error");
			} else if (await setModel(local)) {
				autoRouted = true; // model_select stripped the tools
				ctx.ui.notify("Requête simple → Inkling local", "info");
			}
			return;
		}

		// Already local: an auto-routed turn leaves on a complex follow-up or a dead
		// server. A manual pick is kept, and the tools stay stripped either way.
		if (autoRouted && (!simple || (await serverState()) !== "ready")) await leaveInkling(ctx);
	});

	// The local answer is in: hand the session back before the next turn.
	pi.on("agent_settled", async (_event, ctx) => {
		if (autoRouted) await leaveInkling(ctx);
	});

	// Free the RAM: only a server we started, and only on a real exit.
	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason === "quit" && startedByUs) await stopServer(ctx);
	});
}
