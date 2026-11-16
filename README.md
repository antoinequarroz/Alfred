# Alfred

Assistant personnel tout-en-un, auto-hébergé sur VPS. Premier chantier : le calendrier.

- **Calendrier** synchronisé avec Apple Calendar (CalDAV), fini la double saisie
- **Prise de rendez-vous en ligne** directement reliée au calendrier
- **Visioconférence auto-hébergée** pour remplacer progressivement Zoom/Teams
- Disponible en **web**, **app Mac** et **mobile**
- À terme : un assistant IA personnel par-dessus tout ça

## Documentation

- [Audit de faisabilité](docs/AUDIT.md) : ce qui est possible, coûts, risques et plan par phases
- [Installation de la phase 1](docs/PHASE1-INSTALL.md) : prise de RDV en ligne (Cal.com) synchronisée avec iCloud, config dans `deploy/calcom/`

## Statut

Phase 1 en cours : la config de la prise de RDV est prête dans `deploy/calcom/`, à déployer sur le VPS. Voir l'audit pour la feuille de route.
