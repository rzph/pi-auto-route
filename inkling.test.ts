/**
 * Tests for the Inkling local router: the prompt gate, and the state machine
 * that owns the model/tool switches (the parts that broke at runtime before
 * ever reaching a type check).
 *
 * Run with:  node --test inkling.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// The module reads its config at import time: point it at a test port and keep
// the readiness loop short enough that a stray poll cannot hang the run.
process.env.INKLING_PORT = "8"; // nothing listens on a reserved port
process.env.INKLING_READY_TIMEOUT_MS = "200";

const { default: inklingRouter, isSimplePrompt } = await import("./inkling/inkling-auto-router.ts");

// --- Fakes -------------------------------------------------------------------

const INKLING = { provider: "inkling-local", id: "inkling-2-mini-iq1m" };
const REMOTE = { provider: "opencode-go", id: "gemini-4-argon" };
const GOOGLE = { provider: "google", id: "gemini-4-hydrogen" };
const ALL_TOOLS = ["read", "bash", "edit", "write"];

/**
 * A fake pi that behaves like the real one on the point that matters: setModel
 * emits model_select with the previous model, for a manual pick and for an
 * extension call alike.
 */
function fakePi() {
	const handlers: Record<string, Array<(e: any, c: any) => Promise<unknown>>> = {};
	const commands: Record<string, (args: string, ctx: FakeCtx) => Promise<unknown>> = {};
	const state = {
		model: REMOTE as { provider: string; id: string },
		tools: [...ALL_TOOLS],
		execs: [] as string[][],
		notices: [] as string[],
		/** scripted answers for /health, last one repeats */
		health: [503] as number[],
	};
	const pi = {
		on(event: string, fn: (e: any, c: any) => Promise<unknown>) {
			(handlers[event] ||= []).push(fn);
		},
		registerCommand(name: string, def: { handler: (args: string, ctx: FakeCtx) => Promise<unknown> }) {
			commands[name] = def.handler;
		},
		exec: async (command: string, args: string[]) => {
			state.execs.push([command, ...args]);
			return { stdout: "launched pid=4242", stderr: "", code: 0 };
		},
		setModel: async (model: { provider: string; id: string }) => {
			const previousModel = state.model;
			state.model = model;
			await fire("model_select", { model, previousModel, source: "set" });
			return true;
		},
		getSettings: () => ({ defaultProvider: REMOTE.provider, defaultModel: REMOTE.id }),
		getActiveTools: () => [...state.tools],
		setActiveTools: (tools: string[]) => {
			state.tools = [...tools];
		},
	};
	type FakeCtx = {
		ui: { notify: (msg: string, level?: string) => void };
		model: { provider: string; id: string };
		modelRegistry: { find: (p: string, id: string) => unknown };
		signal?: AbortSignal;
	};
	const ctx = (): FakeCtx => ({
		ui: { notify: (msg) => state.notices.push(msg) },
		get model() {
			return state.model;
		},
		modelRegistry: {
			find: (provider, id) =>
				[INKLING, REMOTE, GOOGLE].find((m) => m.provider === provider && m.id === id),
		},
	});
	const fire = async (event: string, payload: Record<string, unknown>, c = ctx()) => {
		for (const fn of handlers[event] || []) await fn({ type: event, ...payload }, c);
	};
	inklingRouter(pi as never);
	return { pi, ctx, commands, handlers, fire, state };
}

/** fetch stub: /health answers from the scripted code list, the last one repeating. */
function stubHealth(state: { health: number[] }) {
	const real = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async () => {
		const code = state.health[Math.min(calls++, state.health.length - 1)];
		if (code === 0) throw new TypeError("connection refused");
		return { ok: code === 200, status: code } as Response;
	}) as typeof fetch;
	return () => {
		globalThis.fetch = real;
		calls = 0;
	};
}

const userTurn = (prompt: string) => ({ messageType: "user", prompt, systemPrompt: "" }) as never;

// --- Prompt gate -------------------------------------------------------------

test("greetings and short questions are local material", () => {
	for (const p of ["bonjour", "combien font 2+2 ?", "c'est quoi un mutex ?", "what's the capital of France?"]) {
		assert.ok(isSimplePrompt(p), `expected simple: ${p}`);
	}
});

test("empty input and slash commands never route", () => {
	assert.equal(isSimplePrompt(""), false);
	assert.equal(isSimplePrompt("   "), false);
	assert.equal(isSimplePrompt("/model"), false);
	assert.equal(isSimplePrompt("/inkling stop"), false);
});

test("anything tool-shaped stays on the cloud model", () => {
	for (const p of [
		"lis le fichier README.md",
		"corrige le bug dans /home/rzph/projet/src/main.ts",
		"```js\nconsole.log(1)\n```",
		"run the tests",
		"je veux un JSON avec { \"a\": 1 }",
		"git commit puis push",
		"analyse ce script shell",
	]) {
		assert.equal(isSimplePrompt(p), false, `expected not simple: ${p}`);
	}
});

test("length cap", () => {
	assert.ok(isSimplePrompt("a".repeat(299)));
	assert.equal(isSimplePrompt("a".repeat(301)), false);
});

// --- Routing state machine ---------------------------------------------------

test("a simple prompt routes to Inkling with no tools, and the session is handed back", async () => {
	const { fire, state } = fakePi();
	state.health = [200];
	const restore = stubHealth(state);
	try {
		await fire("session_start", {});
		await fire("before_agent_start", userTurn("bonjour"));
		assert.deepEqual(state.model, INKLING, "the local model answers the simple turn");
		assert.deepEqual(state.tools, [], "the tool prompt must not be sent: it exceeds 4096 tokens");

		await fire("agent_settled", {});
		assert.deepEqual(state.model, REMOTE, "the session goes back on its own");
		assert.deepEqual(state.tools, ALL_TOOLS, "and keeps its tools");
	} finally {
		restore();
	}
});

test("a complex prompt is never routed, and cancels an earlier local routing", async () => {
	const { fire, state } = fakePi();
	state.health = [200];
	const restore = stubHealth(state);
	try {
		await fire("session_start", {});
		await fire("before_agent_start", userTurn("reprends le projet et corrige le build"));
		assert.deepEqual(state.model, REMOTE);
		assert.deepEqual(state.tools, ALL_TOOLS);

		await fire("before_agent_start", userTurn("bonjour"));
		await fire("before_agent_start", userTurn("maintenant patch le fichier de config"));
		assert.deepEqual(state.model, REMOTE, "the follow-up leaves Inkling before the turn runs");
		assert.deepEqual(state.tools, ALL_TOOLS);
	} finally {
		restore();
	}
});

test("a cold server is warmed up in the background, without moving the current turn", async () => {
	const { fire, state } = fakePi();
	state.health = [0]; // cold: nothing listens
	const restore = stubHealth(state);
	try {
		await fire("session_start", {});
		await fire("before_agent_start", userTurn("bonjour"));
		assert.deepEqual(state.model, REMOTE, "the turn is not stalled by a model load of ~2 min");
		assert.deepEqual(state.tools, ALL_TOOLS);
		await new Promise((r) => setTimeout(r, 50)); // the launch is fire-and-forget
		assert.equal(state.execs.length, 1, "the start script was invoked once");
		assert.match(state.execs[0].join(" "), /start-inkling-server\.sh/);

		// warm now: the NEXT simple prompt is the one that goes local
		state.health = [200];
		await fire("before_agent_start", userTurn("merci"));
		assert.deepEqual(state.model, INKLING);
	} finally {
		restore();
	}
});

test("a manual pick of Inkling keeps the session, but still strips the tools", async () => {
	const { pi, fire, state } = fakePi();
	state.health = [200];
	const restore = stubHealth(state);
	try {
		await fire("session_start", {});
		await pi.setModel(INKLING); // /model → Inkling
		assert.deepEqual(state.tools, [], "the tools never fit this model");

		await fire("before_agent_start", userTurn("reprends le projet et corrige le build"));
		assert.deepEqual(state.model, INKLING, "a deliberate selection is not overridden");

		await pi.setModel(REMOTE);
		assert.deepEqual(state.tools, ALL_TOOLS, "leaving Inkling by hand restores the tools");
	} finally {
		restore();
	}
});

test("the tool set is restored even when the user switches models mid-flight", async () => {
	const { pi, fire, state } = fakePi();
	state.health = [200];
	const restore = stubHealth(state);
	try {
		await fire("session_start", {});
		await fire("before_agent_start", userTurn("bonjour"));
		assert.deepEqual(state.tools, []);
		await pi.setModel(GOOGLE); // manual escape hatch
		assert.deepEqual(state.model, GOOGLE);
		assert.deepEqual(
			state.tools,
			ALL_TOOLS,
			"a switch captured while the tools were stripped must not stick",
		);
		await fire("agent_settled", {}); // no-op, must not clobber the manual choice
		assert.deepEqual(state.model, GOOGLE);
	} finally {
		restore();
	}
});

test("/inkling stop runs the stop script; a server we did not start survives the session", async () => {
	const { commands, fire, state } = fakePi();
	state.health = [0];
	const restore = stubHealth(state);
	try {
		await fire("session_start", {});
		await fire("session_shutdown", { reason: "quit" });
		assert.equal(state.execs.length, 0, "an externally started server is not killed on exit");

		await commands.inkling("stop", ctxOf({ state }));
		assert.match(state.execs.at(-1)?.join(" ") ?? "", /stop-inkling-server\.sh/);
	} finally {
		restore();
	}
});

test("reloading a session does not kill the server", async () => {
	const { fire, state } = fakePi();
	state.health = [0];
	const restore = stubHealth(state);
	try {
		await fire("session_start", {});
		await fire("before_agent_start", userTurn("bonjour")); // this extension starts the server
		assert.equal(state.execs.length, 1);
		await fire("session_shutdown", { reason: "reload" });
		assert.equal(state.execs.length, 1, "pi is coming back, the 2-minute load stays paid for");
	} finally {
		restore();
	}
});

function ctxOf(_deps: { state: unknown }) {
	return {
		ui: { notify: () => {} },
		model: REMOTE,
		modelRegistry: { find: () => INKLING },
	} as never;
}
