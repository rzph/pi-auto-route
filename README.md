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
   mots-clés (débogage, architecture, optimisation…), longueur du message,
   présence de code → un score continu de 0 à 1.
2. **Choix du palier** dans TON catalogue réel (découvert au runtime via
   `getAvailable()`, rien n'est codé en dur) :

   | Score | Palier | Thinking |
   |---|---|---|
   | ≥ 0.7 — archi, debug dur, gros code | le plus capable | `xhigh` |
   | ≥ 0.45 | fort | `high` |
   | ≥ 0.25 | standard | `medium` |
   | < 0.25 | léger | `low` |

3. **Une bascule maximum par tour** : le modèle de départ planifie et fait
   son premier `edit`/`write` ; ensuite le tour continue sur le modèle le
   plus léger. Le cache de prompt ne casse qu'une fois par tour.
4. **Compaction et résumés invisibles** partent systématiquement sur le
   modèle le plus léger — la fuite de tokens que personne ne voit.

### Ce qui est exclu des candidats

- les modèles **gratuits** (quota/timeout : sources de tours ratés) ;
- les modèles **non-reasoning** ;
- tout modèle dont le provider n'a pas de credentials valides.

Le classement par capacité utilise le **coût de sortie** comme proxy (à coût
égal, le plus grand contextWindow gagne). Si un palier est vide, repli
automatique sur le suivant ; si tout échoue, message explicite.

## Installation

```bash
# à la session :
pi -e /chemin/vers/auto-route.ts

# ou permanent :
pi --set-default-extension /chemin/vers/auto-route.ts   # vérifier la syntaxe : pi --help
```

Puis `/model` → **auto → auto** (affiché « Auto (routage + thinking auto) »).

## Personnaliser

Tout se règle en tête de fichier :

- `difficultyScore()` : l'heuristique (mots-clés, seuils de longueur) ;
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
