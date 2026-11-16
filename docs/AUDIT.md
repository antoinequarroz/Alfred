# Audit de faisabilité — Alfred : calendrier, prise de RDV et visio auto-hébergés

_Version 1 — 16 novembre 2026_

## 1. Résumé (TL;DR)

**Oui, tout est faisable sur un VPS, pour environ 10 à 25 € par mois.** Mais tout n'a pas le même coût en effort :

| Besoin | Faisable ? | Effort | Remarque clé |
|---|---|---|---|
| Ne plus recopier les RDV dans Apple Calendar | ✅ Oui, facilement | Faible | Via CalDAV, le protocole qu'Apple Calendar parle nativement |
| Page de prise de RDV en ligne à toi | ✅ Oui | Faible (outil existant) à moyen (maison) | Cal.com ou Easy!Appointments auto-hébergés |
| Visio auto-hébergée (remplacer Zoom/Teams) | ✅ Oui | Moyen | Jitsi (clé en main) ou LiveKit (à intégrer dans ton app) |
| App web | ✅ Oui | — | Base de tout le reste |
| App Mac | ✅ Oui | Faible si web d'abord | Tauri ou simple PWA installée |
| App mobile iOS/Android | ✅ Oui | Moyen | PWA d'abord, app native ensuite si besoin |
| Remplacer **entièrement** Apple Calendar par ton propre calendrier | ⚠️ Possible mais déconseillé | Élevé | Refaire un bon calendrier est long ; mieux vaut que Apple Calendar affiche *ton* serveur |

**Recommandation courte :** ne pas tout réécrire. Faire de ton VPS la **source de vérité** (serveur CalDAV + prise de RDV + visio), et garder Apple Calendar (Mac, iPhone) comme simple *affichage*. Ton app à toi se concentre sur ce qu'Apple ne fait pas : la prise de RDV, les liens visio et le suivi clients.

---

## 2. Le problème actuel

Aujourd'hui, quand quelqu'un réserve sur ton site, tu reçois un événement (fichier iCal / .ics) et tu dois le reporter à la main dans Apple Calendar (iCloud). Il n'y a donc pas de lien automatique entre ton outil de réservation et ton calendrier, et les disponibilités affichées sur ton site ne connaissent pas forcément tes autres occupations.

Ce qu'il faut : **un seul endroit** qui connaît tes disponibilités réelles, accepte les réservations, crée automatiquement l'événement (avec le lien visio) et l'affiche partout.

---

## 3. Synchronisation avec Apple Calendar / iCloud

### 3.1 Comment Apple Calendar communique

Apple Calendar (macOS, iOS) parle **CalDAV**, un protocole ouvert. Deux façons d'en profiter :

**Option A — Se connecter à iCloud en CalDAV (iCloud reste le maître)**
- Ton serveur lit et écrit dans ton calendrier iCloud via `caldav.icloud.com`, avec un **mot de passe d'application** généré sur appleid.apple.com (le 2FA l'exige).
- ✅ Rien ne change pour toi : tes calendriers restent dans iCloud.
- ⚠️ Pas de notification instantanée : ton serveur doit interroger iCloud régulièrement (toutes les 1 à 5 min). Petit risque de double réservation dans cet intervalle.
- ⚠️ API non documentée officiellement par Apple pour un usage tiers, limites de débit possibles, et un changement côté Apple peut casser la synchro (rare, mais déjà arrivé à des outils tiers).

**Option B — Ton VPS devient le serveur de calendrier (recommandé à terme)**
- Tu installes un serveur CalDAV sur ton VPS (ex. **Radicale** ou **Baïkal**, légers et gratuits), ou ton app fait elle-même serveur CalDAV.
- Dans Apple Calendar, tu ajoutes un compte « CalDAV » pointant vers ton serveur. Tes RDV apparaissent sur Mac et iPhone comme n'importe quel calendrier.
- ✅ Tu es maître de tes données, la prise de RDV voit tes disponibilités en temps réel, plus de dépendance à iCloud pour ce calendrier.
- ⚠️ C'est toi qui gères les sauvegardes et la sécurité du serveur.
- Tu peux garder iCloud pour ton calendrier perso et ton serveur pour le pro, les deux s'affichent ensemble dans Apple Calendar.

**Verdict :** synchro bidirectionnelle possible dans les deux cas. Option A pour démarrer vite, option B pour la cible.

### 3.2 Ce qui n'est pas possible ou pas fiable
- Recevoir des notifications « push » instantanées depuis iCloud vers un serveur tiers : non (polling uniquement).
- Les abonnements « iCal » en lecture seule (URL .ics) se rafraîchissent lentement dans Apple Calendar (souvent toutes les 15 min à plusieurs heures) : à éviter comme solution principale.

---

## 4. Prise de rendez-vous en ligne

### 4.1 Outils open source existants

| | **Cal.com** (auto-hébergé) | **Easy!Appointments** | **Développement maison** |
|---|---|---|---|
| Techno | Next.js + PostgreSQL | PHP + MySQL | Au choix |
| Ressources VPS | ~2 Go RAM minimum | Très léger (512 Mo) | Selon le choix |
| Synchro calendrier | CalDAV (dont iCloud), Google, Outlook | CalDAV et Google (selon la version) | À coder (bibliothèques CalDAV disponibles) |
| Visio intégrée | Oui : Jitsi, Daily, Zoom, etc. via « apps » | Non natif (lien à ajouter) | Libre |
| Look & personnalisation | Très soigné, personnalisable | Plus daté | Total |
| Licence | AGPL (certaines fonctions « entreprise » sous licence payante) | GPL | — |
| Temps de mise en place | 1/2 à 1 journée | 1/2 journée | Plusieurs semaines |

### 4.2 Fonctions à prévoir (quel que soit l'outil)
- Types de RDV (durée, prix éventuel, questions au client), tampons avant/après, délai minimum de réservation.
- Lecture des disponibilités sur **tous** tes calendriers (perso + pro) pour éviter les conflits.
- E-mails de confirmation, rappels, annulation/report par le client. Il faut un **service d'envoi d'e-mails** (SMTP transactionnel : Brevo, Postmark, Infomaniak…), sinon les mails finissent en spam.
- Paiement en ligne optionnel (Stripe, Twint via Stripe ou Payrexx en Suisse).
- Intégration sur ton site actuel (widget ou lien).

**Verdict :** Cal.com auto-hébergé couvre ~90 % du besoin immédiatement. Le développement maison n'est justifié que si tu veux une expérience totalement intégrée à *ton* app (phase 3).

---

## 5. Visioconférence auto-hébergée

### 5.1 Les options

| | **Jitsi Meet** | **LiveKit** | **BigBlueButton** |
|---|---|---|---|
| Type | Application de visio complète, prête à l'emploi | Infrastructure (SFU) + SDK à intégrer | Classe virtuelle (tableau blanc, sondages…) |
| Intégration dans ton app | Iframe / SDK web, apps mobiles officielles | **Excellente** : SDK web, iOS, Android, React Native, Flutter | Difficile |
| Ressources pour un usage perso (1:1 à ~5 personnes) | 2–4 vCPU, 4–8 Go RAM | 2–4 vCPU, 4 Go RAM | 8 vCPU, 16 Go RAM, serveur dédié Ubuntu |
| Mise en place | Docker, ~1 h | Docker, ~1 h + développement de l'interface | Lourde |
| Pour toi | ✅ Démarrage immédiat | ✅ Cible si app maison | ❌ Surdimensionné |

### 5.2 Besoins réseau et serveur
- **Bande passante :** compter environ 1,5 à 3 Mbit/s par participant et par sens en HD. Une réunion d'1 h à 4 personnes consomme quelques Go. La plupart des VPS incluent 20 To/mois : aucun souci.
- **Appels à deux :** Jitsi passe en pair-à-pair, le serveur ne sert presque qu'à la mise en relation.
- **Serveur TURN (coturn) :** **indispensable** pour les clients derrière des réseaux d'entreprise ou d'hôpital restrictifs (fréquent en Suisse, ex. réseaux HES ou cantonaux). Il faut qu'il réponde en TLS sur le port 443. Jitsi et LiveKit en intègrent un ou se configurent avec coturn.
- **Ports à ouvrir :** 443/TCP, 10000/UDP (Jitsi) ou 7881/TCP + 50000–60000/UDP (LiveKit), 3478 (TURN).
- **Enregistrement des réunions :** possible (Jibri pour Jitsi, Egress pour LiveKit) mais gourmand : ~4 vCPU par enregistrement en cours. À prévoir seulement si nécessaire.

### 5.3 Limites honnêtes face à Zoom/Teams
- Qualité très bonne pour du 1:1 et des petits groupes. Pour 20+ participants, il faut un serveur plus costaud.
- Pas d'appel par téléphone (dial-in) sans un fournisseur SIP payant.
- Pas de « réseau mondial » : un participant très loin du VPS aura un peu plus de latence (sans importance pour la Suisse et l'Europe).
- Teams reste parfois imposé par certains clients ou employeurs : tu pourras réduire Zoom/Teams, peut-être pas les supprimer à 100 %.

**Verdict :** Jitsi pour démarrer tout de suite (et Cal.com génère automatiquement un lien Jitsi par RDV). LiveKit si tu construis ta propre app avec la visio intégrée.

---

## 6. Web, Mac et mobile

| Plateforme | Approche recommandée | Alternatives | Contraintes |
|---|---|---|---|
| **Web** | App web responsive (ex. SvelteKit ou Next.js) | — | Base commune de tout |
| **Mac** | **PWA** installée depuis Safari (« Ajouter au Dock ») puis **Tauri** si besoin d'une vraie app | Electron (plus lourd, ~100 Mo) | Hors App Store : signature + notarisation Apple (compte développeur requis) |
| **iPhone / Android** | **PWA** d'abord (notifications push possibles sur iOS depuis 16.4 si ajoutée à l'écran d'accueil) | Capacitor (réutilise le code web), React Native/Expo, Flutter | App Store : compte Apple Developer **99 $/an** et revue Apple. Google Play : 25 $ une fois |

Points à savoir :
- **Pour un usage personnel**, tu n'as pas besoin de publier sur l'App Store : la PWA suffit, ou une app installée via TestFlight (compte développeur nécessaire).
- La visio dans une PWA iOS fonctionne (WebRTC), mais la vidéo en arrière-plan et les notifications d'appel entrant (CallKit) demandent une app native.
- Le calendrier lui-même, sur Mac et iPhone, peut rester **Apple Calendar** branché sur ton serveur (section 3, option B) : zéro développement d'app nécessaire pour cette partie.

---

## 7. Dimensionnement du VPS

| Scénario | vCPU | RAM | Disque | Ordre de prix / mois |
|---|---|---|---|---|
| Prise de RDV + CalDAV seulement | 2 | 2–4 Go | 40 Go | 5–10 € |
| + Jitsi ou LiveKit (1:1 à ~5 personnes) | 4 | 8 Go | 80 Go | 10–20 € |
| + enregistrement des réunions | 8 | 16 Go | 160 Go+ | 30–50 € |

Hébergeurs : Hetzner (Allemagne/Finlande, très bon rapport prix), Infomaniak ou Exoscale (**données en Suisse**, utile pour la nLPD si tu reçois des données de clients/patients), OVH. Les prix varient ; ce sont des ordres de grandeur.

Si ton VPS actuel héberge déjà ton site, il est possible d'y ajouter la prise de RDV. Pour la visio, mieux vaut un serveur à part ou au moins 4 vCPU / 8 Go pour ne pas ralentir le site pendant un appel.

---

## 8. Coûts estimés

| Poste | Coût |
|---|---|
| VPS (RDV + calendrier + visio) | ~10–20 €/mois |
| Nom de domaine (si nouveau) | ~10–20 €/an |
| Envoi d'e-mails transactionnels | 0 € (offres gratuites pour petit volume) à ~10 €/mois |
| Sauvegardes externes (stockage objet) | ~1–3 €/mois |
| Apple Developer (seulement si app native / TestFlight / Mac signée) | 99 $/an |
| Google Play (seulement si app Android publiée) | 25 $ une fois |
| Logiciels (Cal.com, Jitsi, LiveKit, Radicale…) | 0 € (open source) |
| **Total réaliste** | **~15–25 €/mois**, + 99 $/an si app native |

À comparer avec : Zoom Pro, Calendly et similaires coûtent chacun de l'ordre de 10 à 15 €/mois.

Le vrai coût, c'est **ton temps** : mise en place (phase 1 : 1 à 2 jours), puis maintenance (mises à jour de sécurité, ~1 h/mois si automatisé).

---

## 9. Risques et limites

1. **Maintenance et sécurité :** un serveur exposé doit être mis à jour (mises à jour automatiques, pare-feu, fail2ban, HTTPS). Une panne = plus de prise de RDV ni de visio : prévoir une surveillance (ex. Uptime Kuma) et un plan B (lien Zoom/Teams de secours au début).
2. **Synchro iCloud :** dépend d'un accès non officiellement garanti par Apple. Mitigation : migrer vers l'option B (ton propre serveur CalDAV).
3. **Délivrabilité des e-mails :** sans SPF/DKIM/DMARC et un service SMTP propre, les confirmations partent en spam.
4. **Données personnelles (nLPD / RGPD) :** noms, e-mails, motifs de RDV de tes clients. Hébergement en Suisse ou UE, sauvegardes chiffrées, politique de confidentialité sur la page de réservation.
5. **Qualité visio en réseaux restrictifs :** sans TURN sur 443, certains participants ne pourront pas se connecter.
6. **Licence Cal.com :** cœur AGPL ; quelques fonctions avancées sont réservées à la version entreprise. À vérifier selon tes besoins.
7. **Ambition « tout maison » :** refaire un calendrier complet + RDV + visio + 3 apps est un projet de plusieurs mois. D'où le découpage en phases.

---

## 10. Recommandation par phases

### Phase 1 — Supprimer la double saisie (1 à 2 jours)
- VPS 4 vCPU / 8 Go avec Docker + reverse proxy HTTPS (Caddy ou Traefik).
- **Cal.com auto-hébergé**, connecté à ton iCloud en CalDAV (mot de passe d'application) : il lit tes disponibilités perso et écrit chaque RDV directement dans ton calendrier.
- **Jitsi Meet** auto-hébergé + TURN : chaque RDV reçoit automatiquement son lien visio.
- Remplacer l'outil de réservation actuel de ton site par la page Cal.com.
- ➡️ Résultat : plus aucune saisie manuelle, ta propre visio, ~15 €/mois.

### Phase 2 — Reprendre la main sur le calendrier (quelques jours)
- Serveur CalDAV à toi (Radicale/Baïkal) pour le calendrier pro, ajouté dans Apple Calendar sur Mac et iPhone.
- Cal.com branché sur ce serveur (synchro instantanée, plus de polling iCloud).
- Sauvegardes automatiques, surveillance, e-mails avec ton domaine.
- Tester la visio maison sur tes vrais RDV et réduire progressivement Zoom/Teams.

### Phase 3 — Ton app à toi (si les phases 1–2 ne suffisent pas)
- App web (PWA) : tableau de bord des RDV, fiches clients, notes, lancement de la visio intégrée (**LiveKit**).
- App Mac via Tauri, app mobile via Capacitor ou React Native, réutilisant le même code.
- Éventuellement remplacer Cal.com par une prise de RDV maison totalement intégrée.
- ➡️ À décider après avoir utilisé la phase 1 quelques semaines : tu sauras alors ce qui manque vraiment.

---

## 11. Hypothèses et questions ouvertes

**Hypothèses prises pour cet audit :**
- Usage solo (toi seul prends des RDV), volume modéré (quelques dizaines de RDV par mois).
- Visios surtout en 1:1 ou petits groupes (< 10 personnes).
- Clients majoritairement en Suisse / Europe.
- Pas d'obligation de publier les apps sur les stores.

**Questions pour toi :**
1. Quel est ton VPS actuel (hébergeur, CPU/RAM, système) et qu'héberge-t-il déjà ?
2. Avec quel outil ton site gère-t-il les réservations aujourd'hui (WordPress + plugin, Calendly, autre) ?
3. Quel type de RDV : consultations, cours, coaching ? Les données sont-elles sensibles (santé, par ex.) ?
4. Besoin de paiement en ligne à la réservation ?
5. Taille max des visios, et besoin d'enregistrement ?
6. Veux-tu garder iCloud pour le perso et un calendrier séparé pour le pro, ou tout migrer ?
7. Préfères-tu un outil prêt à l'emploi rapidement (phase 1) ou est-ce aussi un projet de développement que tu veux construire toi-même ?
