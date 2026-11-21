# Recherche : routeurs de modèles existants pour Pi

Date : 2026-11-21
Repo : /home/rzph/pi-auto-route
Question : existe-t-il déjà un routeur gratuit pour Pi qui choisit le modèle physique et le niveau de thinking en fonction de la requête ?

## Réponse courte

**Oui — il existe au moins 7 routeurs publics et 3 paquets npm.** Certains font exactement ce que fait `auto-route`, et `beettlle/pi-smart-router` fait même mieux sur le point du cache prompt.

La niche réellement vide n'est pas « un routeur » : c'est **un routeur zéro-config, sans classifieur, sans clé API, sans fichier de configuration**.

## Méthodologie

Sources primaires :
1. Extensions locales et packages npm installés par Pi.
2. Exemples officiels de Pi (`examples/extensions/`).
3. `gh search repos` avec plusieurs requêtes, puis `gh api repos/<repo>/readme` pour chaque résultat.
4. `npm search pi-router --json`.

Chaque affirmation ci-dessous provient du README ou de l'API GitHub du dépôt concerné.

## Résultats

### 1. Exemple officiel de Pi

`examples/extensions/jev-router.ts` — le seul routeur fourni par Pi.

- Enregistre `jev/auto`.
- Choisit un modèle de planification via le classifieur Jev de TypeSafe.
- Bascule vers un modèle bon marché après la première `edit`/`write`.
- **Nécessite** `TYPESAFE_API_KEY` **et** un login OpenAI Codex.
- **Ne choisit pas le thinking level** : il le passe tel quel.
- Limite : 3 modèles OpenAI Codex codés en dur.

### 2. Routeurs publics trouvés sur GitHub

| Dépôt | ⭐ | Licence | Dernier push | Approche | Gratuit ? | Thinking ? |
|---|---|---|---|---|---|---|
| `jiangge/pi-router` | 8 | MIT | 2026-11-15 | Routeur de canaux 2 niveaux + chaîne de repli, « zero protocol coupling » | Oui | Non — ne traite pas la difficulté |
| `beettlle/pi-smart-router` | 6 | — | **2026-11-21** | Pipeline **12 étapes** : hardware probe, scan de mots-clés Aho-Corasick, context-fit, session pin, embeddings HyDRA, modèle local | **Partiellement** — les étapes déterministes sont gratuites et locales | Non déclaré |
| `priaculun/ontoken-auto` | 1 | MIT | 2026-10-27 | Jev classe le prompt, route les modèles OnToken | Non (Jev) | Non |
| `lszhe/pi-tier-router` | 0 | NOASSERTION | 2026-10-03 | **Paliers de difficulté configurables**, classifieur, stratégie de thinking par palier | Non (classifieur requis) | **Oui** |
| `joslynSmall/pi-gear-router` | 0 | MIT | 2026-10-11 | 2 phases (light / standard / heavy), Jev évalue à l'entrée de phase | Non (TypeSafe requis) | **Oui** |
| `1yian/pi-tiers` | 0 | MIT | **2026-11-20** | Paliers de travail + **quota en direct** + failover entre comptes + classifieur | Non (classifieur requis) | **Oui** (`provider/model:thinking`) |
| `zereight/pi-zereight-router` | 0 | MIT | 2026-10-08 | Jev route vers Sonnet / Composer / GLM Flash | Non (Jev) | Non |

### 3. Paquets npm

| Paquet | Version | Description |
|---|---|---|
| `pi-router` (jiangge) | 0.6.2 | Routage multi-niveaux, failover, coupe-circuit, observabilité |
| `pi-router-pintar` | 0.17.3 | Fork de `beettlle/pi-smart-router` |
| `@vayliai/pi-router` | 0.1.0-staging.0 | Routage géré, preview macOS Apple Silicon |

### 4. Détails qui comptent

**`beettlle/pi-smart-router`** — le plus abouti, et le plus proche de ta réflexion sur le cache :

> « Cache-aware with session pinning to preserve prompt-cache economics »
> « **Rejected:** … turn-by-turn dynamic routing (cache destruction) »

Il contient explicitement le garde-fou que je t'ai proposé plus tôt. Son pipeline inclut aussi :

| Étape | Budget | Rôle |
|---|---|---|
| Turn Envelope | < 2 ms | Classe le type de tour (tool_result, planning, subagent, main_loop) |
| Session Pin | < 1 ms | Renvoie le modèle épinglé, casse l'épingle sur compaction |
| Deterministic Triage | < 5 ms | Scan Aho-Corasick + analyse de complexité cyclomatique |
| Local Zero-Tier | < 15 ms | Ping LM Studio + Ollama en parallèle |

**`lszhe/pi-tier-router`** — le plus proche du concept d'`auto-route` :

> « 用户自定义难度档位及数量，自动选择规划模型，首次成功编辑后切换实施模型。分类器（包括不同 Provider 的 Jev）、每档聊天模型、实施模型和**思考策略**均可配置。 »

Paliers de difficulté personnalisables, choix automatique du modèle de planification, bascule après la première édition, et **stratégie de thinking configurable par palier**. Installeable via `pi install git:github.com/lszhe/pi-tier-router@v0.1.0`, avec `/tier-router configure`.

**`1yian/pi-tiers`** — le plus sophistiqué côté exploitation : quota en direct par provider, cooldowns partagés entre processus, failover entre comptes, préférence abonnement sur pay-per-token, règles par dépôt git.

## Analyse comparative

| Critère | **auto-route** | `pi-smart-router` | `pi-tier-router` | `pi-gear-router` | `pi-tiers` |
|---|---|---|---|---|---|
| Choix du modèle | Oui, 4 paliers | Oui, 3 paliers | Oui, N paliers | Oui, 3 paliers | Oui, paliers |
| Choix du thinking | Oui | Non déclaré | **Oui** | **Oui** | **Oui** |
| Gratuit (sans clé) | **Oui** | Partiellement | Non | Non | Non |
| Sans classifieur | **Oui** | **Oui** (défaut) | Non | Non | Non |
| Sans fichier de config | **Oui** | Oui (registry) | Non (`/configure`) | Non (`settings.json`) | Non (`tiers.json`) |
| Sans appel réseau | **Oui** | Oui (étapes déterministes) | Non | Non | Non |
| Cache-aware | Non | **Oui** (session pin) | Bascule unique par tour | Stabilité par phase | Épinglé par session |
| Modèles locaux (Ollama…) | Non | **Oui** | Non | Non | Non |
| Quota en direct | Non | Non | Non | Non | **Oui** |
| Support langues | **Français uniquement** | Agnostique | Agnostique | Agnostique | Agnostique |
| Dépendances | **Aucune** | ONNX embeddings (optionnel) | Peers | TypeSafe SDK non requis | Aucune |
| Taille | ~500 lignes | Pipeline 12 étapes | Package complet | Package complet | Package complet |

## Ce qui est réellement unique dans `auto-route`

1. **Zéro configuration.** Aucun fichier à écrire, aucun classifieur à choisir, aucune clé supplémentaire. `pi install` puis `/model` → `auto`.
2. **Aucune dépendance réseau** dans le routage. Les autres appellent Jev, sauf `pi-smart-router` dont le chemin déterministe est aussi local.
3. **Lisibilité.** Environ 500 lignes contre un pipeline à 12 étapes avec embeddings ONNX.

## Ce qui manque à `auto-route`

1. **Le cache prompt.** `pi-smart-router` épingle la session pour préserver l'économie de cache et refuse explicitement le routage tour par tour. `auto-route` bascule une fois par tour mais ne protège pas la session.
2. **La langue.** L'heuristique est en français. Tous les concurrents sont agnostiques.
3. **Les modèles locaux.** Aucun support d'Ollama / LM Studio.
4. **Le quota en direct.** Rien de comparable à `pi-tiers`.

## Conclusion

**La prémisse « je suis le premier à faire ça » est fausse.** Sept routeurs publics existent déjà, trois choisissent le thinking level, et le plus abouti (`pi-smart-router`, 6 étoiles, actif aujourd'hui) traite déjà la question du cache prompt que `auto-route` ignore.

La position défendable qui reste est plus étroite mais réelle : **le routeur qui marche sans rien configurer, sans clé, sans réseau, en 500 lignes lisibles.** C'est une niche de simplicité, pas d'innovation fonctionnelle.
