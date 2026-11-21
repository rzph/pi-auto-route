/**
 * Tests de l'heuristique de difficulté (calibrée sur 880 tours réels, 2026-11-21).
 *
 * Lancer avec :  node --test heuristics.test.ts
 * (Node ≥ 22.6 strip-types, ou Node ≥ 23.6 sans flag)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { difficultyScore, tierAndThinking } from "./auto-route.ts";

test("relances courtes et messages neutres restent au palier le plus léger", () => {
	assert.equal(difficultyScore("ok"), 0.1);
	assert.equal(difficultyScore("vas-y"), 0.1);
	assert.equal(difficultyScore("non merci"), 0.1);
});

test("demande de travail sur un codebase existant remonte (ancien faux négatif : 134 outils à 0.15)", () => {
	const s = difficultyScore(
		"reprend le projet /home/rzph/devine-les-paroles-multi et /home/rzph/devine-les-paroles, je veux que ça soit un vrai jeu",
	);
	assert.ok(s >= 0.55, `score ${s} attendu ≥ 0.55`);
});

test("recherche sans chemin remonte via le verbe d'action (ancien faux négatif : 59 outils à 0.10)", () => {
	const s = difficultyScore(
		"trouve les adresses précises a partir de documentations et autres projets sur internet",
	);
	assert.ok(s >= 0.3, `score ${s} attendu ≥ 0.30`);
});

test("intention explicite + chemin : message de correction de TD (ancien faux négatif à 0.10)", () => {
	const s = difficultyScore(
		"dans /data/cours_A2/mecfluides/ prend les documents en mémoire et fais la correction détaillée de l'exercice",
	);
	assert.ok(s >= 0.35, `score ${s} attendu ≥ 0.35`);
});

test("copier-coller de terminal : la forme ne fait pas la difficulté (ancien faux positif à 0.60)", () => {
	const s = difficultyScore(
		"$ sudo modprobe ec_sys write_support=1\n$ cat /sys/kernel/debug/ec/ec0/io/data\n$ echo 1 > /tmp/x\n$ ls -la /dev/ec0",
	);
	assert.ok(s <= 0.45, `score ${s} attendu ≤ 0.45`);
});

test("question conceptuelle remonte au-dessus de la relance", () => {
	const q = difficultyScore("pourquoi mon patch n'applique-t-il pas le diff ?");
	const plain = difficultyScore("ok");
	assert.ok(q > plain, `question ${q} > relance ${plain}`);
});

test("monotonie : un chantier lourd score toujours plus qu'une relance", () => {
	const hard = difficultyScore(
		"regarde l'état du programme et modifie la fiabilité de la sécurité, je veux pas mettre en danger les joueurs",
	);
	const easy = difficultyScore("ok continue");
	assert.ok(hard > easy, `${hard} > ${easy}`);
});

test("tierAndThinking applique les seuils calibrés 0.30 / 0.50 / 0.70", () => {
	assert.deepEqual(tierAndThinking(0.1), { tier: "eco", thinking: "low" });
	assert.deepEqual(tierAndThinking(0.29), { tier: "eco", thinking: "low" });
	assert.deepEqual(tierAndThinking(0.3), { tier: "standard", thinking: "medium" });
	assert.deepEqual(tierAndThinking(0.49), { tier: "standard", thinking: "medium" });
	assert.deepEqual(tierAndThinking(0.5), { tier: "strong", thinking: "high" });
	assert.deepEqual(tierAndThinking(0.69), { tier: "strong", thinking: "high" });
	assert.deepEqual(tierAndThinking(0.7), { tier: "frontier", thinking: "xhigh" });
	assert.deepEqual(tierAndThinking(1), { tier: "frontier", thinking: "xhigh" });
});
