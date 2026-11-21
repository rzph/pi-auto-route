# auto-route — modèle virtuel d'économie de tokens pour pi

Un modèle virtuel qui route automatiquement **vers le bon modèle physique** et
**ajuste le niveau de thinking**, selon la difficulté estimée de chaque tour de
conversation. Pensé pour réduire la facture de tokens sans perte de
performance.

![status](https://img.shields.io/badge/harness-pi--coding--agent-blue)

> **⚠️ Spécifique à pi.** Cette extension utilise l'API d'extension de
> [pi (pi-coding-agent)](https://github.com/earendil-works/pi-coding-agent)
> (`pi.registerVirtualModel`, `ModelRegistry`). Elle n'est pas portable telle
> quelle sur Claude Code, Codex ou autres harness — voir
> [Portabilité](#portabilité) pour les équivalents.

## Ce que ça fait

Sélectionne **auto → auto** dans le sélecteur de modèles (`/model`). Ensuite,
à chaque tour :

1. **Estimation de difficulté** (heuristique locale, aucune API externe) :
   chemin/dépôt cité, verbes d'action (« reprend », « modifie », « trouve »…),
   intention (« je veux »), question conceptuelle, mots-clés (débogage,
   architecture…), longueur, code, pénalité copier-coller de terminal →
   un score continu de 0 à 1. Calibrée sur 880 tours réels (voir
   `heuristics.test.ts`) — chiffres à lire honnêtement :
   - messages du quartile le plus lourd envoyés en `eco` :
     **195/220 → 72/220** (le vrai gain : moins de sous-routage) ;
   - Spearman score↔outils : +0.16 → **+0.28** ;
   - accord quartile global : **30 % contre 25 % pour le hasard** — le
     score est un *parapluie asymétrique* (protège les messages lourds du
     palier `eco`, remonte les simples d'un cran au pire), pas un
     classifieur précis. Ne pas sur-estimer la prédiction fine.
2. **Choix du palier** dans TON catalogue réel (découvert au runtime via
   `getAvailable()`, rien n'est codé en dur) :

   | Score | Palier | Thinking |
   |---|---|---|
   | ≥ 0.7 — chantier lourd, signaux multiples | le plus capable | `xhigh` |
   | ≥ 0.5 | fort | `high` |
   | ≥ 0.3 | standard | `medium` |
   | < 0.3 — relances, questions courtes | léger | `low` |

3. **Une bascule maximum par tour** : le modèle de départ planifie et fait
   son premier `edit`/`write` ; ensuite le tour continue sur le modèle le
   plus léger. Le cache de prompt ne casse qu'une fois par tour.
4. **Compaction et résumés invisibles** partent systématiquement sur le
   modèle le plus léger — la fuite de tokens que personne ne voit.

### Ce qui est exclu des candidats

- les modèles **gratuits** (quota/timeout : sources de tours ratés) ;
- les modèles **non-reasoning** ;
- tout modèle dont le provider n'a pas de credentials valides ;
- les modèles **`contributor`** (endpoints OpenCode qui entraînent sur tes
  requêtes) ;
- les générations retirées ou dépréciées : `gemini-2.5-*` (404 Google),
  `mimo-v2.5` (410 OpenCode) ;
- les modèles spécialisés non-code (`computer-use`, `robotics`,
  `deep-research`) ;
- tout modèle inscrit dans `~/.pi/agent/auto-route-denylist.json` —
  banni automatiquement et **persistemment** dès qu'il renvoie une erreur
  définitive (400/404/410, « trains on request data », région non
  autorisée…). Supprime une entrée du fichier pour rétablir un modèle.

Le classement par capacité utilise le **coût de sortie** comme proxy (à coût
égal, le plus grand contextWindow gagne). Si un palier est vide, repli
automatique sur le suivant ; si tout échoue, message explicite.

## Installation

```bash
# à la session :
pi -e /chemin/vers/auto-route.ts

# ou permanent (chargé automatiquement au démarrage de pi) :
cp /chemin/vers/auto-route.ts ~/.pi/agent/extensions/auto-route.ts
```

Puis `/model` → **auto → auto** (affiché « Auto (routage + thinking auto) »).

## Personnaliser

Tout se règle en tête de fichier :

- `difficultyScore()` : l'heuristique (signaux + seuils de longueur) —
  chaque signal est un bout de regex commenté ; recalibre et relance
  `node --test heuristics.test.ts` après modification ;
- `tierAndThinking()` : la correspondance score → palier + thinking ;
- le filtre de `candidateModels()` si tu veux réintégrer les modèles
  gratuits ou non-reasoning.

Pour forcer ponctuellement un modèle précis : bascule sur un vrai modèle via
`/model`, puis reviens sur `auto` au tour suivant.

## Portabilité

| Harness | État | Équivalent |
|---|---|---|
| **pi** | ✅ supporté (cette extension) | — |
| Claude Code | ❌ non portable | idées proches : `jev-router` (gargpratyush), skills « model-router » — mécaniques internes Claude Code |
| Codex | ❌ non portable | `jev-codex-router` (0xNatoshi) : modèle + thinking par tour |
| Hermes | ❌ non portable | `hermes-jev-skills` (kerpopule) |

L'idée (planifier fort, exécuter léger, une bascule par tour, compaction
dégénérée sur un modèle léger) est portable partout ; l'implémentation ici
est liée à pi. Si tu veux un port pour un autre harness, ouvre une issue.

## Concepts clés

- **Prompt cache** : le routage bascule *une fois* par tour, après la
  planification — chaque bascule inter-provider invalide le cache, donc
  l'arbitrage favorise les tours à plusieurs appels d'outils.
- **État de route** : stocké sur la branche de session par pi ; il suit
  l'arbre de session et survit à la compaction.
- **Proxy de capacité** : le coût de sortie sert de classeur faute de
  benchmark par tâche. Des données de benchmark maison (taux de détection du
  reviewer, par exemple) sont une extension naturelle.

## Licence

MIT — voir [LICENSE](LICENSE).
