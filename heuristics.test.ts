/**
 * Tests for the difficulty heuristic (calibrated on 880 real turns, 2026-11-21).
 *
 * Run with:  node --test heuristics.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { difficultyScore, tierAndThinking } from "./auto-route.ts";

test("short follow-ups and neutral messages stay in the lightest tier", () => {
	assert.equal(difficultyScore("ok"), 0.1);
	assert.equal(difficultyScore("vas-y"), 0.1);
	assert.equal(difficultyScore("non merci"), 0.1);
});

test("work request on an existing codebase scores higher (old false negative: 134 tool calls at 0.15)", () => {
	const s = difficultyScore(
		"reprend le projet /home/rzph/devine-les-paroles-multi et /home/rzph/devine-les-paroles, je veux que ça soit un vrai jeu",
	);
	assert.ok(s >= 0.55, `score ${s} expected ≥ 0.55`);
});

test("search without a path still rises via the action verb (old false negative: 59 tool calls at 0.10)", () => {
	const s = difficultyScore(
		"trouve les adresses précises a partir de documentations et autres projets sur internet",
	);
	assert.ok(s >= 0.3, `score ${s} expected ≥ 0.30`);
});

test("explicit intent plus path: TD correction message (old false negative at 0.10)", () => {
	const s = difficultyScore(
		"dans /data/cours_A2/mecfluides/ prend les documents en mémoire et fais la correction détaillée de l'exercice",
	);
	assert.ok(s >= 0.35, `score ${s} expected ≥ 0.35`);
});

test("terminal paste: form is not difficulty (old false positive at 0.60)", () => {
	const s = difficultyScore(
		"$ sudo modprobe ec_sys write_support=1\n$ cat /sys/kernel/debug/ec/ec0/io/data\n$ echo 1 > /tmp/x\n$ ls -la /dev/ec0",
	);
	assert.ok(s <= 0.45, `score ${s} expected ≤ 0.45`);
});

test("conceptual question rises above a plain follow-up", () => {
	const q = difficultyScore("pourquoi mon patch n'applique-t-il pas le diff ?");
	const plain = difficultyScore("ok");
	assert.ok(q > plain, `question ${q} > follow-up ${plain}`);
});

test("monotonicity: a heavy project always scores above a follow-up", () => {
	const hard = difficultyScore(
		"regarde l'état du programme et modifie la fiabilité de la sécurité, je veux pas mettre en danger les joueurs",
	);
	const easy = difficultyScore("ok continue");
	assert.ok(hard > easy, `${hard} > ${easy}`);
});

test("tierAndThinking applies the calibrated 0.30 / 0.50 / 0.70 thresholds", () => {
	assert.deepEqual(tierAndThinking(0.1), { tier: "eco", thinking: "low" });
	assert.deepEqual(tierAndThinking(0.29), { tier: "eco", thinking: "low" });
	assert.deepEqual(tierAndThinking(0.3), { tier: "standard", thinking: "medium" });
	assert.deepEqual(tierAndThinking(0.49), { tier: "standard", thinking: "medium" });
	assert.deepEqual(tierAndThinking(0.5), { tier: "strong", thinking: "high" });
	assert.deepEqual(tierAndThinking(0.69), { tier: "strong", thinking: "high" });
	assert.deepEqual(tierAndThinking(0.7), { tier: "frontier", thinking: "xhigh" });
	assert.deepEqual(tierAndThinking(1), { tier: "frontier", thinking: "xhigh" });
});
