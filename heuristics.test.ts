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

test("tierAndThinking applies the 0.30 / 0.60 / 0.75 thresholds", () => {
	assert.deepEqual(tierAndThinking(0.1), { tier: "eco", thinking: "low" });
	assert.deepEqual(tierAndThinking(0.29), { tier: "eco", thinking: "low" });
	assert.deepEqual(tierAndThinking(0.3), { tier: "standard", thinking: "medium" });
	assert.deepEqual(tierAndThinking(0.49), { tier: "standard", thinking: "medium" });
	assert.deepEqual(tierAndThinking(0.59), { tier: "standard", thinking: "medium" });
	assert.deepEqual(tierAndThinking(0.6), { tier: "strong", thinking: "high" });
	assert.deepEqual(tierAndThinking(0.74), { tier: "strong", thinking: "high" });
	assert.deepEqual(tierAndThinking(0.75), { tier: "frontier", thinking: "xhigh" });
	assert.deepEqual(tierAndThinking(1), { tier: "frontier", thinking: "xhigh" });
});

test("colloquial imperatives are recognised as work requests", () => {
	// "fais le portage français" drove 49 tool calls / 82k output tokens yet
	// scored 0.10 before the ACTION regex learned the spoken imperatives.
	for (const msg of [
		"fais le portage français",
		"regarde ce qui se passe dans le panel d'à côté",
		"prends le fichier et mets-le à jour",
		"lance le build et dis-moi si ça passe",
	]) {
		const s = difficultyScore(msg);
		assert.ok(s >= 0.3, `${JSON.stringify(msg)} scored ${s}, expected ≥ 0.30`);
	}
});

test("a path plus a plain verb no longer reaches an expensive tier", () => {
	// Regression guard for the over-provisioning fix: this is a routine fix.
	const s = difficultyScore("corrige le bug dans src/foo.ts");
	assert.ok(s < 0.6, `score ${s} expected < 0.60 (would reach strong)`);
});

test("English work requests now rise through the bilingual ACTION regex", () => {
	const s = difficultyScore("make a french port of this module and fix the tests");
	assert.ok(s >= 0.3, `score ${s} expected ≥ 0.30`);
});

test("an explicit English refactor request reaches at least standard", () => {
	const s = difficultyScore("refactor the authentication module and add unit tests for it");
	assert.ok(s >= 0.5, `score ${s} expected ≥ 0.50`);
});

test("an English conceptual question rises above a plain follow-up", () => {
	const q = difficultyScore("why does this test fail?");
	const plain = difficultyScore("ok");
	assert.ok(q > plain, `question ${q} > follow-up ${plain}`);
});

test("a plain English routine fix stays below strong", () => {
	// English twin of the French over-provisioning guard above.
	const s = difficultyScore("fix the bug in src/foo.ts");
	assert.ok(s < 0.6, `score ${s} expected < 0.60 (would reach strong)`);
});

test("language parity: the same routine fix scores identically in French and English", () => {
	// The pathy and ACTION bumps must fire with the same weight whatever the
	// language, otherwise one language is systematically over-provisioned.
	const fr = difficultyScore("corrige le bug dans src/foo.ts");
	const en = difficultyScore("fix the bug in src/foo.ts");
	assert.equal(fr, en, `French ${fr} must equal English ${en}`);
});
