/**
 * Tests for the hybrid classifier mode: classifyTier asks an available
 * classifier model to sort a prompt into a difficulty tier, with a confidence
 * gate and a cost-based pick of the classifier.
 *
 * Run with:  node --test classifier.test.ts
 *
 * HOME is redirected to a temp directory BEFORE the module loads: the persistent
 * denylist (~/.pi/agent/auto-route-denylist.json) stays isolated from real data
 * (same pattern as failover.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// pi's own agent-dir env var: set before module load, like failover.test.ts.
const AGENT_DIR = mkdtempSync(join(tmpdir(), "auto-route-agent-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.HOME = mkdtempSync(join(tmpdir(), "auto-route-test-"));

const { classifyTier } = await import("./auto-route.ts");

const CRITERIA = ["light", "standard", "complex", "heavy"];

/** A fake classifier model: provider, id and input cost are all the
 * candidate sort needs. */
function fakeModel(provider: string, id: string, inputCost: number): any {
	return { provider, id, cost: { input: inputCost, output: 0 } };
}

/** A fake classify result: the winning choice at probability `p`, the other
 * criteria negligible. The question is named "difficulty", like the one the
 * implementation asks. */
function fakeResult(choice: string, p: number): any {
	const probabilities: Record<string, number> = {};
	for (const c of CRITERIA) probabilities[c] = c === choice ? p : 0.03;
	return {
		stopReason: "stop",
		answers: {
			difficulty: { type: "choice", choice, probabilities },
		},
	};
}

/** Builds a fake ctx: getAvailableOfType serves `models`, classify runs `impl`
 * and every call is recorded. classify hangs off modelRegistry and is mirrored
 * on ctx itself, so the fake tolerates either wiring. */
function loadCtx(
	models: any[],
	impl: (model: any, context: any, options: any) => any = () => fakeResult("complex", 0.85),
) {
	const calls: Array<{ model: any; context: any; options: any }> = [];
	const requestedTypes: Array<string | undefined> = [];
	const classify = async (model: any, context: any, options: any) => {
		calls.push({ model, context, options });
		return impl(model, context, options);
	};
	const modelRegistry: any = {
		getAvailableOfType: async (type?: string) => {
			requestedTypes.push(type);
			return models;
		},
		getAll: () => [],
		getModelsOfType: () => [],
		getApiKeyForProvider: async () => undefined,
		classify,
	};
	const ctx: any = { modelRegistry, classify };
	return { ctx, calls, requestedTypes };
}

test("an empty classifier list yields no decision", async () => {
	const { ctx } = loadCtx([]);
	assert.equal(await classifyTier(ctx, "build me a small CLI tool"), undefined);
});

test("each choice maps to its tier, thinking and via", async () => {
	const cases: Array<[string, string, string]> = [
		["light", "eco", "low"],
		["standard", "standard", "medium"],
		["complex", "strong", "high"],
		["heavy", "frontier", "xhigh"],
	];
	for (const [choice, tier, thinking] of cases) {
		const { ctx, calls, requestedTypes } = loadCtx(
			[fakeModel("acme", "sorter", 0)],
			() => fakeResult(choice, 0.9),
		);
		const decision = await classifyTier(ctx, "a message of average difficulty");
		assert.deepEqual(
			decision,
			{ tier, thinking, via: "acme/sorter" },
			`choice "${choice}" must map to ${tier}/${thinking}`,
		);
		assert.equal(requestedTypes[0], "classifier", "the classifier catalog is what gets listed");
		assert.equal(calls.length, 1, "a single classifier is consulted");
	}
});

test("a low-confidence answer is discarded", async () => {
	const { ctx, calls } = loadCtx([fakeModel("acme", "sorter", 0)], () => fakeResult("standard", 0.42));
	assert.equal(await classifyTier(ctx, "a message of average difficulty"), undefined);
	assert.equal(calls.length, 1, "classify ran, then the gate rejected its answer");
});

test("a classify result that ends in error is discarded", async () => {
	const { ctx, calls } = loadCtx(
		[fakeModel("acme", "sorter", 0)],
		() => ({ stopReason: "error", errorMessage: "boom", answers: {} }),
	);
	assert.equal(await classifyTier(ctx, "a message of average difficulty"), undefined);
	assert.equal(calls.length, 1, "classify ran, then its error result was dropped");
});

test("classify throwing is swallowed into undefined", async () => {
	const { ctx } = loadCtx([fakeModel("acme", "sorter", 0)], () => {
		throw new Error("network");
	});
	assert.equal(await classifyTier(ctx, "a message of average difficulty"), undefined);
});

test("free classifiers are picked before paid ones", async () => {
	const { ctx, calls } = loadCtx([fakeModel("acme", "paid", 0.5), fakeModel("acme", "free", 0)]);
	const decision = await classifyTier(ctx, "a message of average difficulty");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].model.id, "free", "the free classifier must be the one called");
	assert.deepEqual(decision, { tier: "strong", thinking: "high", via: "acme/free" });
});

test("among paid classifiers the cheaper one is called", async () => {
	const { ctx, calls } = loadCtx([fakeModel("acme", "pricey", 2), fakeModel("acme", "cheap", 0.5)]);
	await classifyTier(ctx, "a message of average difficulty");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].model.id, "cheap", "candidates sort by ascending cost after the free ones");
});

test("the prompt handed to classify is capped at 16000 characters", async () => {
	const { ctx, calls } = loadCtx([fakeModel("acme", "sorter", 0)]);
	await classifyTier(ctx, "x".repeat(20_000));
	assert.equal(calls.length, 1);
	assert.equal(calls[0].context.state.prompt.length, 16_000);
});

test("an already-aborted signal does not stop the classify call", async () => {
	const { ctx, calls } = loadCtx([fakeModel("acme", "sorter", 0)]);
	const controller = new AbortController();
	controller.abort();
	await classifyTier(ctx, "a message of average difficulty", controller.signal);
	assert.equal(calls.length, 1, "classify must still be called under an aborted signal");
});

test("free opencode classifier borrows the opencode-go key when opencode is unconfigured", async () => {
	const { ctx, calls } = loadCtx([]);
	ctx.modelRegistry.getAll = () => [fakeModel("opencode-go", "glm-5.3", 0.5)];
	ctx.modelRegistry.getModelsOfType = (type: string, provider?: string) =>
		type === "classifier" && provider === "opencode"
			? [fakeModel("opencode", "jev-1.13", 0.042), fakeModel("opencode", "jev-1.13-free", 0)]
			: [];
	ctx.modelRegistry.getApiKeyForProvider = async (provider: string) =>
		provider === "opencode-go" ? "oc_sk_go_test" : undefined;

	const decision = await classifyTier(ctx, "refactor the authentication pipeline");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].model.id, "jev-1.13-free", "only the zero-cost opencode classifier is borrowed");
	assert.equal(calls[0].options.apiKey, "oc_sk_go_test", "the opencode-go key is passed per request");
	assert.deepEqual(decision, { tier: "strong", thinking: "high", via: "opencode/jev-1.13-free" });
});

test("any configured provider key can be borrowed when no opencode key exists", async () => {
	const { ctx, calls } = loadCtx([]);
	ctx.modelRegistry.getAll = () => [fakeModel("google", "gemini-3-flash", 0.3)];
	ctx.modelRegistry.getModelsOfType = (type: string, provider?: string) =>
		type === "classifier" && provider === "opencode"
			? [fakeModel("opencode", "jev-1.13-free", 0)]
			: [];
	ctx.modelRegistry.getApiKeyForProvider = async (provider: string) =>
		provider === "google" ? "google_key_abc" : undefined;

	const decision = await classifyTier(ctx, "refactor the authentication pipeline");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].options.apiKey, "google_key_abc", "the google key supplies the identity");
	assert.equal(decision?.via, "opencode/jev-1.13-free");
});

test("a borrowed key the classifier rejects falls through to the next one", async () => {
	const impl = (_model: any, _context: any, options: any) =>
		options.apiKey === "key_aaa"
			? { stopReason: "error", errorMessage: "401 invalid credentials", answers: {} }
			: fakeResult("standard", 0.9);
	const { ctx, calls } = loadCtx([], impl);
	ctx.modelRegistry.getAll = () => [
		fakeModel("aaa", "model-a", 0.1),
		fakeModel("bbb", "model-b", 0.1),
	];
	ctx.modelRegistry.getModelsOfType = (type: string, provider?: string) =>
		type === "classifier" && provider === "opencode"
			? [fakeModel("opencode", "jev-1.13-free", 0)]
			: [];
	ctx.modelRegistry.getApiKeyForProvider = async (provider: string) =>
		provider === "aaa" ? "key_aaa" : provider === "bbb" ? "key_bbb" : undefined;

	const decision = await classifyTier(ctx, "refactor the authentication pipeline");
	assert.equal(calls.length, 2, "the rejected key must not end the classification");
	assert.equal(calls[0].options.apiKey, "key_aaa");
	assert.equal(calls[1].options.apiKey, "key_bbb", "the next key gets its turn");
	assert.equal(decision?.via, "opencode/jev-1.13-free");
});

test("no borrowed key and no classifier yields no decision", async () => {
	const { ctx, calls } = loadCtx([]);
	ctx.modelRegistry.getModelsOfType = (type: string, provider?: string) =>
		type === "classifier" && provider === "opencode"
			? [fakeModel("opencode", "jev-1.13-free", 0)]
			: [];
	assert.equal(await classifyTier(ctx, "a message of average difficulty"), undefined);
	assert.equal(calls.length, 0, "nothing is called without a usable key");
});

