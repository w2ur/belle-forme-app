---
name: "Belle Forme"
tagline_fr: "Coach virtuel, sueur réelle."
tagline_en: "A virtual coach. Real sweat."
---

# Belle Forme

Héberger ta propre copie / self-hosting your own copy (English, français) :

- [SELF-HOSTING-BEGINNER.md](SELF-HOSTING-BEGINNER.md) — pas à pas, pour qui n'a jamais ouvert un terminal : GitHub + Netlify + Neon, gratuit, sans Docker / step by step for someone who has never used a terminal, free, no Docker.
- [SELF-HOSTING.md](SELF-HOSTING.md) — avancé : Docker compose ou Node sous systemd derrière un reverse proxy, ou Netlify + Neon / advanced.

Démo / demo : données inventées, coach scripté, rien n'est envoyé à un serveur. `npm run build && npm start`, puis <http://127.0.0.1:8888/demo/> ; chaque déploiement la sert aussi sous `/demo/`.

App de suivi fitness personnel. Interface en français, pensée pour l'iPad 13" en séance — et utilisable sur téléphone.

## Stack

- **Vite + React 19** — SPA, pas de framework serveur
- **Tailwind CSS v4** — palette Wes Anderson (crème, blanc, bleu sourd)
- **@dnd-kit** — glisser-déposer pour réordonner, uniquement en séance (chargé à la demande)
- **Vitest** — tests unitaires (PGlite rejoue la sauvegarde SQL contre le vrai schéma)
- **Vite PWA** — application progressive installable
- **localStorage** — persistance côté client (cache rapide + fallback hors-ligne)
- **Neon Postgres** — base de données cloud (JSONB, free tier)
- **Netlify Functions** — API serverless pour la synchronisation
- **Netlify Edge Functions** — le chat du coach uniquement : une réponse streamée dépasse les 10 s qu'autorise une fonction classique
- **Netlify** — hébergement statique

## Fonctionnalités

- **Mode séance** — « Commencer » sur une séance du programme ouvre un vrai état d'entraînement en cours : un exercice à la fois, les valeurs prévues préremplies mais **jamais enregistrées avant validation**, le record de l'exercice affiché à côté, échauffement et retour au calme en cases à cocher, minuteur de repos en ligne (non bloquant) et écran maintenu allumé pendant toute la séance. La séance survit à un rechargement ou à un onglet fermé (carte « Reprendre »), et chaque exercice est enregistré avec son statut : fait, partiel ou passé. Une ligne « ensuite » annonce l'exercice suivant sans rien ouvrir, et le compteur « Exo 2/5 » déplie un sommaire de toute la séance — où un appui long réordonne ce qui reste, l'exercice en cours compris : le repousser plus loin quand le matériel est pris ne l'enregistre pas comme passé. Ce qui est déjà derrière est figé, parce que son statut est un fait que le coach lit.
- **Séances** — Saisie, historique, duplication, recherche. « Noter » prérremplit le formulaire pour une séance consignée après coup ; rien n'est enregistré sans confirmation.
- **Timer de repos** — Chronomètre configurable (30s–3min), alerte sonore + vibration, démarrage auto depuis le plan
- **Coach** — Chat en direct avec le coach dans l'app (ton direct et chaleureux, réponses en streaming). Deux modes de conversation — **Discussion** et **Mon programme** — et une seule action qui écrit un programme : le bouton « Plan », qui renvoie un programme hebdomadaire structuré (échauffement + retour au calme inclus), affiché en carte et importable en un clic. Pendant une séance, le coach est ancré à côté de l'entraînement (à partir de 1280px) et voit ce qui vient d'être fait, série par série.
- **Profil** — Infos personnelles, export SQL d'urgence, toutes les tables dont le catalogue et le coach (restauration manuelle via la console Neon)

## Deux mises en page

Le seuil est `lg` (1024px), choisi parce qu'un iPad 13" en plein écran fait ≥1024pt **dans les deux orientations** :

- **Sous `lg`** — colonne centrée (≤480px) et barre de navigation en bas (Séance / Coach / Exercices / Profil).
- **À partir de `lg`** — rail latéral fixe de 88px avec deux destinations (Séance, Coach) et un groupe secondaire séparé (Exercices, Timer, Profil) ; la barre du bas disparaît. Le contenu occupe toute la largeur, et le programme s'affiche sur deux colonnes.
- Le manifeste PWA est en `orientation: 'any'`, pas `portrait` : le coach s'ancre à côté de la séance en paysage, ce qu'un verrouillage portrait rendait inatteignable une fois l'app installée sur l'écran d'accueil.

## Coaching workflow

L'onglet Coach est un chat en direct avec le coach, directement dans l'app :

1. **Discuter** avec le coach dans l'onglet Coach — il voit les données actuelles (séances, profil, plan)
2. **Recevoir** des réponses en streaming, en français ; le coach se souvient du contexte via un carnet et l'historique de conversation côté serveur

La conversation est **une seule** pour toute l'app : un même objet est partagé par l'onglet Coach et le panneau ancré à la séance, et il vit au-dessus de la navigation — changer d'onglet pendant que le coach répond n'interrompt plus rien. Chaque échange est enregistré côté serveur **dès le premier caractère visible**, et la réponse est écrite **pendant** qu'elle arrive plutôt qu'à la fin : la fin est précisément ce sur quoi on ne peut pas compter. Le déclencheur a été « dès qu'un modèle a accepté la question » pendant un temps, et c'était un cran trop tôt : un modèle qui acceptait puis ne disait rien enregistrait sa question sans réponse, définitivement, et le coach relisait ces questions-là comme des questions ouvertes. Une réponse coupée — limite de longueur, connexion perdue, ou exécution interrompue par la plateforme — est gardée **et signalée** plutôt que perdue en silence. Une copie locale du fil sert de secours quand le réseau manque au chargement.
3. **Demander un programme** via le bouton « Plan » — la seule action qui en produit un. Le coach répond alors par un programme **structuré** : l'API du modèle (Anthropic ou Mistral) lui impose un schéma JSON (`src/lib/planSchema.js`) et en vérifie la forme, donc il n'écrit plus aucune syntaxe et ne peut plus casser un format qu'on ne lui demande plus de tenir. C'est ce qui a remplacé le bloc `=== FITTRACK PLAN ===` en texte brut : le 10/08/2026 la consigne « respecte le format » a été suivie d'une réponse qui le cassait dans un dialecte inédit
4. **Importer** le plan via le bouton « Importer ce programme », sous la carte qui affiche le programme reçu. Le carnet privé du coach voyage dans le même objet et n'est **jamais** affiché
5. **S'entraîner** via « Commencer » (mode séance : ce qui est enregistré est ce qui a été validé, série par série), ou **noter après coup** via « Noter », qui préremplit le formulaire sans rien enregistrer avant confirmation

**Deux modes, une action.** La conversation ordinaire (« Discussion ») et la conversation tenue devant le programme de la semaine (« Mon programme ») produisent toutes les deux du texte : ni l'une ni l'autre ne peut réécrire le programme, et le prompt qu'elles reçoivent ne contient même pas le format d'un programme. Seul le bouton « Plan » envoie la requête qui en produit un. Ce n'est pas une consigne mais une propriété : un modèle à qui on n'a jamais montré le format ne peut pas en émettre un par accident, là où la consigne « seulement quand elle le demande » a échoué en production.

**Les programmes déjà émis ne sont pas relus au modèle.** Dans l'historique qu'il reçoit, un programme stocké est remplacé par une ligne (« programme émis : 4 séances, semaine du 11/08 ») — parce que le format n'a jamais été appris du prompt mais de l'historique : 40 messages saturés de programmes suffisaient à le réinstaller. Rien n'est perdu, le programme **courant** est joint à chaque message de toute façon.

Le prompt du coach est assemblé côté serveur par `netlify/functions/lib/coachPrompt.js`, à partir du profil, du catalogue et du carnet stockés dans Neon.

## Validation des programmes

Un programme proposé par le coach est **validé par le code avant d'atteindre l'utilisatrice** — le prompt décrit les règles, la couche de validation les garantit. Point d'entrée unique : `evaluatePlanImport()` (`src/lib/planValidation.js`), appelée par le bouton « Importer ce programme » avec le payload JSON reçu du coach.

Le schéma garantit la **forme** et rien d'autre : lors du test qui l'a validé, le modèle a produit un programme parfaitement conforme dont les séances s'appelaient « (Lundi) » et « (Mercredi) ». Plafonds, liste noire, faisabilité à la maison et règles de séance restent donc entièrement du ressort des validateurs ci-dessous.

Une exception depuis le 16/08/2026 : le **nom d'un exercice est une énumération** construite à partir du catalogue (`buildPlanJsonSchema`), et non plus une chaîne libre. Le modèle décorait les noms qu'on lui demandait de reproduire à l'identique — « Gainage latéral » devenait « Gainage latéral jambe soulevée » — ce qui faisait rejeter tout le programme ; un nom qu'il ne peut pas écrire est un nom qu'il ne peut pas décorer. Les variantes passent par la note de progression.

- `src/constants/equipment.js` — l'inventaire physique réel (haltères, barres, disques, lests, élastiques, barre de traction) et les charges atteignables qui en sont **dérivées** (jamais écrites à la main). Il en dérive aussi les lieux possibles de chaque exercice (`maison` / `salle`).
- `src/lib/loadValidation.js` — par ligne : ce poids est-il physiquement chargeable, et sous le plafond de l'exercice ? Par séance : combien de réglages de barre différents faut-il ?
- `src/lib/planValidation.js` — les règles de domaine sur le programme complet : plafonds, exercices introuvables, échauffement et retour au calme à la maison (ni machine ni charge externe), exercices non réalisables à la maison, core un jour jambes, cardio mélangé à une séance de force, deux hauteurs de barre de traction dans la même séance, liste noire (exercices interdits, avec la raison et le remplacement).

**Le catalogue d'exercices est un document Neon, pas une constante.** `src/lib/catalog.js` (`buildCatalogViews`) le transforme en les vues que le reste de l'app consomme — noms, descriptions, plafonds, groupes musculaires — et c'est aussi là qu'habite la liste noire : `catalog.blacklist`, dérivée des exercices désactivés (`active: false`, avec une raison) **plus** un tableau `forbiddenNames` pour les mouvements interdits qui n'ont jamais été des exercices ici (« Hip thrust », faute de banc). L'ancienne constante `EXERCISE_BLACKLIST` n'existe plus nulle part dans le code : si une recherche du symbole ne trouve rien, ce n'est pas que le garde-fou a été supprimé, c'est qu'il vit maintenant dans le document. Le réintroduire comme constante recréerait exactement le problème que ce chantier a résolu — une deuxième source pour un document éditable, libre de diverger silencieusement de la première.

**Et l'utilisateur l'édite depuis le lexique.** Ajouter, modifier ou désactiver un exercice est envoyé comme une **opération** (`applyCatalogOps`), pas comme un document : le serveur (`PUT /api/sync-catalog`) n'accepte un document que s'il a été construit sur sa version courante (`updated_at`), sinon il répond 409 avec la sienne, et l'app rejoue l'opération dessus. Un iPad resté ouvert sur une vieille copie ne peut donc plus effacer les exercices ajoutés ailleurs entre-temps ; si l'opération ne s'applique plus (le même nom ajouté ailleurs, par exemple), elle est mise de côté avec « Le catalogue a changé ailleurs — ta modification n'a pas pu être appliquée. » et « Réessayer » la rejoue — sauf si elle a refait depuis une modification plus récente du même exercice, qui l'emporte : l'ancienne n'est alors pas renvoyée, et un message le dit. Le document est validé des deux côtés : `validateCatalogDoc` **bloque** ce qui casserait un consommateur (nom, groupe, façon de se charger, matériel, plafond, hauteur de barre, doublon, catalogue vide, alias cassé), `checkCatalogQuality` **avertit sans jamais bloquer** — la cohérence entre le texte français et le modèle de charge, qui ne gardait jusqu'ici que la photo figée dans `src/data/catalogSeed.json`. La dissymétrie est voulue : une fiche dont la prose contredit sa façon de se charger est une ligne qu'elle relit et corrige, un formulaire qui refuse d'enregistrer est un exercice qu'elle ne peut pas ajouter du tout. Renommer écrit l'alias et le nouveau nom **dans la même écriture** — le nom d'un exercice est la clé primaire de son historique — et le formulaire le dit avant de le faire, parce qu'un alias est définitif. Tant que le serveur n'a pas confirmé un renommage, le lexique montre déjà le nouveau nom mais son historique garde l'ancien — une séance notée ou un programme importé entre-temps est enregistré sous l'ancien nom aussi : il ne change qu'une fois l'alias confirmé, et un renommage refusé n'a donc rien à défaire.

Le prompt système est construit à partir du même document (`buildPromptInputs(catalog)` dans `netlify/functions/lib/coachPromptInputs.js`) : le catalogue envoyé au coach exclut automatiquement les exercices sur liste noire et ceux dont l'utilisateur n'a pas le matériel, et les règles de structure (4 exercices par séance de force en forme normale — davantage n'est qu'un avertissement, jamais un blocage —, core jamais un jour jambes, une seule configuration de barre, échauffement et retour au calme sans charge) y sont énoncées avec les valeurs que les validateurs appliquent — jamais recopiées à la main.

Deux niveaux, jamais confondus : une **erreur** bloque l'import (plafond dépassé, exercice sur liste noire, machine en échauffement) ; un **avertissement** le laisse passer avec la correction déjà appliquée (poids non réalisable arrondi à la valeur inférieure disponible, séance demandant plusieurs réglages de barre). L'app affiche toutes les erreurs, et tous les avertissements après un import réussi.

## Développement

```bash
npm install          # Installer les dépendances
npm run dev          # Serveur local (localhost:5173)
npm run build        # Build production → dist/, puis la démo statique → dist/demo/
npm run preview      # Prévisualisation du build
npm run test         # Lancer les tests
npm run test:watch   # Tests en mode watch
```

**Variables d'environnement :**
- `APP_PASSWORD_HASH` — hash SHA-256 du mot de passe d'accès (server-side uniquement ; comparé par la fonction `/api/login`). Jamais embarqué dans le bundle.
- `NEON_DATABASE_URL` — chaîne de connexion Neon Postgres (server-side, Netlify Functions uniquement)
- `SYNC_API_KEY` — clé de sync (server-side). Secret aléatoire indépendant, **le nôtre et non celui de Neon** : sa valeur est inventée, elle ne vient d'aucun fournisseur, et la faire tourner ne passe pas par la console Neon. La faire tourner renvoie chaque appareil à l'écran du mot de passe une fois (« La clé a changé »), sans rien effacer en local : les écritures en attente partent après la saisie. `/api/login` la renvoie au client uniquement après un mot de passe correct. Aucun secret n'est embarqué dans le bundle. (Elle s'appelait `NEON_API_KEY` jusqu'au 2026-08-15 — un nom qui la faisait passer pour une clé de compte Neon.)
- `ANTHROPIC_API_KEY` — clé API Anthropic pour les deux premiers échelons du coach, Claude Sonnet 5.5 puis Opus 5.5 (server-side uniquement). **À créer depuis un espace de travail (workspace)** : une clé créée au niveau de l'organisation est refusée à chaque requête, les deux échelons Claude tombent ensemble, et le coach répond alors en silence sur Mistral. Les données du profil et des séances partent chez Anthropic (entreprise américaine, pas d'entraînement sur les données de l'API) pour la qualité du coaching.
- `MISTRAL_API_KEY` — clé API Mistral pour les échelons de repli (server-side uniquement) : le coach y bascule si Anthropic ne répond pas. Mistral : siège à Paris, RGPD comme référence, hors CLOUD Act américain, pas d'entraînement sur les données de l'API. Ses quotas étant *par compte*, ses deux échelons protègent contre la surcharge d'un modèle, pas contre un 429.

## Synchronisation cloud

Les données sont synchronisées automatiquement vers Neon Postgres via des Netlify Functions.

**Mise en place :**

1. Créer un projet Neon (free tier) sur [console.neon.tech](https://console.neon.tech)
2. Exécuter le schéma depuis `netlify/functions/lib/schema.sql` dans la console SQL Neon — y compris la table `catalog` et son trigger `BEFORE UPDATE` (`catalog_set_updated_at`), qui horodate chaque écriture : c'est la clé de cache du prompt du coach côté edge function, donc l'oublier revient à servir un prompt figé après la première modification du catalogue
3. Peupler le catalogue **une seule fois** : `NEON_DATABASE_URL=... node scripts/seed-catalog.mjs`. `src/data/catalogSeed.json` est une photo figée du catalogue de départ — son générateur a été supprimé, il ne peut plus être régénéré — donc ce script est une amorce, pas une synchronisation : sur une base qui a déjà un catalogue, il n'écrit rien et le dit.
4. Ajouter les variables `NEON_DATABASE_URL`, `SYNC_API_KEY` (secret aléatoire, à inventer) et `APP_PASSWORD_HASH` (= `sha256(mot_de_passe)`) dans les paramètres Netlify
5. Pour le coach, ajouter `ANTHROPIC_API_KEY` (créée depuis un workspace) et `MISTRAL_API_KEY` : le coach essaie Claude Sonnet 5.5, puis Opus 5.5, puis deux modèles Mistral (`netlify/functions/lib/providers.js`).
6. La sync se déclenche automatiquement au chargement de l'app et après chaque action

**File d'envoi.** Chaque écriture (séance, suppression, programme, profil, catalogue) passe par une file d'envoi persistée dans le localStorage avant même d'être tentée, et n'en sort que lorsque Neon l'a confirmée. Une modification faite hors ligne survit donc à la fermeture de l'onglet et part au retour du réseau, dans l'ordre. La file garde une seule entrée par élément, avec sa dernière version : un ancien envoi ne peut plus repasser par-dessus un plus récent. Le catalogue est l'exception : son entrée accumule des opérations d'édition, rejouées sur la version du serveur (voir plus haut). L'indicateur de sync affiche « N en attente » tant que quelque chose n'est pas parti. Un envoi que le serveur refuse (erreur 4xx) est mis de côté sans être perdu — « 1 envoi refusé · Réessayer » — et ne bloque pas ceux qui suivent ; rien n'est jamais abandonné automatiquement. **Limite connue :** un envoi que le serveur n'acceptera jamais reste de côté, et l'indicateur reste rouge, tant que l'élément n'est pas réenregistré — une séance, un programme ou un profil refusé (4xx), ou une modification du catalogue qui ne s'applique plus au document du serveur, en ligne comme hors ligne, seule ou avec d'autres (par exemple la modification d'un exercice supprimé entre-temps sur un autre appareil, avant que celui-ci ait rechargé) : « Réessayer » la remet de côté à chaque fois, et un réenregistrement ne la remplace pas. Il n'y a pas de sortie dans l'app : il faut retirer l'entrée à la main de `parked` dans la clé localStorage `outbox`, ce qui, sur l'app installée sur l'iPad, demande l'inspecteur web de Safari depuis un Mac, puis refaire les modifications voulues. L'abandon automatique (impossible de distinguer un exercice supprimé d'un exercice dont l'ajout est lui-même en attente) et un bouton de suppression dans l'app (l'envoi supprimé revenait par d'autres chemins) ont tous deux été écartés le 02/10/2026. Au chargement, la copie du cloud l'emporte, sauf pour un élément qui a une écriture en file (ou envoyée pendant le chargement) : sa version locale est gardée, une modification hors ligne n'est donc plus annulée par le rechargement. Pour le catalogue, c'est la version qui décide : un document du cloud plus récent remplace la copie locale, et les opérations encore en file sont rejouées dessus. Le programme, le profil et les réglages, eux, restent en « dernier écrit gagne » (pour le profil, clé par clé : le serveur fusionne l'envoi sur la ligne enregistrée, donc un appareil dont l'app est plus ancienne n'efface pas les champs qu'elle ne connaît pas) : une modification faite hors ligne sur un appareil passe par-dessus ce qu'un autre appareil a enregistré entre-temps, même plusieurs jours après, quand le premier se reconnecte. C'est un choix assumé pour une seule utilisatrice qui modifie rarement son profil. Sans connexion préalable (aucune clé stockée), rien n'est mis en file : l'app fonctionne en local seul.


Sans ces variables, l'app reste utilisable en mode localStorage uniquement, mais la dégradation n'est plus totalement transparente sur deux points introduits par le catalogue Neon : un appareil qui n'a encore jamais synchronisé n'a ni lexique ni import de programme tant que son premier pull n'a pas réussi (aucun catalogue local à lire avant ça), et côté coach, une panne Neon ne lui coûte plus seulement sa mémoire — la lecture du catalogue n'est volontairement pas rattrapée, donc le chat ne répond plus du tout plutôt que de risquer d'inventer des exercices. Sans les clés du coach tout court, l'onglet Coach reste accessible mais le chat renvoie une erreur.

## Structure

```
src/
├── App.jsx                     # Password gate + tab router + header
├── index.css                   # Tailwind v4 @theme
├── constants/index.js          # Timer presets, profil par défaut — plus les exercices : le catalogue est un document Neon (voir src/lib/catalog.js)
├── lib/                        # Helpers, storage, plan parser/export, catalogue (vues + validation + édition), machine à états de la séance (+tests)
├── hooks/useSessionData.js     # State + CRUD + persistence
├── hooks/useActiveSession.js   # Séance en cours : persistance localStorage + wake lock
└── components/                 # UI (SeanceMode, SessionForm, CoachTab, etc.)

netlify/
├── __tests__/                  # Tests backend (jamais dans functions/ — Netlify les déploierait)
├── edge-functions/             # coach-chat : le seul endpoint qui streame plus de 10 s
└── functions/                  # API serverless (sync-sessions, sync-plan, sync-profile, sync-pull, sync-export, sync-catalog)
    └── lib/                    # Helper DB, shim d'env, middleware auth, schéma SQL, libs du coach
```

## Licence

AGPL-3.0 — voir [LICENSE](LICENSE). Les polices de `public/fonts/` sont sous licence SIL OFL 1.1 (fichiers `OFL-*.txt` à côté). Les photos décoratives sont facultatives : sans dossier `public/hero/`, le build donne la même app sans images.
