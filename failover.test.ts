/**
 * Tests for the provider-quota 429 failover and the default thinking of `auto`.
 *
 * Run with:  node --test failover.test.ts
 *
 * HOME is redirected to a temp directory BEFORE the module loads: the persistent
 * denylist (~/.pi/agent/auto-route-denylist.json) stays isolated from real data.
 */
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// pi's own agent-dir env var: the denylist must honor it (set before module load).
const AGENT_DIR = mkdtempSync(join(tmpdir(), "auto-route-agent-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.HOME = mkdtempSync(join(tmpdir(), "auto-route-test-"));

const {
	default: autoRoute,
	classifyFailure,
	resetDenylist,
	sanitizeAssistantToolCalls,
	sanitizeContextMessages,
	toFailoverRetryMessage,
} = await import("./auto-route.ts");

/** pi types `errorMessage` as optional; every assertion here needs the text. */
function errMsg(m: { errorMessage?: string }): string {
	if (typeof m.errorMessage !== "string") assert.fail("expected an assistant error message");
	return m.errorMessage;
}

const DENYLIST = join(AGENT_DIR, "auto-route-denylist.json");

beforeEach(() => {
	resetDenylist();
});

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

function makeCtx(models: any[]): any {
	return {
		modelRegistry: {
			getAvailable: () => models,
			find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
		},
		ui: { setStatus: () => {} },
	};
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

/** Substrings that make an error NON-retryable for pi: the rewritten text must
 * contain none of them, otherwise pi still refuses to retry. */
const PI_NON_RETRYABLE_MARKERS = [
	"billing",
	"quota exceeded",
	"available balance",
	"insufficient_quota",
	"GoUsageLimitError",
	"1308",
];

test("toFailoverRetryMessage rewrites a quota 429 into a retryable error", () => {
	const out = toFailoverRetryMessage(QUOTA_ERROR);
	assert.ok(out, "the quota 429 must be rewritten");
	assert.match(errMsg(out), /429/, "the rewritten text must carry pi's retryable \"429\" pattern");
	for (const marker of PI_NON_RETRYABLE_MARKERS) {
		assert.ok(
			!errMsg(out).includes(marker),
			`the rewritten text must not contain "${marker}"`,
		);
	}
	assert.equal(out.provider, "opencode-go", "the failing physical model stays identified");
	assert.equal(out.model, "glm-5.3");
});

test("a Google quota/billing 429 is rewritten, while a transient Google 429 RESOURCE_EXHAUSTED is not", () => {
	const googleBilling: any = {
		...QUOTA_ERROR,
		provider: "google",
		model: "gemini-4-argon",
		errorMessage:
			'{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}',
	};
	const out = toFailoverRetryMessage(googleBilling);
	assert.ok(out, "the Google billing/quota 429 must be rewritten");
	assert.match(errMsg(out), /429/);
	assert.ok(!/billing|quota exceeded/i.test(errMsg(out)));

	// Transient rate-limit 429 RESOURCE_EXHAUSTED without billing/quota-exceeded:
	// pi already treats it as retryable, so it must not be rewritten.
	const googleTransient: any = {
		...QUOTA_ERROR,
		provider: "google",
		model: "gemini-4-argon",
		errorMessage:
			'{"error":{"code":429,"message":"Resource has been exhausted (e.g. check rate limit).","status":"RESOURCE_EXHAUSTED"}}',
	};
	assert.equal(classifyFailure(googleTransient.errorMessage), "provider-limit");
	assert.equal(toFailoverRetryMessage(googleTransient), undefined);
});

test("a Zhipu 1308 usage-limit 429 is classified as provider-limit and rewritten", () => {
	const zhipu: any = {
		...QUOTA_ERROR,
		provider: "zhipu",
		model: "glm-5",
		errorMessage:
			'zhipu API error (429): {"error":{"code":"1308","message":"Usage limit reached for your plan"}}',
	};
	assert.equal(classifyFailure(zhipu.errorMessage), "provider-limit");
	const out = toFailoverRetryMessage(zhipu);
	assert.ok(out, "Zhipu 1308 must be rewritten because pi treats code 1308 as non-retryable");
	assert.match(errMsg(out), /429 provider quota/);
	assert.ok(!errMsg(out).includes("1308"));
});

test("a 403 model-access error is rewritten into a retryable 429 (found live: opencode Zen models disabled on a Go key)", () => {
	const disabled: any = {
		...QUOTA_ERROR,
		provider: "opencode",
		model: "gpt-5.4-pro",
		errorMessage:
			'opencode API error (403): {"type":"permission_error","message":"Model access is disabled. Change model access at https://opencode.ai/console/org_x/models."}',
	};
	const out = toFailoverRetryMessage(disabled);
	assert.ok(out, "the 403 model-access error must be rewritten");
	assert.match(errMsg(out), /429/, "the rewritten text must carry pi's retryable 429");
	assert.ok(
		!/permission_error/i.test(errMsg(out)),
		"the rewritten text must not carry the provider's non-retryable wording",
	);
	// A disabled model is a per-model problem: classified as model-access (and
	// still recognized as model-access after the rewrite).
	assert.equal(classifyFailure(disabled.errorMessage), "model-access");
	assert.equal(classifyFailure(errMsg(out)), "model-access");
});

test("an insufficient-balance 402 (pay-as-you-go provider not covered by the key) is rewritten", () => {
	const balance: any = {
		...QUOTA_ERROR,
		provider: "opencode",
		model: "gpt-5.5-pro",
		errorMessage:
			'opencode API error (402): {"type":"error","error":{"type":"invalid_request_error","message":"Insufficient balance. This request is pay-as-you-go, billed to OpenCode Models credits. Top up at https://opencode.ai/console/org_x/billing?credits=1. OpenCode Go covers only requests to the OpenCode Go provider."}}',
	};
	const out = toFailoverRetryMessage(balance);
	assert.ok(out, "the 402 insufficient-balance error must be rewritten");
	assert.match(errMsg(out), /429/, "the rewritten text must carry pi's retryable 429");
	assert.ok(
		!/insufficient balance|billing/i.test(errMsg(out)),
		"the rewritten text must not carry the provider's non-retryable wording",
	);
	// A balance problem is account-wide: the whole provider is the right scope,
	// and it is not a permanent model failure.
	assert.equal(classifyFailure(balance.errorMessage), "provider-limit");
	assert.equal(classifyFailure(errMsg(out)), "provider-limit");
});

test("request-specific 400 errors (unsupported image format, file not found) are transient and never ban the model", async () => {
	const { handlers } = loadRouter();
	for (const text of [
		"400 Bad Request: Unsupported image format image/tiff",
		"400 Bad Request: file not found in upload batch",
	]) {
		assert.equal(classifyFailure(text), "transient", `"${text}" must be transient`);
		const msg: any = { ...QUOTA_ERROR, errorMessage: text };
		assert.equal(toFailoverRetryMessage(msg), undefined);
		await handlers.message_end[0](
			{ message: msg },
			{ model: { provider: "auto", id: "auto" } },
		);
		assert.ok(!existsSync(DENYLIST), `"${text}" must not ban the model`);
	}
});

test("retry after a model-access 429 avoids the model, not the whole provider", async () => {
	const { vm, handlers } = loadRouter();
	const models: any[] = [
		{ provider: "opencode", id: "gpt-5.4-pro", name: "GPT 5.4 Pro", reasoning: true, cost: { input: 5, output: 20 }, contextWindow: 200000 },
		{ provider: "opencode", id: "glm-mini", name: "GLM Mini", reasoning: true, cost: { input: 1, output: 4 }, contextWindow: 200000 },
		{ provider: "google", id: "gemini-4-argon", name: "Gemini 4", reasoning: true, cost: { input: 2, output: 10 }, contextWindow: 200000 },
	];
	const ctx = makeCtx(models);

	// pi hands the retry the message rewritten by message_end.
	const disabled: any = {
		...QUOTA_ERROR,
		provider: "opencode",
		model: "gpt-5.4-pro",
		errorMessage:
			'opencode API error (403): {"type":"permission_error","message":"Model access is disabled. Change model access at https://opencode.ai/console/org_x/models."}',
	};
	const rewritten = (await handlers.message_end[0]({ message: disabled }, { model: { provider: "auto", id: "auto" } })).message;
	assert.match(rewritten.errorMessage, /429 model access/);

	const r = await vm.route(
		{
			reason: "retry",
			thinkingLevel: "xhigh",
			failed: { model: models[0], thinkingLevel: "medium", message: rewritten },
			messages: [{ role: "user", content: "ok" }],
			state: undefined,
		},
		ctx,
	);
	assert.ok(
		r.state?.avoid?.includes("opencode/gpt-5.4-pro"),
		"the failed model must be avoided",
	);
	assert.ok(
		!r.state?.avoid?.some((a: string) => a === "opencode"),
		"the whole provider must NOT be avoided: other models of the account still work",
	);
});

test("toFailoverRetryMessage skips what does not need a rewrite", () => {
	// User abort: never restart automatically.
	assert.equal(
		toFailoverRetryMessage({ ...QUOTA_ERROR, errorMessage: "This operation was aborted" }),
		undefined,
	);
	// Context overflow: compaction handles it, not a retry.
	assert.equal(
		toFailoverRetryMessage({
			...QUOTA_ERROR,
			errorMessage: "prompt is too long: maximum context length is 200000 tokens",
		}),
		undefined,
	);
	// Already-retryable 429 (transient rate limit): pi handles it, text untouched.
	assert.equal(
		toFailoverRetryMessage({
			...QUOTA_ERROR,
			errorMessage: "429 rate_limit_error: too many requests",
		}),
		undefined,
	);
	// Message without an error.
	assert.equal(
		toFailoverRetryMessage({ ...QUOTA_ERROR, stopReason: "stop", errorMessage: undefined }),
		undefined,
	);
});

test("message_end rewrites under auto, not outside auto, and never bans a quota", async () => {
	const { handlers } = loadRouter();
	const autoCtx = { model: { provider: "auto", id: "auto" } };

	const res = await handlers.message_end[0]({ message: QUOTA_ERROR }, autoCtx);
	assert.ok(res?.message, "under auto, the 429 is rewritten to trigger pi's retry");
	assert.match(res.message.errorMessage, /429 provider quota/);

	// A quota is not a permanent failure: the denylist stays empty.
	assert.ok(!existsSync(DENYLIST), "a 429 must not ban the model");

	// Outside auto (physical model selected): no rewrite, pi keeps its behavior.
	const res2 = await handlers.message_end[0](
		{ message: QUOTA_ERROR },
		{ model: { provider: "google", id: "gemini-4-argon" } },
	);
	assert.equal(res2, undefined);
});

test("message_end still bans permanent failures (404/410)", async () => {
	const { handlers } = loadRouter();
	const dead: any = {
		...QUOTA_ERROR,
		errorMessage: '{"error":{"code":404,"message":"This model is no longer available to new users."}}',
	};
	const res = await handlers.message_end[0](
		{ message: dead },
		{ model: { provider: "auto", id: "auto" } },
	);
	assert.equal(res, undefined, "a permanent failure is never rewritten into a retry");
	assert.ok(existsSync(DENYLIST), "the dead model must be banned");
	const denylist = JSON.parse(readFileSync(DENYLIST, "utf8"));
	assert.ok(denylist.includes("opencode-go/glm-5.3"));
});

test("selecting auto sets thinking to low by default", async () => {
	const { handlers, setThinkingCalls } = loadRouter();

	await handlers.model_select[0]({ model: { provider: "auto", id: "auto" } }, {});
	assert.deepEqual(setThinkingCalls, ["low"], "selecting auto starts at low");

	await handlers.model_select[0]({ model: { provider: "google", id: "gemini-4-argon" } }, {});
	assert.deepEqual(setThinkingCalls, ["low"], "outside auto, no thinking override");
});

test("retry after a quota 429: the whole provider is avoided, the router switches", async () => {
	const { vm, handlers } = loadRouter();
	const models: any[] = [
		{ provider: "opencode-go", id: "kimi-k3", name: "Kimi K3", reasoning: true, cost: { input: 2, output: 15 }, contextWindow: 200000 },
		{ provider: "opencode-go", id: "glm-5.3", name: "GLM 5.3", reasoning: true, cost: { input: 1, output: 4.4 }, contextWindow: 200000 },
		{ provider: "google", id: "gemini-4-argon", name: "Gemini 4", reasoning: true, cost: { input: 2, output: 10 }, contextWindow: 200000 },
	];
	const ctx = makeCtx(models);

	// pi hands pi's retry the message rewritten by message_end.
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
	assert.notEqual(r.model.provider, "opencode-go", "the failover must change provider");
	assert.ok(r.state.avoid.includes("opencode-go"), "the whole provider is avoided for this turn");
});

test("retry on a transient error: the model is avoided, not the whole provider", async () => {
	const { vm } = loadRouter();
	const models: any[] = [
		{ provider: "opencode-go", id: "kimi-k3", name: "Kimi K3", reasoning: true, cost: { input: 2, output: 15 }, contextWindow: 200000 },
		{ provider: "opencode-go", id: "glm-5.3", name: "GLM 5.3", reasoning: true, cost: { input: 1, output: 4.4 }, contextWindow: 200000 },
	];
	const ctx = makeCtx(models);

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
	assert.ok(r.state.avoid.includes("opencode-go/glm-5.3"), "the failing model is avoided");
	assert.ok(!r.state.avoid.includes("opencode-go"), "the whole provider is not avoided");
	assert.notEqual(r.model.id, "glm-5.3");
});

test("a transient rate limit keeps its original text but still avoids the provider on retry", async () => {
	const rateLimit: any = {
		...QUOTA_ERROR,
		provider: "anthropic",
		model: "claude-test",
		errorMessage: "429 rate_limit_error: too many requests",
	};
	assert.equal(
		toFailoverRetryMessage(rateLimit),
		undefined,
		"already-retryable errors keep their original text",
	);

	const { vm } = loadRouter();
	const models: any[] = [
		{ provider: "anthropic", id: "claude-test", name: "Claude", reasoning: true, cost: { input: 2, output: 15 }, contextWindow: 200000 },
		{ provider: "google", id: "gemini-4-argon", name: "Gemini 4", reasoning: true, cost: { input: 2, output: 10 }, contextWindow: 200000 },
	];
	const ctx = makeCtx(models);

	const r = await vm.route(
		{
			reason: "retry",
			thinkingLevel: "xhigh",
			failed: { model: models[0], thinkingLevel: "high", message: rateLimit },
			messages: [{ role: "user", content: "ok" }],
			state: undefined,
		},
		ctx,
	);
	assert.ok(r.state.avoid.includes("anthropic"), "a rate limit is account-wide: the provider is avoided");
	assert.notEqual(r.model.provider, "anthropic", "the failover changes provider");
});

test("a model without pricing data is still a candidate", async () => {
	const { vm } = loadRouter();
	// No `cost` field at all: previously rejected as "free", now kept and
	// ranked at the mid cost so it is still routable.
	const models: any[] = [
		{ provider: "acme", id: "mystery", name: "Mystery", reasoning: true, contextWindow: 100000 },
	];
	const ctx = makeCtx(models);

	const r = await vm.route(
		{
			reason: "user",
			thinkingLevel: "low",
			messages: [{ role: "user", content: "ok" }],
			state: undefined,
		},
		ctx,
	);
	assert.equal(r.model.id, "mystery", "a pricing-less model must not be dropped from the catalog");
});

test("retry when avoid exhausts the catalog falls back to eco (not frontier) and handles missing failed", async () => {
	const { vm } = loadRouter();
	const models: any[] = [
		{ provider: "acme", id: "expensive", name: "Expensive", reasoning: true, cost: { input: 5, output: 30 }, contextWindow: 200000 },
		{ provider: "acme", id: "cheap", name: "Cheap", reasoning: true, cost: { input: 0.5, output: 2 }, contextWindow: 200000 },
	];
	const ctx = makeCtx(models);

	// Provider-limit on the only provider: `avoid` now covers all models.
	const r1 = await vm.route(
		{
			reason: "retry",
			thinkingLevel: "xhigh",
			failed: {
				model: models[0],
				thinkingLevel: "high",
				message: { role: "assistant", stopReason: "error", errorMessage: "429 rate_limit_error" },
			},
			messages: [{ role: "user", content: "ok" }],
			state: undefined,
		},
		ctx,
	);
	assert.equal(r1.model.id, "cheap", "when avoid covers all candidates, last-resort fallback must be eco");

	// Router-level retry without `failed`: preserves state.avoid without calling classifyTier.
	let classifyCalled = false;
	ctx.modelRegistry.getAvailableOfType = async () => {
		classifyCalled = true;
		return [];
	};
	const r2 = await vm.route(
		{
			reason: "retry",
			thinkingLevel: "xhigh",
			failed: undefined,
			messages: [{ role: "user", content: "ok" }],
			state: { modelId: "expensive", providerId: "acme", thinking: "high", avoid: ["acme/expensive"], source: "local" },
		},
		ctx,
	);
	assert.equal(classifyCalled, false, "retry without failed must not re-run classification");
	assert.equal(r2.model.id, "cheap");
	assert.deepEqual(r2.state.avoid, ["acme/expensive"]);
});

test("continuation without edit (or with failed edit) keeps current model and returns state: undefined when thinking is unchanged", async () => {
	const { vm } = loadRouter();
	const models: any[] = [
		{ provider: "acme", id: "strong-1", name: "Strong 1", reasoning: true, cost: { input: 5, output: 20 }, contextWindow: 200000 },
		{ provider: "acme", id: "eco-1", name: "Eco 1", reasoning: true, cost: { input: 0.5, output: 2 }, contextWindow: 200000 },
	];
	const ctx = makeCtx(models);
	const prevState = {
		modelId: "strong-1",
		providerId: "acme",
		thinking: "high",
		avoid: [],
		source: "local",
	};

	// After a read tool result and a failed edit (isError: true): still on strong-1.
	const r = await vm.route(
		{
			reason: "continuation",
			thinkingLevel: "xhigh",
			messages: [
				{ role: "user", content: "refactor src/app.ts" },
				{ role: "toolResult", toolName: "read", isError: false, content: [] },
				{ role: "toolResult", toolName: "edit", isError: true, content: [] },
			],
			state: prevState,
		},
		ctx,
	);
	assert.equal(r.model.id, "strong-1", "failed edit must not switch to eco");
	assert.equal(r.thinkingLevel, "high");
	assert.equal(r.state, undefined, "unchanged state must be undefined so pi skips session persistence");
});

test("continuation after a successful edit/write switches to eco (capped at medium) and omits state on subsequent eco continuations", async () => {
	const { vm } = loadRouter();
	const models: any[] = [
		{ provider: "acme", id: "strong-1", name: "Strong 1", reasoning: true, cost: { input: 5, output: 20 }, contextWindow: 200000 },
		{ provider: "acme", id: "eco-1", name: "Eco 1", reasoning: true, cost: { input: 0.5, output: 2 }, contextWindow: 200000 },
	];
	const ctx = makeCtx(models);
	const prevState = {
		modelId: "strong-1",
		providerId: "acme",
		thinking: "high",
		avoid: ["other/bad"],
		source: "local",
	};
	const messages = [
		{ role: "user", content: "refactor src/app.ts" },
		{ role: "toolResult", toolName: "edit", isError: false, content: [] },
	];

	const r1 = await vm.route(
		{
			reason: "continuation",
			thinkingLevel: "xhigh",
			messages,
			state: prevState,
		},
		ctx,
	);
	assert.equal(r1.model.id, "eco-1", "first successful edit switches to eco");
	assert.equal(r1.thinkingLevel, "medium", "post-edit thinking is capped at medium");
	assert.ok(r1.state, "the model switch must persist the new state");
	assert.equal(r1.state.modelId, "eco-1");
	assert.deepEqual(r1.state.avoid, ["other/bad"]);

	// Next continuation in the same turn (already on eco-1 at medium): state is undefined.
	const r2 = await vm.route(
		{
			reason: "continuation",
			thinkingLevel: "xhigh",
			messages: [
				...messages,
				{ role: "toolResult", toolName: "bash", isError: false, content: [] },
			],
			state: r1.state,
		},
		ctx,
	);
	assert.equal(r2.model.id, "eco-1");
	assert.equal(r2.state, undefined, "already on eco at medium: no new state entry");
});

test("continuation safety fallback re-routes when the current model was banned meanwhile, preserving avoid", async () => {
	const { vm, handlers } = loadRouter();
	const models: any[] = [
		{ provider: "acme", id: "dead-model", name: "Dead", reasoning: true, cost: { input: 5, output: 20 }, contextWindow: 200000 },
		{ provider: "acme", id: "alive-model", name: "Alive", reasoning: true, cost: { input: 1, output: 4 }, contextWindow: 200000 },
	];
	const ctx = makeCtx(models);

	// Ban acme/dead-model via message_end (404).
	await handlers.message_end[0](
		{
			message: {
				...QUOTA_ERROR,
				provider: "acme",
				model: "dead-model",
				errorMessage: '{"error":{"code":404,"message":"model not found"}}',
			},
		},
		{ model: { provider: "auto", id: "auto" } },
	);

	const r = await vm.route(
		{
			reason: "continuation",
			thinkingLevel: "xhigh",
			messages: [{ role: "user", content: "ok" }],
			state: {
				modelId: "dead-model",
				providerId: "acme",
				thinking: "low",
				avoid: ["other/flaky"],
				source: "local",
			},
		},
		ctx,
	);
	assert.equal(r.model.id, "alive-model", "banned current model triggers safety re-route to an available model");
	assert.deepEqual(r.state.avoid, ["other/flaky"], "turn-local avoid list is preserved across safety re-route");
});

test("direct reason routes to eco at low thinking without state", async () => {
	const { vm } = loadRouter();
	const models: any[] = [
		{ provider: "acme", id: "strong-1", name: "Strong 1", reasoning: true, cost: { input: 5, output: 20 }, contextWindow: 200000 },
		{ provider: "acme", id: "eco-1", name: "Eco 1", reasoning: true, cost: { input: 0.5, output: 2 }, contextWindow: 200000 },
	];
	const ctx = makeCtx(models);

	const r = await vm.route(
		{
			reason: "direct",
			thinkingLevel: "xhigh",
			messages: [{ role: "user", content: "summarize" }],
			state: undefined,
		},
		ctx,
	);
	assert.equal(r.model.id, "eco-1");
	assert.equal(r.thinkingLevel, "low");
	assert.equal(r.state, undefined);
});

test("message_end repairs assistant toolCalls with empty id or name before execution and persistence", async () => {
	const { handlers } = loadRouter();
	const brokenAssistant: any = {
		role: "assistant",
		stopReason: "toolUse",
		provider: "opencode-go",
		model: "mimo-v2.6-flash",
		timestamp: 1795455941706,
		content: [
			{ type: "text", text: "Let me check..." },
			{ type: "toolCall", id: "", name: "", arguments: {} },
		],
	};

	const res = await handlers.message_end[0](
		{ message: brokenAssistant },
		{ model: { provider: "auto", id: "auto" } },
	);
	assert.ok(res?.message, "message_end must return a repaired message");
	const tc = res.message.content[1];
	assert.equal(tc.type, "toolCall");
	assert.ok(tc.id.length > 0, "toolCall.id must be non-empty");
	assert.equal(tc.name, "__missing_tool_name__", "toolCall.name must be filled with a fallback");

	// Valid toolCalls remain untouched.
	const validAssistant: any = {
		...brokenAssistant,
		content: [{ type: "toolCall", id: "call_123", name: "bash", arguments: { command: "ls" } }],
	};
	assert.equal(sanitizeAssistantToolCalls(validAssistant), undefined);
});

test("context hook repairs already-persisted empty toolCall and toolResult pairs in session history", async () => {
	const { handlers } = loadRouter();
	const poisonedHistory: any[] = [
		{ role: "user", content: "hello" },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "running tool" },
				{ type: "toolCall", id: "", name: "", arguments: {} },
			],
		},
		{
			role: "toolResult",
			toolCallId: "",
			toolName: "",
			content: [{ type: "text", text: "Tool  not found" }],
			isError: true,
		},
	];

	const res = await handlers.context[0]({ messages: poisonedHistory }, {});
	assert.ok(res?.messages, "context hook must return sanitized messages when empty IDs/names exist");
	const repairedCall = res.messages[1].content[1];
	const repairedResult = res.messages[2];
	assert.ok(repairedCall.id.length > 0);
	assert.equal(repairedCall.name, "__missing_tool_name__");
	assert.equal(repairedResult.toolCallId, repairedCall.id, "toolResult must pair with the repaired toolCall ID");
	assert.equal(repairedResult.toolName, "__missing_tool_name__");

	// Clean history returns undefined so prompt caching is preserved.
	assert.equal(sanitizeContextMessages(res.messages), undefined);
});

test("Google 400 function_response.name error is rewritten into a per-model retryable 429 and avoids only the model", async () => {
	const { vm, handlers } = loadRouter();
	const google400: any = {
		...QUOTA_ERROR,
		provider: "google",
		model: "gemini-3.1-flash-lite-preview",
		errorMessage:
			'{"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 400,\\n    \\"message\\": \\"* GenerateContentRequest.contents[10].parts[0].function_response.name: Name cannot be empty.\\\\n\\",\\n    \\"status\\": \\"INVALID_ARGUMENT\\"\\n  }\\n}\\n","code":400,"status":"Bad Request"}}',
	};

	const out = toFailoverRetryMessage(google400);
	assert.ok(out, "Google 400 function_response.name error must be rewritten for failover");
	assert.match(errMsg(out), /429 tool schema/);

	const models: any[] = [
		{ provider: "google", id: "gemini-3.1-flash-lite-preview", name: "Gemini Lite", reasoning: true, cost: { input: 0.5, output: 2 }, contextWindow: 200000 },
		{ provider: "google", id: "gemini-4-argon", name: "Gemini 4", reasoning: true, cost: { input: 2, output: 10 }, contextWindow: 200000 },
	];
	const ctx = makeCtx(models);
	const rewritten = (
		await handlers.message_end[0]({ message: google400 }, { model: { provider: "auto", id: "auto" } })
	).message;

	const r = await vm.route(
		{
			reason: "retry",
			thinkingLevel: "xhigh",
			failed: { model: models[0], thinkingLevel: "medium", message: rewritten },
			messages: [{ role: "user", content: "ok" }],
			state: undefined,
		},
		ctx,
	);
	assert.ok(r.state.avoid.includes("google/gemini-3.1-flash-lite-preview"));
	assert.ok(!r.state.avoid.includes("google"), "must not avoid the whole provider on a tool schema 400");
});

test("mimo-v2.6 models are excluded from candidates", async () => {
	const { vm } = loadRouter();
	const models: any[] = [
		{ provider: "opencode-go", id: "mimo-v2.6-flash", name: "MiMo v2.6 Flash", reasoning: true, cost: { input: 0.2, output: 1 }, contextWindow: 200000 },
		{ provider: "opencode-go", id: "qwen3.8-flash", name: "Qwen 3.8 Flash", reasoning: true, cost: { input: 0.5, output: 2 }, contextWindow: 200000 },
	];
	const ctx = makeCtx(models);

	const r = await vm.route(
		{
			reason: "user",
			thinkingLevel: "low",
			messages: [{ role: "user", content: "ok" }],
			state: undefined,
		},
		ctx,
	);
	assert.equal(r.model.id, "qwen3.8-flash", "mimo-v2.6-flash must be excluded");
});

