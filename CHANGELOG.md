# Changelog

## 1.0.4 : 2026-11-04
- Jauge+ `0.10.0` : un « Relais prêt » écrit par Claude en fin de passation lance seul le contrôle, le vidage du chat et la reprise ; la reprise enchaîne la tâche sans attendre ton accord ; la section « Demandes ouvertes » est acceptée.
- Cap `0.9.0` : la question de fin « Et maintenant, on fait quoi ? » est désactivée par défaut et se rallume avec `/cap question on`.

## 1.0.3 : 2026-11-03
- Jauge+ `0.9.0` : après chaque `/clear` (le tien ou celui du relais), une ligne « Chat vidé » sépare l'ancien chat du nouveau. L'app de bureau garde l'ancien chat et ses boutons à l'écran ; la ligne n'est pas envoyée au modèle.

## 1.0.2 : 2026-11-03
- Jauge+ `0.8.0` : le relais reste automatique. Si tu écris pendant le relais ou si STATE.md change pendant le contrôle, ta demande est inscrite dans STATE.md, le contrôle est refait et le relais continue (avant, il s'annulait). Une passation qui tarde est relancée, deux fois au maximum.

## 1.0.1 : 2026-11-03
- Fil `0.11.2` : toute question de Claude sonne l'attente, même après une liste finie ou sans liste ; la pause ambre reste réservée à une liste en cours.

## 1.0.0 : 2026-11-03
- Première version publique.
- Quatre mods indépendants : Jauge+ `0.7.0` (jauge de contexte, relais), Cap `0.8.0` (suites cliquables), Fil `0.11.1` (barres de progression), Plume `0.5.0` (réécriture de prompt).
