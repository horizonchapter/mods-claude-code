# STATE.md (exemple fictif)

## Reprise exacte
- Tâche en cours : ajouter l'export CSV des commandes dans la boutique de démonstration.
- Plan : 1) fonction d'export (faite) ; 2) bouton dans l'écran Commandes (en cours) ; 3) test avec 3 commandes fictives ; 4) mise à jour du README.
- Dernière action : création de `src/export.ts` avec la fonction `exporterCommandes()`, test unitaire au vert.
- Fichiers touchés : `src/export.ts`, `src/export.test.ts`, `src/ecrans/Commandes.tsx` (bouton posé, pas encore relié).
- Prochaine action : relier le bouton « Exporter » de `Commandes.tsx` à `exporterCommandes()`, puis lancer `npm test` ; réussi si les 12 tests passent.
- Ne pas refaire : l'export en JSON (écarté, voir « Décidé »).

## Objectif
Permettre à l'équipe de télécharger les commandes du mois en CSV, sans passer par la base de données. Cette session termine la partie export.

## Où on en est
Ça marche : la fonction d'export et son test. Ça ne marche pas encore : le bouton n'est relié à rien. Rien ne bloque.

## Fait
- `src/export.ts` créé, test `export.test.ts` passé (VÉRIFIÉ : 12 tests sur 12).

## Demandes de l'utilisateur
- « Un seul fichier CSV, séparateur point-virgule, ouvrable directement dans Excel. »
- Préfère les réponses courtes, en français.

## Décidé
- CSV avec point-virgule, parce que le tableur de l'équipe est en français et lit mal la virgule.
- JSON écarté : personne ne sait l'ouvrir dans l'équipe.

## Pièges déjà rencontrés
- Les accents s'affichaient mal dans Excel : ajouter un BOM UTF-8 en début de fichier règle le problème.

## Fichiers, liens et chiffres clés
- Export : `src/export.ts` ; écran : `src/ecrans/Commandes.tsx` ; test : `npm test`.
- Volume attendu : environ 300 commandes par mois (ESTIMÉ).

## Attend une validation
- Publication de la nouvelle version : seulement après accord de l'utilisateur.

## Questions ouvertes
- Faut-il aussi exporter les commandes annulées ?
