/**
 * Tests for the provider-quota 429 failover and the default thinking of `auto`.
 *
 * Run with:  node --test failover.test.ts
 *
 * HOME is redirected to a temp directory BEFORE the module loads: the persistent
 * denylist (~/.pi/agent/auto-route-denylist.json) stays isolated from real data.
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
	assert.match(out.errorMessage, /429/, "the rewritten text must carry pi's retryable \"429\" pattern");
	for (const marker of PI_NON_RETRYABLE_MARKERS) {
		assert.ok(
			!out.errorMessage.includes(marker),
			`the rewritten text must not contain "${marker}"`,
		);
	}
	assert.equal(out.provider, "opencode-go", "the failing physical model stays identified");
	assert.equal(out.model, "glm-5.3");
});

test("a Google quota/billing 429 is rewritten too", () => {
	const google: any = {
		...QUOTA_ERROR,
		provider: "google",
		model: "gemini-4-argon",
		errorMessage:
			'{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}',
	};
	const out = toFailoverRetryMessage(google);
	assert.ok(out, "the Google 429 must be rewritten");
	assert.match(out.errorMessage, /429/);
	assert.ok(!/billing|quota exceeded/i.test(out.errorMessage));
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
	const ctx: any = {
		modelRegistry: {
			getAvailable: () => models,
			find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
		},
		ui: { setStatus: () => {} },
	};

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
	assert.ok(r.state.avoid.includes("opencode-go/glm-5.3"), "the failing model is avoided");
	assert.ok(!r.state.avoid.includes("opencode-go"), "the whole provider is not avoided");
	assert.notEqual(r.model.id, "glm-5.3");
});
