/**
 * Tests du failover 429 « quota fournisseur » et du thinking par défaut de `auto`.
 *
 * Lancer avec :  node --test failover.test.ts
 *
 * HOME est redirigé vers un répertoire temporaire AVANT le chargement du module :
 * la denylist persistante (~/.pi/agent/auto-route-denylist.json) est isolée des
 * vraies données pendant les tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "auto-route-test-"));

const { default: autoRoute, toFailoverRetryMessage } = await import("./auto-route.ts");

const DENYLIST = join(process.env.HOME as string, ".pi/agent/auto-route-denylist.json");

function loadRouter() {
	let vm: any;
	const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	const setThinkingCalls: string[] = [];
	const pi: any = {
		on: (event: string, h: any) => void (handlers[event] ??= []).push(h),
		events: { emit: () => {} },
		registerVirtualModel: (m: any) => {
			vm = m;
		},
		getThinkingLevel: () => "medium",
		setThinkingLevel: (level: string) => void setThinkingCalls.push(level),
	};
	autoRoute(pi);
	return { vm, handlers, setThinkingCalls };
}

const QUOTA_ERROR: any = {
	role: "assistant",
	stopReason: "error",
	provider: "opencode-go",
	model: "glm-5.3",
	content: [],
	errorMessage:
		'opencode-go API error (429): {"type":"error","error":{"type":"GoUsageLimitError","message":"Go usage limit exceeded"},"metadata":{"limitName":"5 hour"}}',
};

/** Sous-chaînes qui rendent une erreur NON-retryable aux yeux de pi : le texte
 * réécrit ne doit en contenir aucune, sinon pi refuse toujours de retryer. */
const PI_NON_RETRYABLE_MARKERS = [
	"billing",
	"quota exceeded",
	"available balance",
	"insufficient_quota",
	"GoUsageLimitError",
	"1308",
];

test("toFailoverRetryMessage réécrit un 429 de quota en erreur retryable", () => {
	const out = toFailoverRetryMessage(QUOTA_ERROR);
	assert.ok(out, "le 429 de quota doit être réécrit");
	assert.match(out.errorMessage, /429/, "le texte réécrit doit contenir le motif retryable « 429 »");
	for (const marker of PI_NON_RETRYABLE_MARKERS) {
		assert.ok(
			!out.errorMessage.includes(marker),
			`le texte réécrit ne doit pas contenir "${marker}"`,
		);
	}
	assert.equal(out.provider, "opencode-go", "le modèle physique fautif reste identifié");
	assert.equal(out.model, "glm-5.3");
});

test("un 429 Google (quota/billing) est aussi réécrit", () => {
	const google: any = {
		...QUOTA_ERROR,
		provider: "google",
		model: "gemini-4-argon",
		errorMessage:
			'{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}',
	};
	const out = toFailoverRetryMessage(google);
	assert.ok(out, "le 429 Google doit être réécrit");
	assert.match(out.errorMessage, /429/);
	assert.ok(!/billing|quota exceeded/i.test(out.errorMessage));
});

test("toFailoverRetryMessage ignore ce qui n'a pas besoin de réécriture", () => {
	// Abort utilisateur : ne jamais relancer automatiquement.
	assert.equal(
		toFailoverRetryMessage({ ...QUOTA_ERROR, errorMessage: "This operation was aborted" }),
		undefined,
	);
	// Débordement de contexte : géré par la compaction, pas par un retry.
	assert.equal(
		toFailoverRetryMessage({
			...QUOTA_ERROR,
			errorMessage: "prompt is too long: maximum context length is 200000 tokens",
		}),
		undefined,
	);
	// 429 déjà retryable (rate limit transit) : pi gère déjà, on ne touche pas au texte.
	assert.equal(
		toFailoverRetryMessage({
			...QUOTA_ERROR,
			errorMessage: "429 rate_limit_error: too many requests",
		}),
		undefined,
	);
	// Message sans erreur.
	assert.equal(
		toFailoverRetryMessage({ ...QUOTA_ERROR, stopReason: "stop", errorMessage: undefined }),
		undefined,
	);
});

test("message_end réécrit sous auto, pas hors auto, et ne bannit pas un quota", async () => {
	const { handlers } = loadRouter();
	const autoCtx = { model: { provider: "auto", id: "auto" } };

	const res = await handlers.message_end[0]({ message: QUOTA_ERROR }, autoCtx);
	assert.ok(res?.message, "sous auto, le 429 est réécrit pour déclencher le retry de pi");
	assert.match(res.message.errorMessage, /429 quota fournisseur/);

	// Un quota n'est pas une erreur définitive : la denylist reste vide.
	assert.ok(!existsSync(DENYLIST), "un 429 ne doit pas bannir le modèle");

	// Hors auto (modèle physique sélectionné) : aucune réécriture, pi garde son comportement.
	const res2 = await handlers.message_end[0](
		{ message: QUOTA_ERROR },
		{ model: { provider: "google", id: "gemini-4-argon" } },
	);
	assert.equal(res2, undefined);
});

test("message_end bannit toujours les erreurs définitives (404/410)", async () => {
	const { handlers } = loadRouter();
	const dead: any = {
		...QUOTA_ERROR,
		errorMessage: '{"error":{"code":404,"message":"This model is no longer available to new users."}}',
	};
	const res = await handlers.message_end[0](
		{ message: dead },
		{ model: { provider: "auto", id: "auto" } },
	);
	assert.equal(res, undefined, "une erreur définitive n'est pas réécrite en retry");
	assert.ok(existsSync(DENYLIST), "le modèle mort doit être banni");
	const denylist = JSON.parse(readFileSync(DENYLIST, "utf8"));
	assert.ok(denylist.includes("opencode-go/glm-5.3"));
});

test("sélectionner auto met le thinking à low par défaut", async () => {
	const { handlers, setThinkingCalls } = loadRouter();

	await handlers.model_select[0]({ model: { provider: "auto", id: "auto" } }, {});
	assert.deepEqual(setThinkingCalls, ["low"], "la sélection auto part en low");

	await handlers.model_select[0]({ model: { provider: "google", id: "gemini-4-argon" } }, {});
	assert.deepEqual(setThinkingCalls, ["low"], "hors auto, aucun forçage de thinking");
});

test("retry après 429 quota : évite tout le fournisseur et bascule", async () => {
	const { vm, handlers } = loadRouter();
	const models: any[] = [
		{ provider: "opencode-go", id: "kimi-k3", name: "Kimi K3", reasoning: true, cost: { input: 2, output: 15 }, contextWindow: 200000 },
		{ provider: "opencode-go", id: "glm-5.3", name: "GLM 5.3", reasoning: true, cost: { input: 1, output: 4.4 }, contextWindow: 200000 },
		{ provider: "google", id: "gemini-4-argon", name: "Gemini 4", reasoning: true, cost: { input: 2, output: 10 }, contextWindow: 200000 },
	];
	const ctx: any = {
		modelRegistry: {
			getAvailable: () => models,
			find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
		},
		ui: { setStatus: () => {} },
	};

	// pi transmet au retry le message réécrit par message_end.
	const rewritten = (
		await handlers.message_end[0]({ message: QUOTA_ERROR }, { model: { provider: "auto", id: "auto" } })
	).message;

	const r = await vm.route(
		{
			reason: "retry",
			thinkingLevel: "xhigh",
			failed: { model: models[1], thinkingLevel: "medium", message: rewritten },
			messages: [{ role: "user", content: "ok" }],
			state: undefined,
		},
		ctx,
	);
	assert.notEqual(r.model.provider, "opencode-go", "le failover doit changer de fournisseur");
	assert.ok(r.state.avoid.includes("opencode-go"), "tout le fournisseur est évité pour ce tour");
});

test("retry sur erreur transitoire : évite le modèle, pas tout le fournisseur", async () => {
	const { vm } = loadRouter();
	const models: any[] = [
		{ provider: "opencode-go", id: "kimi-k3", name: "Kimi K3", reasoning: true, cost: { input: 2, output: 15 }, contextWindow: 200000 },
		{ provider: "opencode-go", id: "glm-5.3", name: "GLM 5.3", reasoning: true, cost: { input: 1, output: 4.4 }, contextWindow: 200000 },
	];
	const ctx: any = {
		modelRegistry: {
			getAvailable: () => models,
			find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
		},
		ui: { setStatus: () => {} },
	};

	const r = await vm.route(
		{
			reason: "retry",
			thinkingLevel: "xhigh",
			failed: {
				model: models[1],
				thinkingLevel: "medium",
				message: { role: "assistant", stopReason: "error", errorMessage: "503 overloaded" },
			},
			messages: [{ role: "user", content: "ok" }],
			state: undefined,
		},
		ctx,
	);
	assert.ok(r.state.avoid.includes("opencode-go/glm-5.3"), "le modèle fautif est évité");
	assert.ok(!r.state.avoid.includes("opencode-go"), "le fournisseur entier n'est pas évité");
	assert.notEqual(r.model.id, "glm-5.3");
});
