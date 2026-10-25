# Belle Forme: your own copy, step by step

- [English](#english)
- [Français](#français)

---

## English

This guide puts **your own copy** of Belle Forme online, for free, without installing anything. It assumes you have never used a terminal or GitHub: every step says where to click, what to copy, and how to check it worked.

You will use three free services:

- **GitHub** keeps your copy of the app's code;
- **Neon** keeps your data (sessions, programme, profile);
- **Netlify** puts the app on the web, at an address like `https://your-name.netlify.app`.

The AI coach is optional. It needs a paid account with Anthropic (and, optionally, Mistral), see [step 7](#step-7-optional-create-the-ai-keys-for-the-coach). Without it, everything else works: sessions, timer, programme, exercises, profile.

Belle Forme is made for **one person per copy**: one passphrase, one profile. The app, the exercise list and the coach are **in French**.

**Want to look first?** The app has a demo with invented data and a scripted coach, where nothing is sent to a server: any copy serves it at its address followed by `/demo/`.

### What this costs

> | Service | Price | What to know |
> |---|---|---|
> | GitHub | Free | Your copy of the code is public. That is fine: no password or key ever goes into it. |
> | Neon (database) | Free plan, no credit card (October 2026) | The free plan has storage and compute limits per project. If the database goes over its compute limit, it is suspended until the next month; over its storage limit, it stops accepting new data. Your data is not deleted. |
> | Netlify (hosting) | Free plan | **New Netlify accounts are on a credit-based plan.** The free plan gives a monthly allowance of credits (300 in October 2026) with a hard limit. Each publication of the app (a "production deploy") costs credits (15 in October 2026, so about twenty a month at most), and so do visits, data transferred and the server functions. **When the credits run out, Netlify pauses every site on your account**: visitors see a "Site not available" page until the credits come back at the start of the next monthly cycle. Nothing is lost, but the app is offline until then. |
> | Anthropic (coach, optional) | Pay as you go, prepaid | An estimate, not a measurement: about **$5 a month** for 3 coach messages a day and one programme a week, about **$13 to $15 a month** for 10 messages a day. You set a monthly limit yourself (step 7). |
> | Mistral (coach backup, optional) | Pay as you go | Used only when Anthropic does not answer. |
>
> Prices and limits change: check each service's pricing page before you start.

### Your health data

> Your sessions, programme and profile (age, height, weight, goals, notes, cycle settings if you turn them on) are stored in **your** Neon database. Nobody else hosts them.
>
> **When you use the coach, that data leaves your database.** With every message to the coach, your profile, sessions, programme, exercise list and the coach's notes and conversation are sent to **Anthropic** (a US company), and to **Mistral** (a French company) when the backup answers. Read their terms on API data before you decide. If you do not want that, skip step 7: without AI keys nothing is sent to either.

### Before you start

You need:

- a computer (Mac or Windows) with a web browser;
- an email address;
- about an hour;
- a private place to write down a few values as you go, such as a password manager or a private note. They are secrets: never send them by email or message, and never put them in GitHub.

Write down these values as you create them (the guide tells you when):

| Name | What it is |
|---|---|
| `NEON_DATABASE_URL` | The address of your database (step 2) |
| your passphrase | What you will type to enter the app (step 5). Keep it in your password manager. |
| `APP_PASSWORD_HASH` | A scrambled form of your passphrase (step 5) |
| `SYNC_API_KEY` | A random key that links your devices to your data (step 6) |
| `ANTHROPIC_API_KEY`, `MISTRAL_API_KEY` | The coach's keys (step 7, optional) |

### Step 1. Create a GitHub account and copy the app

1. Go to `https://github.com` and choose **Sign up**. Follow the steps (email, password, username) and confirm your email address.
2. Come back to the GitHub page of this app, the one where you are reading this guide (its address looks like `https://github.com/<someone>/<app-name>`). If you are reading a copy of this guide somewhere else, open the GitHub page you got it from.
3. At the top right of that page, click **Fork**. On the next page, leave everything as it is and click **Create fork**.
4. **Check:** you are now on a page whose address starts with `https://github.com/<your-username>/`. That page is **your copy**. Every time this guide says "your copy on GitHub", it means that page.

### Step 2. Create the database on Neon

1. Go to `https://neon.com` and sign up (**Sign up**). You can sign up with your GitHub account or with an email address.
2. Neon asks you to create a **project**. Give it a name (for example `belle-forme`), keep the proposed Postgres version, and pick the **region** closest to you (for example a European one if you live in Europe). Confirm (the button is usually **Create project**).
3. On the project page, click **Connect**. A window opens with the address of your database (the "connection string").
   - Keep the proposed branch, database and role, and leave **Connection pooling** as it is.
   - If the window offers several formats, choose the one that shows the plain connection string.
   - Copy the text that starts with `postgresql://` and ends with the last character of the line, with no quotes and no `psql` in front. It has this shape: `postgresql://<user>:<password>@<host>.neon.tech/neondb?sslmode=require&channel_binding=require`, where `<host>` starts with `ep-` and usually contains `-pooler` and a region name.
4. Write it down as `NEON_DATABASE_URL`. It contains your database password: treat it as a secret.

**Check:** the text starts with `postgresql://`, contains `@` and `neon.tech`, and has no space in it.

### Step 3. Put the tables and the exercise list in the database

The database is empty. You will paste two pieces of text into Neon: the list of tables, then the list of starter exercises.

**3a. The tables.**

1. In another browser tab, open **your copy on GitHub** (step 1). Click the folder `netlify`, then `functions`, then `lib`, then the file `schema.sql`.
2. Above the file's content, on the right, there is a **Copy raw file** button (an icon of two overlapping squares; its name appears when you hover over it). Click it: the whole file is now copied.
3. Back in Neon, open the **SQL Editor** (in the menu on the left of your project).
4. Click in the large text area, paste (**Cmd+V** on a Mac, **Ctrl+V** on Windows), then click **Run**.
5. **Check:** Neon shows no red error. Then delete everything in the text area, paste this line, and click **Run**:

   ```sql
   SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1;
   ```

   You should see a list of names that includes `catalog`, `profile` and `sessions`.

**3b. The exercise list.**

The coach refuses to answer without an exercise list, and the app needs one to import a programme.

1. Delete everything in Neon's text area and paste these three lines:

   ```sql
   INSERT INTO catalog (id, data) VALUES (1, $seed$
   PASTE THE FILE HERE
   $seed$::jsonb) ON CONFLICT (id) DO NOTHING;
   ```

2. In **your copy on GitHub**, go back to the start of the code (click your copy's name at the top), then open the folder `src`, then `data`, then the file `catalogSeed.json`. Click **Copy raw file**, as before.
3. Back in Neon, select the whole middle line `PASTE THE FILE HERE` (double-click won't do it: drag over the whole line with the mouse), then paste. The file's content replaces the line. The first line `INSERT INTO …` and the last line `$seed$::jsonb) …` must stay as they are.
4. Click **Run**. With a text this long, the answer can take a few seconds.
5. **Check:** delete everything, paste this line, click **Run**:

   ```sql
   SELECT jsonb_array_length(data->'exercises') AS exercises FROM catalog;
   ```

   You should see a single row with a number greater than 0: the number of starter exercises.

Errors you may see here:

- `relation "catalog" does not exist`: step 3a has not run. Do 3a, then 3b again.
- `invalid input syntax for type json`: the file was not pasted in full, or the line `PASTE THE FILE HERE` is still there. Start 3b again from point 1.
- `syntax error at or near …`: the first or the last line was changed or deleted. Start 3b again from point 1.
- Running 3b twice does no harm: the second time, it changes nothing.

### Step 4. Open a terminal

A terminal is a window where you type (or paste) a command and press Enter; the computer prints the answer underneath. You need it for steps 5 and 6 only, and nothing you type there installs anything.

- **Mac:** press **Cmd+Space**, type `Terminal`, press **Enter**. A window opens with a line ending in `%` or `$`.
  - Paste: **Cmd+V**. Copy an answer: select it with the mouse, then **Cmd+C**.
- **Windows:** click the Start menu, type `PowerShell`, and open **Windows PowerShell** (or **Terminal**). A window opens with a line starting with `PS C:\`.
  - Paste: **Ctrl+V** (or a right-click). Copy an answer: select it with the mouse, then **Ctrl+C** (in older windows, a right-click copies the selection).

After pasting a command, press **Enter** to run it.

### Step 5. Choose your passphrase and turn it into a hash

The passphrase is what you will type to enter the app. The app never stores it: it stores a **hash**, a scrambled form from which the passphrase cannot be read back.

1. **Choose a long passphrase**: five or more words picked at random, for example `lamp river cactus velvet orbit` (do not use this one). Length is what protects you. To avoid surprises between devices, use **lowercase letters without accents**, separated by spaces or dashes. Save it in your password manager.
2. **Check your terminal first**, with a known answer: paste this command and press Enter.

   - Mac:

     ```bash
     printf '%s' test | shasum -a 256
     ```

   - Windows (PowerShell):

     ```powershell
     -join ([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes('test')) | ForEach-Object { $_.ToString('x2') })
     ```

   The answer must start with `9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08` (on a Mac, followed by a space and `-`). If it does, your terminal computes hashes the way the app does.
3. **Hash your passphrase.** Paste the command for your computer, press Enter, then type your passphrase and press Enter.

   - Mac (**nothing appears while you type**, that is normal):

     ```bash
     read -rs PASS && printf '%s' "$PASS" | shasum -a 256 | cut -d' ' -f1; unset PASS
     ```

   - Windows (PowerShell shows a `*` for each character):

     ```powershell
     $s = Read-Host -AsSecureString "Passphrase"; $p = [System.Net.NetworkCredential]::new('', $s).Password; -join ([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($p)) | ForEach-Object { $_.ToString('x2') }); Remove-Variable s, p
     ```

4. The answer is one line of **64 characters**, only digits and the letters `a` to `f`. Copy it and write it down as `APP_PASSWORD_HASH`.

**Check:** exactly 64 characters, no space, nothing else on the line (on a Mac, this command prints no `-`). A typo in the passphrase gives a completely different hash, so if you are unsure what you typed, do point 3 again.

These commands keep your passphrase out of the terminal's history.

### Step 6. Create the sync key

The sync key is a random string that lets your devices read and write your data once you have typed the right passphrase. You never type it yourself: the app receives it after you sign in.

- Mac:

  ```bash
  openssl rand -hex 32
  ```

- Windows (PowerShell):

  ```powershell
  $b = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })
  ```

The answer is a line of 64 characters (digits and `a` to `f`), different every time. Copy it and write it down as `SYNC_API_KEY`.

You can close the terminal now.

### Step 7 (optional). Create the AI keys for the coach

Skip this step if you do not want the coach, or come back to it later (you will then add the keys in Netlify, step 8, and publish again). Read [Your health data](#your-health-data) first.

**Anthropic (the coach's main models).** Anthropic's console changes often: the labels below are the likely ones, look for the closest.

1. Go to `https://console.anthropic.com` (it may send you on to another Anthropic address) and create an account.
2. In the billing settings (**Billing** or **Plans & Billing**), add a payment method and buy a small amount of credit. The coach does not answer without credit.
3. Create a **workspace** for this app (in the settings, **Workspaces**, then a button such as **Create workspace**). Name it `belle-forme`.
4. In that workspace's settings, set a **monthly spend limit** (look for **Limits**) at an amount you accept losing, for example the estimate in [What this costs](#what-this-costs) plus a margin. This limit is the only cap on what the coach can cost, including if someone ever learns your passphrase.
5. Create the key **inside that workspace** (in **API keys**, a button such as **Create key**, then choose the `belle-forme` workspace). **This matters:** a key created outside a workspace is refused on every request, and the coach then answers only with the backup, without telling you.
6. The key starts with `sk-ant-`. It is shown **only once**: copy it right away and write it down as `ANTHROPIC_API_KEY`.

**Mistral (the backup, optional).** Without it, the coach still works as long as Anthropic answers.

1. Go to `https://console.mistral.ai`, create an account, and choose a plan in the billing settings. Read what the plan you choose says about the use of your data.
2. In **API Keys**, create a key (a button such as **Create new key**), copy it right away, and write it down as `MISTRAL_API_KEY`.
3. If the billing settings offer a spending limit, set one.

### Step 8. Put the app online with Netlify

1. Go to `https://www.netlify.com`, choose **Sign up**, and sign up **with GitHub** (the simplest: Netlify then sees your copy). Accept what GitHub asks to authorize. If Netlify asks a few welcome questions, any answer will do.
2. Read [What this costs](#what-this-costs) again: the free plan's credits are limited, and every publication uses some. This step publishes twice: once to create the site, once after adding your secrets.
3. In Netlify, click **Add new project**, then **Import an existing project**, then **GitHub**.
4. GitHub may open a page asking where to install Netlify and which repositories it can see: choose **Only select repositories**, pick your copy, and confirm. Back in Netlify, click your copy in the list.
5. A settings page opens. **Change nothing in the build settings**: the app's code already tells Netlify how to build it (build command `npm run build`, publish directory `dist`). You can choose the **project name**: it becomes the address, `https://<project-name>.netlify.app`.
6. Click the button at the bottom of the page that publishes the project (its label starts with **Deploy**). Netlify builds the app: it takes a few minutes.
7. **Wait for the first publication:** in the project's **Deploys** tab, the latest line must read **Published**. If it reads **Failed**, open it: the log at the bottom says what went wrong (see [When something goes wrong](#when-something-goes-wrong)). The site already opens at this point, but you cannot sign in yet: the secrets are missing.
8. **Add your secrets (the "environment variables").** First prepare this text in a note, replacing each `<…>` with the value you wrote down, with no quotes and no space around `=`. Delete the `ANTHROPIC_API_KEY` and `MISTRAL_API_KEY` lines if you skipped step 7:

   ```
   APP_PASSWORD_HASH=<the 64-character hash from step 5>
   SYNC_API_KEY=<the 64-character key from step 6>
   NEON_DATABASE_URL=<the postgresql://… address from step 2>
   NODE_VERSION=24
   ANTHROPIC_API_KEY=<your Anthropic key>
   MISTRAL_API_KEY=<your Mistral key>
   ```

   Then, in Netlify, open **Project configuration** (in the project's menu), then **Environment variables**. Click **Add a variable**, then **Import from a .env file**. Paste the text, keep the proposed scopes and deploy contexts, and click **Import variables**. If Netlify asks how to handle variables that already exist (a "merge strategy"), choose **Update conflicts**.
9. **Publish again**, so the app sees its secrets: **Deploys** tab, **Trigger deploy**, then **Deploy project**. Wait for **Published** again. **A change to the variables only counts after a new publication**, and each publication costs credits.

**Check the variables:** in **Project configuration → Environment variables**, you should see `APP_PASSWORD_HASH`, `SYNC_API_KEY`, `NEON_DATABASE_URL` and `NODE_VERSION` (and the AI keys if you made them). The site's address is shown at the top of the project's page in Netlify.

### Step 9. First sign-in and your profile

1. Open `https://<project-name>.netlify.app`. You should see « Belle Forme », a **Mot de passe** field and an **Entrer en scène** button.
2. Type your passphrase (the words, not the hash) and press **Entrer en scène**.
3. The app opens on the **Profil** tab with a « Bienvenue » card. Fill in at least **Prénom** (your first name) and **« Le coach s'adresse à toi au »** (*féminin* or *masculin*, the grammatical gender the coach uses for you), and your **Matériel** (equipment: dumbbells, bars, plates, and a list to tick of what you have at home): the form is pre-filled with an example to edit. Press **Sauvegarder**.
4. **Check that your data reaches the database:** open the same address in a private window or on another device, sign in again: your profile must be there. You can also run `SELECT count(*) FROM profile;` in Neon's SQL Editor: the answer should be `1`.
5. If you made the AI keys: open the **Coach** tab and write a message. The reply appears progressively.

To use it like an app on a phone or tablet, open the address in the browser and use **Add to Home Screen** (on an iPhone or iPad: the Share button in Safari; on Android: the Chrome menu, then **Add to Home screen** or **Install app**).

### When something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| « Raté, darling. Réessaie. » at sign-in | The passphrase you typed does not match `APP_PASSWORD_HASH`. | Check Caps Lock and type it again. If you are sure of it, redo step 5 point 3, replace `APP_PASSWORD_HASH` in Netlify, and publish again. |
| « Le rideau est coincé (serveur). Réessaie. » | The server is missing something: most often `APP_PASSWORD_HASH` or `SYNC_API_KEY` is not set, or was added without publishing again. | Check the variables (step 8), then **Trigger deploy**. |
| « Trop d'essais, darling. Réessaie dans N min. » | Too many wrong passphrases in a row: sign-in is blocked for a while, even with the right one. | Wait the number of minutes shown. |
| « Pas de réseau, chérie. Réessaie. » | The browser could not reach the app. | Check your internet connection. If it works, open the address: a "Site not available" page means the site is paused (next line). |
| A "Site not available" page from Netlify | Your Netlify credits have run out and **every site on your account is paused**. | Wait for the next monthly cycle, or move to a paid Netlify plan. Your data is safe in Neon. |
| A "Page not found" page on the `netlify.app` address | The app was never published successfully. | **Deploys** tab: wait for **Published**, or open the failed line. |
| A publication marked **Failed** | Netlify could not build the app. | Open it and read the last red lines of the log. If you changed something in the build settings, put back `npm run build` and `dist`. |
| The profile does not show up on another device, or « N en attente » never goes away | The app cannot write to the database: `NEON_DATABASE_URL` is missing or wrong, or the database is suspended. | Compare `NEON_DATABASE_URL` in Netlify with the address in Neon (**Connect**), publish again, and look at your Neon project's page for a limit message. |
| The coach shows an error instead of a reply | A missing or wrong AI key, no credit left at Anthropic, the spend limit reached, or no exercise list (step 3b). | Check the keys in Netlify, your Anthropic balance and limit, and step 3b's check. |
| The coach answers, but Anthropic's console shows no usage | The Anthropic key was created outside a workspace: Mistral answers in its place. | Create a new key inside the workspace (step 7 point 5), replace it in Netlify, publish again. |

### Keeping the app up to date

When the original app gets a new version, your copy does not change by itself. To update it, **always in this order**:

1. **First the tables.** In **your copy on GitHub**, the page shows a line saying your copy is behind ("This branch is … commits behind"). Before syncing, open the **original** app's GitHub page (the one you forked, linked under your copy's name as "forked from …"), open `netlify/functions/lib/schema.sql` there, click **Copy raw file**, paste it in Neon's SQL Editor, and click **Run**. Running it again on an up-to-date database changes nothing, and the new version may need a new table or column before it runs.
2. **Then the code.** On your copy's GitHub page, click **Sync fork**, then **Update branch**. Netlify publishes the new version by itself, which costs credits.
3. Each open copy of the app then offers to reload.

**Never** run step 3b again to "update" the exercise list: it would change nothing, and your list is now your own (you edit it in the **Exercices** tab).

### Backups

In the app: **Profil → Export SQL (urgence)** downloads a file `belle-forme-backup-<date>.sql` with your sessions, programme, profile, settings, exercise list and the coach's notes and conversation. Do it regularly and keep the file somewhere private: it contains health data.

To restore it, paste the file's content into Neon's SQL Editor and click **Run**. **This replaces** what is in the database with the backup's content.

### Stopping everything

- To take the app offline: in Netlify, open **Project configuration**; the delete button is at the bottom of the general settings (its label contains **Delete**).
- To delete your data: in Neon, open the project's **Settings**; the delete button is at the bottom (its label contains **Delete**). This cannot be undone: export a backup first.
- To stop AI costs: delete the keys in Anthropic's and Mistral's consoles.

---

## Français

Ce guide met en ligne **ta propre copie** de Belle Forme, gratuitement, sans rien installer. Il suppose que tu n'as jamais utilisé de terminal ni GitHub : chaque étape dit où cliquer, quoi copier, et comment vérifier que ça a marché.

Tu vas utiliser trois services gratuits :

- **GitHub** garde ta copie du code de l'app ;
- **Neon** garde tes données (séances, programme, profil) ;
- **Netlify** met l'app sur le web, à une adresse du type `https://ton-nom.netlify.app`.

Le coach IA est facultatif. Il demande un compte payant chez Anthropic (et, si tu veux, chez Mistral), voir l'[étape 7](#étape-7-facultatif-créer-les-clés-dia-du-coach). Sans lui, tout le reste marche : séances, minuteur, programme, exercices, profil.

Belle Forme est conçue pour **une personne par copie** : une phrase de passe, un profil. L'app, la liste d'exercices et le coach sont **en français**.

**Tu veux d'abord regarder ?** L'app a une démo avec des données inventées et un coach scripté, où rien n'est envoyé à un serveur : chaque copie la sert à son adresse suivie de `/demo/`.

### Ce que ça coûte

> | Service | Prix | À savoir |
> |---|---|---|
> | GitHub | Gratuit | Ta copie du code est publique. Ce n'est pas un problème : aucun mot de passe ni aucune clé n'y entre jamais. |
> | Neon (base de données) | Offre gratuite, sans carte bancaire (octobre 2026) | L'offre gratuite a des limites de stockage et de calcul par projet. Si la base dépasse sa limite de calcul, elle est suspendue jusqu'au mois suivant ; au-delà de sa limite de stockage, elle n'accepte plus de nouvelles données. Tes données ne sont pas effacées. |
> | Netlify (hébergement) | Offre gratuite | **Les nouveaux comptes Netlify sont sur une offre à crédits.** L'offre gratuite donne une enveloppe mensuelle de crédits (300 en octobre 2026) avec un plafond strict. Chaque publication de l'app (un « déploiement de production ») coûte des crédits (15 en octobre 2026, donc une vingtaine par mois au maximum), tout comme les visites, les données transférées et les fonctions serveur. **Quand les crédits sont épuisés, Netlify met en pause tous les sites de ton compte** : les visiteurs voient une page « Site not available » jusqu'au retour des crédits, au début du cycle mensuel suivant. Rien n'est perdu, mais l'app est hors ligne d'ici là. |
> | Anthropic (coach, facultatif) | À l'usage, prépayé | Une estimation, pas une mesure : environ **5 $ par mois** pour 3 messages au coach par jour et un programme par semaine, environ **13 à 15 $ par mois** pour 10 messages par jour. Tu fixes toi-même un plafond mensuel (étape 7). |
> | Mistral (secours du coach, facultatif) | À l'usage | Utilisé seulement quand Anthropic ne répond pas. |
>
> Les prix et les limites changent : vérifie la page de tarifs de chaque service avant de commencer.

### Tes données de santé

> Tes séances, ton programme et ton profil (âge, taille, poids, objectifs, notes, réglages du cycle si tu les actives) sont stockés dans **ta** base Neon. Personne d'autre ne les héberge.
>
> **Quand tu utilises le coach, ces données sortent de ta base.** À chaque message au coach, ton profil, tes séances, ton programme, la liste d'exercices, les notes et la conversation du coach sont envoyés à **Anthropic** (entreprise américaine), et à **Mistral** (entreprise française) quand le secours répond. Lis leurs conditions sur les données API avant de décider. Si tu ne veux pas de ça, saute l'étape 7 : sans clé d'IA, rien n'est envoyé ni à l'un ni à l'autre.

### Avant de commencer

Il te faut :

- un ordinateur (Mac ou Windows) avec un navigateur web ;
- une adresse e-mail ;
- environ une heure ;
- un endroit privé pour noter quelques valeurs au fil des étapes, comme un gestionnaire de mots de passe ou une note privée. Ce sont des secrets : ne les envoie jamais par e-mail ni par message, et ne les mets jamais dans GitHub.

Note ces valeurs au fur et à mesure (le guide te dit quand) :

| Nom | Ce que c'est |
|---|---|
| `NEON_DATABASE_URL` | L'adresse de ta base de données (étape 2) |
| ta phrase de passe | Ce que tu taperas pour entrer dans l'app (étape 5). Garde-la dans ton gestionnaire de mots de passe. |
| `APP_PASSWORD_HASH` | Une forme brouillée de ta phrase de passe (étape 5) |
| `SYNC_API_KEY` | Une clé aléatoire qui relie tes appareils à tes données (étape 6) |
| `ANTHROPIC_API_KEY`, `MISTRAL_API_KEY` | Les clés du coach (étape 7, facultative) |

### Étape 1. Créer un compte GitHub et copier l'app

1. Va sur `https://github.com` et choisis **Sign up**. Suis les étapes (e-mail, mot de passe, nom d'utilisateur) et confirme ton adresse e-mail.
2. Reviens sur la page GitHub de cette app, celle où tu lis ce guide (son adresse ressemble à `https://github.com/<quelqu-un>/<nom-de-l-app>`). Si tu lis une copie de ce guide ailleurs, ouvre la page GitHub d'où elle vient.
3. En haut à droite de cette page, clique sur **Fork**. Sur la page suivante, ne change rien et clique sur **Create fork**.
4. **Vérification :** tu es maintenant sur une page dont l'adresse commence par `https://github.com/<ton-nom-d-utilisateur>/`. Cette page est **ta copie**. Chaque fois que ce guide dit « ta copie sur GitHub », il parle de cette page.

### Étape 2. Créer la base de données sur Neon

1. Va sur `https://neon.com` et inscris-toi (**Sign up**). Tu peux t'inscrire avec ton compte GitHub ou avec une adresse e-mail.
2. Neon te demande de créer un **projet**. Donne-lui un nom (par exemple `belle-forme`), garde la version de Postgres proposée, et choisis la **région** la plus proche de toi (par exemple une région européenne si tu vis en Europe). Valide (le bouton s'appelle en général **Create project**).
3. Sur la page du projet, clique sur **Connect**. Une fenêtre s'ouvre avec l'adresse de ta base (la « chaîne de connexion »).
   - Garde la branche, la base et le rôle proposés, et laisse **Connection pooling** tel quel.
   - Si la fenêtre propose plusieurs formats, choisis celui qui montre la chaîne de connexion seule.
   - Copie le texte qui commence par `postgresql://` et va jusqu'au dernier caractère de la ligne, sans guillemets et sans `psql` devant. Il a cette forme : `postgresql://<utilisateur>:<mot-de-passe>@<hôte>.neon.tech/neondb?sslmode=require&channel_binding=require`, où `<hôte>` commence par `ep-` et contient en général `-pooler` et un nom de région.
4. Note-le sous le nom `NEON_DATABASE_URL`. Il contient le mot de passe de ta base : traite-le comme un secret.

**Vérification :** le texte commence par `postgresql://`, contient `@` et `neon.tech`, et n'a aucun espace.

### Étape 3. Mettre les tables et la liste d'exercices dans la base

La base est vide. Tu vas coller deux textes dans Neon : la liste des tables, puis la liste des exercices de départ.

**3a. Les tables.**

1. Dans un autre onglet du navigateur, ouvre **ta copie sur GitHub** (étape 1). Clique sur le dossier `netlify`, puis `functions`, puis `lib`, puis sur le fichier `schema.sql`.
2. Au-dessus du contenu du fichier, à droite, il y a un bouton **Copy raw file** (une icône de deux carrés superposés ; son nom apparaît quand tu passes la souris dessus). Clique dessus : tout le fichier est copié.
3. De retour dans Neon, ouvre le **SQL Editor** (dans le menu à gauche de ton projet).
4. Clique dans la grande zone de texte, colle (**Cmd+V** sur Mac, **Ctrl+V** sur Windows), puis clique sur **Run**.
5. **Vérification :** Neon n'affiche aucune erreur en rouge. Efface ensuite tout le contenu de la zone de texte, colle cette ligne et clique sur **Run** :

   ```sql
   SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1;
   ```

   Tu dois voir une liste de noms qui contient `catalog`, `profile` et `sessions`.

**3b. La liste d'exercices.**

Le coach refuse de répondre sans liste d'exercices, et l'app en a besoin pour importer un programme.

1. Efface tout dans la zone de texte de Neon et colle ces trois lignes :

   ```sql
   INSERT INTO catalog (id, data) VALUES (1, $seed$
   PASTE THE FILE HERE
   $seed$::jsonb) ON CONFLICT (id) DO NOTHING;
   ```

2. Dans **ta copie sur GitHub**, reviens au début du code (clique sur le nom de ta copie en haut), puis ouvre le dossier `src`, puis `data`, puis le fichier `catalogSeed.json`. Clique sur **Copy raw file**, comme avant.
3. De retour dans Neon, sélectionne toute la ligne du milieu `PASTE THE FILE HERE` (un double-clic ne suffit pas : fais glisser la souris sur toute la ligne), puis colle. Le contenu du fichier remplace la ligne. La première ligne `INSERT INTO …` et la dernière `$seed$::jsonb) …` doivent rester telles quelles.
4. Clique sur **Run**. Avec un texte aussi long, la réponse peut prendre quelques secondes.
5. **Vérification :** efface tout, colle cette ligne, clique sur **Run** :

   ```sql
   SELECT jsonb_array_length(data->'exercises') AS exercises FROM catalog;
   ```

   Tu dois voir une seule ligne avec un nombre supérieur à 0 : le nombre d'exercices de départ.

Les erreurs que tu peux voir ici :

- `relation "catalog" does not exist` : l'étape 3a n'a pas tourné. Fais 3a, puis refais 3b.
- `invalid input syntax for type json` : le fichier n'a pas été collé en entier, ou la ligne `PASTE THE FILE HERE` est encore là. Reprends 3b au point 1.
- `syntax error at or near …` : la première ou la dernière ligne a été modifiée ou effacée. Reprends 3b au point 1.
- Lancer 3b deux fois ne fait aucun mal : la deuxième fois, rien ne change.

### Étape 4. Ouvrir un terminal

Un terminal est une fenêtre où tu tapes (ou colles) une commande puis appuies sur Entrée ; l'ordinateur affiche la réponse en dessous. Tu n'en as besoin que pour les étapes 5 et 6, et rien de ce que tu y tapes n'installe quoi que ce soit.

- **Mac :** appuie sur **Cmd+Espace**, tape `Terminal`, appuie sur **Entrée**. Une fenêtre s'ouvre avec une ligne qui se termine par `%` ou `$`.
  - Coller : **Cmd+V**. Copier une réponse : sélectionne-la à la souris, puis **Cmd+C**.
- **Windows :** clique sur le menu Démarrer, tape `PowerShell`, et ouvre **Windows PowerShell** (ou **Terminal**). Une fenêtre s'ouvre avec une ligne qui commence par `PS C:\`.
  - Coller : **Ctrl+V** (ou un clic droit). Copier une réponse : sélectionne-la à la souris, puis **Ctrl+C** (dans les fenêtres plus anciennes, un clic droit copie la sélection).

Après avoir collé une commande, appuie sur **Entrée** pour la lancer.

### Étape 5. Choisir ta phrase de passe et la transformer en hash

La phrase de passe est ce que tu taperas pour entrer dans l'app. L'app ne la stocke jamais : elle stocke un **hash**, une forme brouillée à partir de laquelle on ne peut pas retrouver la phrase.

1. **Choisis une phrase de passe longue** : cinq mots ou plus tirés au hasard, par exemple `lampe riviere cactus velours orbite` (ne prends pas celle-ci). C'est la longueur qui te protège. Pour éviter les surprises d'un appareil à l'autre, utilise des **minuscules sans accents**, séparées par des espaces ou des tirets. Enregistre-la dans ton gestionnaire de mots de passe.
2. **Vérifie d'abord ton terminal**, avec une réponse connue : colle cette commande et appuie sur Entrée.

   - Mac :

     ```bash
     printf '%s' test | shasum -a 256
     ```

   - Windows (PowerShell) :

     ```powershell
     -join ([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes('test')) | ForEach-Object { $_.ToString('x2') })
     ```

   La réponse doit commencer par `9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08` (sur Mac, suivi d'un espace et d'un `-`). Si c'est le cas, ton terminal calcule les hash comme l'app.
3. **Calcule le hash de ta phrase.** Colle la commande de ton ordinateur, appuie sur Entrée, puis tape ta phrase de passe et appuie sur Entrée.

   - Mac (**rien ne s'affiche pendant que tu tapes**, c'est normal) :

     ```bash
     read -rs PASS && printf '%s' "$PASS" | shasum -a 256 | cut -d' ' -f1; unset PASS
     ```

   - Windows (PowerShell affiche un `*` par caractère) :

     ```powershell
     $s = Read-Host -AsSecureString "Passphrase"; $p = [System.Net.NetworkCredential]::new('', $s).Password; -join ([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($p)) | ForEach-Object { $_.ToString('x2') }); Remove-Variable s, p
     ```

4. La réponse est une ligne de **64 caractères**, uniquement des chiffres et les lettres `a` à `f`. Copie-la et note-la sous le nom `APP_PASSWORD_HASH`.

**Vérification :** exactement 64 caractères, aucun espace, rien d'autre sur la ligne (sur Mac, cette commande n'affiche pas de `-`). Une faute de frappe dans la phrase donne un hash complètement différent : si tu as un doute sur ce que tu as tapé, refais le point 3.

Ces commandes gardent ta phrase de passe hors de l'historique du terminal.

### Étape 6. Créer la clé de sync

La clé de sync est une chaîne aléatoire qui permet à tes appareils de lire et d'écrire tes données une fois la bonne phrase de passe tapée. Tu ne la tapes jamais toi-même : l'app la reçoit après la connexion.

- Mac :

  ```bash
  openssl rand -hex 32
  ```

- Windows (PowerShell) :

  ```powershell
  $b = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })
  ```

La réponse est une ligne de 64 caractères (des chiffres et `a` à `f`), différente à chaque fois. Copie-la et note-la sous le nom `SYNC_API_KEY`.

Tu peux fermer le terminal.

### Étape 7 (facultatif). Créer les clés d'IA du coach

Saute cette étape si tu ne veux pas du coach, ou reviens-y plus tard (tu ajouteras alors les clés dans Netlify, étape 8, et tu publieras de nouveau). Lis d'abord [Tes données de santé](#tes-données-de-santé).

**Anthropic (les modèles principaux du coach).** La console d'Anthropic change souvent : les libellés ci-dessous sont les plus probables, cherche le plus proche.

1. Va sur `https://console.anthropic.com` (le site peut te renvoyer vers une autre adresse d'Anthropic) et crée un compte.
2. Dans les réglages de facturation (**Billing** ou **Plans & Billing**), ajoute un moyen de paiement et achète un petit montant de crédit. Le coach ne répond pas sans crédit.
3. Crée un **espace de travail** (workspace) pour cette app (dans les réglages, **Workspaces**, puis un bouton du type **Create workspace**). Appelle-le `belle-forme`.
4. Dans les réglages de cet espace de travail, fixe une **limite de dépense mensuelle** (cherche **Limits**) à un montant que tu acceptes de perdre, par exemple l'estimation de [Ce que ça coûte](#ce-que-ça-coûte) plus une marge. Cette limite est le seul plafond à ce que le coach peut coûter, y compris si quelqu'un apprenait un jour ta phrase de passe.
5. Crée la clé **dans cet espace de travail** (dans **API keys**, un bouton du type **Create key**, puis choisis l'espace de travail `belle-forme`). **C'est important :** une clé créée hors d'un espace de travail est refusée à chaque requête, et le coach ne répond alors plus qu'avec le secours, sans te prévenir.
6. La clé commence par `sk-ant-`. Elle n'est affichée **qu'une fois** : copie-la tout de suite et note-la sous le nom `ANTHROPIC_API_KEY`.

**Mistral (le secours, facultatif).** Sans lui, le coach marche quand même tant qu'Anthropic répond.

1. Va sur `https://console.mistral.ai`, crée un compte et choisis une offre dans les réglages de facturation. Lis ce que l'offre choisie dit de l'utilisation de tes données.
2. Dans **API Keys**, crée une clé (un bouton du type **Create new key**), copie-la tout de suite et note-la sous le nom `MISTRAL_API_KEY`.
3. Si les réglages de facturation proposent une limite de dépense, fixe-la.

### Étape 8. Mettre l'app en ligne avec Netlify

1. Va sur `https://www.netlify.com`, choisis **Sign up**, et inscris-toi **avec GitHub** (le plus simple : Netlify voit alors ta copie). Accepte ce que GitHub te demande d'autoriser. Si Netlify pose quelques questions de bienvenue, n'importe quelle réponse convient.
2. Relis [Ce que ça coûte](#ce-que-ça-coûte) : les crédits de l'offre gratuite sont limités, et chaque publication en consomme. Cette étape publie deux fois : une fois pour créer le site, une fois après l'ajout de tes secrets.
3. Dans Netlify, clique sur **Add new project**, puis **Import an existing project**, puis **GitHub**.
4. GitHub peut ouvrir une page qui demande où installer Netlify et quels dépôts il a le droit de voir : choisis **Only select repositories**, prends ta copie, et valide. De retour dans Netlify, clique sur ta copie dans la liste.
5. Une page de réglages s'ouvre. **Ne change rien aux réglages de build** : le code de l'app dit déjà à Netlify comment la construire (commande `npm run build`, dossier publié `dist`). Tu peux choisir le **nom du projet** : il devient l'adresse, `https://<nom-du-projet>.netlify.app`.
6. Clique sur le bouton en bas de la page qui publie le projet (son libellé commence par **Deploy**). Netlify construit l'app : ça prend quelques minutes.
7. **Attends la première publication :** dans l'onglet **Deploys** du projet, la dernière ligne doit indiquer **Published**. Si elle indique **Failed**, ouvre-la : le journal en bas dit ce qui n'a pas marché (voir [En cas de problème](#en-cas-de-problème)). Le site s'ouvre déjà à ce stade, mais tu ne peux pas encore te connecter : les secrets manquent.
8. **Ajoute tes secrets (les « variables d'environnement »).** Prépare d'abord ce texte dans une note, en remplaçant chaque `<…>` par la valeur notée, sans guillemets et sans espace autour du `=`. Supprime les lignes `ANTHROPIC_API_KEY` et `MISTRAL_API_KEY` si tu as sauté l'étape 7 :

   ```
   APP_PASSWORD_HASH=<le hash de 64 caractères de l'étape 5>
   SYNC_API_KEY=<la clé de 64 caractères de l'étape 6>
   NEON_DATABASE_URL=<l'adresse postgresql://… de l'étape 2>
   NODE_VERSION=24
   ANTHROPIC_API_KEY=<ta clé Anthropic>
   MISTRAL_API_KEY=<ta clé Mistral>
   ```

   Ensuite, dans Netlify, ouvre **Project configuration** (dans le menu du projet), puis **Environment variables**. Clique sur **Add a variable**, puis **Import from a .env file**. Colle le texte, garde les portées et contextes proposés, et clique sur **Import variables**. Si Netlify demande quoi faire des variables qui existent déjà (une « merge strategy »), choisis **Update conflicts**.
9. **Publie de nouveau**, pour que l'app voie ses secrets : onglet **Deploys**, **Trigger deploy**, puis **Deploy project**. Attends de nouveau **Published**. **Une modification des variables ne compte qu'après une nouvelle publication**, et chaque publication coûte des crédits.

**Vérifie les variables :** dans **Project configuration → Environment variables**, tu dois voir `APP_PASSWORD_HASH`, `SYNC_API_KEY`, `NEON_DATABASE_URL` et `NODE_VERSION` (et les clés d'IA si tu les as créées). L'adresse du site est affichée en haut de la page du projet dans Netlify.

### Étape 9. Première connexion et ton profil

1. Ouvre `https://<nom-du-projet>.netlify.app`. Tu dois voir « Belle Forme », un champ **Mot de passe** et un bouton **Entrer en scène**.
2. Tape ta phrase de passe (les mots, pas le hash) et appuie sur **Entrer en scène**.
3. L'app s'ouvre sur l'onglet **Profil** avec une carte « Bienvenue ». Remplis au moins **Prénom** et **« Le coach s'adresse à toi au »** (*féminin* ou *masculin*), ainsi que ton **Matériel** (haltères, barres, disques, et une liste à cocher de ce que tu as chez toi) : le formulaire est prérempli avec un exemple à modifier. Appuie sur **Sauvegarder**.
4. **Vérifie que tes données arrivent dans la base :** ouvre la même adresse dans une fenêtre de navigation privée ou sur un autre appareil, reconnecte-toi : ton profil doit y être. Tu peux aussi lancer `SELECT count(*) FROM profile;` dans le SQL Editor de Neon : la réponse doit être `1`.
5. Si tu as créé les clés d'IA : ouvre l'onglet **Coach** et écris un message. La réponse s'affiche au fur et à mesure.

Pour t'en servir comme d'une app sur téléphone ou tablette, ouvre l'adresse dans le navigateur et utilise **Sur l'écran d'accueil** (sur iPhone ou iPad : le bouton Partager de Safari ; sur Android : le menu de Chrome, puis **Ajouter à l'écran d'accueil** ou **Installer l'application**).

### En cas de problème

| Ce que tu vois | Ce que ça veut dire | Quoi faire |
|---|---|---|
| « Raté, darling. Réessaie. » à la connexion | La phrase tapée ne correspond pas à `APP_PASSWORD_HASH`. | Vérifie la touche Verr. Maj et retape-la. Si tu n'as aucun doute, refais le point 3 de l'étape 5, remplace `APP_PASSWORD_HASH` dans Netlify et publie de nouveau. |
| « Le rideau est coincé (serveur). Réessaie. » | Il manque quelque chose au serveur : le plus souvent, `APP_PASSWORD_HASH` ou `SYNC_API_KEY` n'est pas définie, ou a été ajoutée sans nouvelle publication. | Vérifie les variables (étape 8), puis **Trigger deploy**. |
| « Trop d'essais, darling. Réessaie dans N min. » | Trop de phrases fausses d'affilée : la connexion est bloquée un moment, même avec la bonne. | Attends le nombre de minutes affiché. |
| « Pas de réseau, chérie. Réessaie. » | Le navigateur n'a pas pu joindre l'app. | Vérifie ta connexion internet. Si elle marche, ouvre l'adresse : une page « Site not available » veut dire que le site est en pause (ligne suivante). |
| Une page « Site not available » de Netlify | Tes crédits Netlify sont épuisés et **tous les sites de ton compte sont en pause**. | Attends le cycle mensuel suivant, ou passe à une offre Netlify payante. Tes données sont à l'abri dans Neon. |
| Une page « Page not found » à l'adresse `netlify.app` | L'app n'a jamais été publiée avec succès. | Onglet **Deploys** : attends **Published**, ou ouvre la ligne en échec. |
| Une publication marquée **Failed** | Netlify n'a pas pu construire l'app. | Ouvre-la et lis les dernières lignes rouges du journal. Si tu as modifié les réglages de build, remets `npm run build` et `dist`. |
| Le profil n'apparaît pas sur un autre appareil, ou « N en attente » ne disparaît jamais | L'app n'arrive pas à écrire dans la base : `NEON_DATABASE_URL` manque ou est fausse, ou la base est suspendue. | Compare `NEON_DATABASE_URL` dans Netlify avec l'adresse dans Neon (**Connect**), publie de nouveau, et regarde la page de ton projet Neon pour un message de limite. |
| Le coach affiche une erreur au lieu d'une réponse | Une clé d'IA manquante ou fausse, plus de crédit chez Anthropic, la limite de dépense atteinte, ou pas de liste d'exercices (étape 3b). | Vérifie les clés dans Netlify, ton solde et ta limite chez Anthropic, et la vérification de l'étape 3b. |
| Le coach répond, mais la console d'Anthropic n'affiche aucun usage | La clé Anthropic a été créée hors d'un espace de travail : Mistral répond à sa place. | Crée une nouvelle clé dans l'espace de travail (étape 7, point 5), remplace-la dans Netlify, publie de nouveau. |

### Garder l'app à jour

Quand l'app d'origine reçoit une nouvelle version, ta copie ne change pas toute seule. Pour la mettre à jour, **toujours dans cet ordre** :

1. **D'abord les tables.** Sur **ta copie sur GitHub**, la page affiche une ligne qui dit que ta copie est en retard (« This branch is … commits behind »). Avant de synchroniser, ouvre la page GitHub de l'app **d'origine** (celle que tu as copiée, en lien sous le nom de ta copie : « forked from … »), ouvre-y `netlify/functions/lib/schema.sql`, clique sur **Copy raw file**, colle-le dans le SQL Editor de Neon et clique sur **Run**. Le relancer sur une base à jour ne change rien, et la nouvelle version peut avoir besoin d'une nouvelle table ou colonne avant de tourner.
2. **Ensuite le code.** Sur la page GitHub de ta copie, clique sur **Sync fork**, puis **Update branch**. Netlify publie la nouvelle version tout seul, ce qui coûte des crédits.
3. Chaque copie ouverte de l'app propose ensuite de se recharger.

Ne relance **jamais** l'étape 3b pour « mettre à jour » la liste d'exercices : elle ne changerait rien, et ta liste est désormais la tienne (tu la modifies dans l'onglet **Exercices**).

### Sauvegardes

Dans l'app : **Profil → Export SQL (urgence)** télécharge un fichier `belle-forme-backup-<date>.sql` avec tes séances, ton programme, ton profil, tes réglages, la liste d'exercices, les notes et la conversation du coach. Fais-le régulièrement et range le fichier dans un endroit privé : il contient des données de santé.

Pour le restaurer, colle le contenu du fichier dans le SQL Editor de Neon et clique sur **Run**. **Ça remplace** le contenu de la base par celui de la sauvegarde.

### Tout arrêter

- Pour mettre l'app hors ligne : dans Netlify, ouvre **Project configuration** ; le bouton de suppression est en bas des réglages généraux (son libellé contient **Delete**).
- Pour effacer tes données : dans Neon, ouvre les **Settings** du projet ; le bouton de suppression est en bas (son libellé contient **Delete**). C'est irréversible : exporte d'abord une sauvegarde.
- Pour arrêter les frais d'IA : supprime les clés dans les consoles d'Anthropic et de Mistral.
