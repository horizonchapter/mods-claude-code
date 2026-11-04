// Relais : les consignes données à Claude et les contrôles du récap, sans rien de
// l'interface. Fonctions pures : les tests les réutilisent telles quelles.

export const FIN_RELAIS = 'Relais prêt'
export const MODELE_CONTROLE = 'sonnet'
// Au-delà de deux tours de complément, on passe quand même le relais, en notant ce qui reste flou.
export const TOURS_MAX = 2

// Ce que STATE.md doit contenir pour que la conversation soit effacée.
export const REPERES = [
  '## Reprise exacte',
  'Tâche en cours',
  'Plan',
  'Dernière action',
  'Fichiers touchés',
  'Prochaine action',
  'Ne pas refaire',
  '## Objectif',
  // « ## Demandes de l'utilisateur » (consigne du mod) ou « ## Demandes ouvertes » (CLAUDE.md de l'AIOS).
  '## Demandes',
  '## Décidé',
  '## Pièges déjà rencontrés',
  '## Attend une validation',
]
const TAILLE_MIN = 600
// La demande est d'environ 150 lignes ; au-delà de 180, le récap coûte plus qu'il ne
// sert à chaque reprise.
const LIGNES_MAX = 180
const TAILLE_MAX = 24_000

export const texteRelais = (racine: string, pct: string | null, archive: string) =>
  `Relais Jauge+${pct !== null ? ` (contexte à ${pct} %)` : ''} : cette conversation va être effacée. ` +
  `Le prochain Claude repartira UNIQUEMENT de ce que tu écris maintenant : il n'aura ni cette conversation, ni ta mémoire, ni ta liste de tâches. ` +
  `Il doit pouvoir reprendre exactement là où tu t'es arrêté, sans refaire ce qui est fait et sans rien sauter. ` +
  `N'avance pas la tâche maintenant : écris seulement la passation.\n\n` +
  `Dans le dossier du projet (${racine}), l'ancienne version est déjà sauvegardée dans ${archive}.\n\n` +
  `1. Réécris STATE.md, dans cet ordre :\n` +
  `   ## Reprise exacte (le plus important, sois précis)\n` +
  `   - Tâche en cours : ce que tu faisais et pour quelle demande de l'utilisateur.\n` +
  `   - Plan : les étapes de la tâche, une par ligne, [x] faite, [>] en cours, [ ] à faire. Recopie ta liste de tâches si tu en as une.\n` +
  `   - Dernière action : la toute dernière chose faite (fichier modifié, commande lancée) et son résultat exact (réussite, erreur et son message).\n` +
  `   - Fichiers touchés : chemin exact — ce qui y est fait — ce qui reste à y faire. Signale tout fichier laissé à moitié modifié.\n` +
  `   - Prochaine action : UNE action concrète (fichier, commande), le résultat attendu et comment vérifier qu'elle est réussie. Puis les deux suivantes.\n` +
  `   - Ne pas refaire : ce qui est déjà fait et vérifié dans cette tâche.\n` +
  `   ## Objectif — le but du projet et de cette session, en 2 ou 3 phrases.\n` +
  `   ## Où on en est — 3 lignes : ce qui marche, ce qui ne marche pas encore, ce qui bloque.\n` +
  `   ## Fait — ce qui sert encore pour la suite, avec la preuve (test passé, fichier créé). L'historique ancien est déjà dans .passations : ne le recopie pas.\n` +
  `   ## Demandes de l'utilisateur — ses demandes encore ouvertes, avec ses mots exacts entre guillemets ; ses préférences et sa façon de travailler.\n` +
  `   ## Décidé — chaque décision avec son pourquoi, et ce qui a été écarté (et pourquoi), pour ne pas le reproposer.\n` +
  `   ## Pièges déjà rencontrés — erreurs, impasses, ce qui ne marche pas, et le contournement trouvé.\n` +
  `   ## Fichiers, liens et chiffres clés — chemins exacts, liens, commandes utiles ; chaque chiffre étiqueté VÉRIFIÉ, ESTIMÉ, HYPOTHÈSE ou INCONNU.\n` +
  `   ## Attend une validation — ce qui ne doit pas se faire sans l'accord de l'utilisateur (publication, envoi, paiement, suppression…).\n` +
  `   ## Questions ouvertes\n` +
  `   Garde ce qui reste vrai de l'ancien STATE.md, corrige ce qui a changé, retire l'obsolète.\n` +
  `   Léger mais complet : environ 150 lignes au plus, des phrases courtes, des chemins plutôt que du contenu, pas de code recopié, pas de répétition entre sections.\n` +
  `2. Ajoute à la fin de DECISIONS.md (crée-le s'il n'existe pas) les décisions de cette conversation, une par ligne : AAAA-MM-JJ — décision — pourquoi.\n` +
  `3. Relis STATE.md comme si tu étais le nouveau Claude : pourrais-tu faire la prochaine action sans poser une seule question ? Une demande, un choix ou un piège de cette conversation manque-t-il ? Complète. Aucune clé ni mot de passe dans ces fichiers.\n` +
  `4. Ne modifie aucun autre fichier et ne lance rien d'autre.\n` +
  `Termine ta réponse par exactement : ${FIN_RELAIS}`

// Contrôle à froid : un modèle neuf lit seulement les fichiers, comme le prochain Claude.
export const SYSTEME_CONTROLE =
  `Tu es le prochain Claude d'un projet : la conversation précédente a été effacée et tu n'as que STATE.md et la fin de DECISIONS.md, donnés entre balises. ` +
  `Tu ne fais rien d'autre que dire ce que tu as compris et ce qui t'empêcherait de reprendre sans te tromper.\n\n` +
  `Réponds exactement sous cette forme :\n` +
  `<compris>3 lignes : où on en est, ce qui vient d'être fait, la prochaine action exacte.</compris>\n` +
  `<manques>\n- une question que tu devrais poser avant d'agir, une contradiction, un fichier ou une étape flou, une décision sans son pourquoi…\n</manques>\n\n` +
  `Ne signale que ce qui gênerait vraiment la reprise : ni le style, ni des détails inutiles. ` +
  `Si tu peux reprendre sans aucune question, écris exactement <manques>AUCUN</manques>.`

export const messageControle = (state: string, decisions: string) =>
  `<state>\n${state}\n</state>\n\n<decisions_fin>\n${decisions}\n</decisions_fin>`

export type Controle = { compris: string; manques: string[] }

export function lireControle(reponse: string): Controle | undefined {
  const compris = /<compris>([\s\S]*?)<\/compris>/.exec(reponse)?.[1]?.trim()
  const m = /<manques>([\s\S]*?)<\/manques>/.exec(reponse)?.[1]?.trim()
  if (!compris || m === undefined) return undefined
  const lignes = m.split('\n').map(l => l.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean)
  // « AUCUN », avec ou sans tiret, veut dire qu'il ne manque rien.
  const manques = lignes.length === 1 && /^AUCUN\.?$/i.test(lignes[0]!) ? [] : lignes
  return { compris, manques }
}

export const texteComplement = (c: Controle) =>
  `Contrôle du relais : un Claude neuf a lu seulement STATE.md et la fin de DECISIONS.md.\n\n` +
  `Ce qu'il a compris :\n${c.compris}\n\n` +
  `Ce qui l'empêche de reprendre sans se tromper :\n${c.manques.map(x => `- ${x}`).join('\n')}\n\n` +
  `Corrige dans STATE.md ce qu'il a mal compris et complète ce qui manque, à la bonne section, sans rallonger le reste. ` +
  `N'avance pas la tâche et ne modifie aucun autre fichier. Termine ta réponse par exactement : ${FIN_RELAIS}`

// Relances qui gardent le relais automatique au lieu de l'annuler (0.8) : un message de
// l'utilisateur ou un STATE.md modifié pendant le contrôle, ou une passation qui tarde.
export const REPRISES_MAX = 2
export const texteMiseAJour = (messageUtilisateur: boolean) =>
  (messageUtilisateur
    ? `Contrôle du relais : l'utilisateur a écrit pendant le relais. Ajoute sa demande, avec ses mots exacts, dans STATE.md (« Demandes de l'utilisateur », et dans « Reprise exacte » si elle change la prochaine action). `
    : `Contrôle du relais : STATE.md a changé pendant le contrôle. Vérifie qu'il est complet et à jour. `) +
  `N'avance pas la tâche et ne modifie aucun autre fichier. Termine ta réponse par exactement : ${FIN_RELAIS}`
export const texteRappel = () =>
  `Relais en attente : écris maintenant la passation dans STATE.md et DECISIONS.md comme demandé plus haut, sans avancer la tâche. ` +
  `Termine ta réponse par exactement : ${FIN_RELAIS}`

// Ce que le mod ajoute lui-même quand des points restent flous après les compléments.
export const notePointsFlous = (manques: string[]) =>
  `\n\n## Points flous signalés au relais\n` +
  `Le contrôle à froid n'a pas pu les lever avant l'effacement : vérifie-les dans les fichiers ou demande à l'utilisateur.\n` +
  manques.map(x => `- ${x}`).join('\n') +
  '\n'

// L'app de bureau garde l'ancien chat à l'écran après /clear, boutons compris : cette ligne
// marque la limite. Elle n'est pas envoyée au modèle.
export const LIGNE_CHAT_VIDE =
  "Chat vidé. Tout ce qui est au-dessus est l'ancien chat : Claude ne le voit plus, n'utilise plus ses boutons."

// Reprise sans attendre l'utilisateur (0.10, demande du 2026-11-04 : « il continue où il en
// était, il n'attend pas ma confirmation »).
export const texteReprise = (racine: string) =>
  `Reprise après relais : la conversation précédente a été effacée volontairement, tout ce qu'il faut savoir est dans les fichiers. ` +
  `L'utilisateur a demandé que la reprise soit automatique : continue la tâche tout de suite, sans attendre son accord, sans lui demander s'il faut continuer et sans proposer de choix. ` +
  `Pour cette reprise, la règle « Démarrage en un mot … attends mon OK » de CLAUDE.md ne s'applique pas.\n` +
  `1. Lis ${racine}/STATE.md en entier, puis la fin de ${racine}/DECISIONS.md.\n` +
  `2. Avant de modifier quoi que ce soit, vérifie l'état réel : les fichiers de « Fichiers touchés » existent et sont dans l'état décrit (relis les passages concernés) ; ` +
  `relance la vérification indiquée si elle n'a aucun effet de bord. Si l'état réel contredit STATE.md, dis-le en une ligne et fie-toi à l'état réel.\n` +
  `3. Si STATE.md contient un plan, recrée ta liste de tâches à l'identique (étapes faites cochées, étape en cours en cours).\n` +
  `4. Écris une ligne : où on en est et la prochaine action. Règle d'abord toi-même les « Points flous signalés au relais » à partir des fichiers.\n` +
  `5. Puis enchaîne directement la prochaine action et les suivantes du plan, sans refaire ce qui est dans « Ne pas refaire ». ` +
  `Arrête-toi seulement pour une action de « Attend une validation » ou irréversible / vers l'extérieur (push, publication, envoi, paiement, installation, suppression), ` +
  `ou si la prochaine action est d'attendre un message de l'utilisateur : dans ce cas dis-le en une ligne et arrête-toi, sans question.\n` +
  `6. Ne refais pas de passation et n'écris pas « ${FIN_RELAIS} » dans cette reprise.`

// Contrôle mécanique : ce qui doit être vrai avant même de lire le contenu.
export function defautsMecaniques(texte: string): string | undefined {
  const manque = REPERES.filter(r => !texte.includes(r))
  if (manque.length) return `il manque ${manque.join(', ')}`
  // Une section ## présente mais vide ne sert à rien à la reprise.
  const vides = texte
    .split(/^(?=## )/m)
    .filter(b => b.startsWith('## ') && !b.split('\n').slice(1).join('').trim())
    .map(b => b.split('\n')[0]!.trim())
  if (vides.length) return `section vide : ${vides.join(', ')}`
  if (texte.length < TAILLE_MIN) return 'la passation est trop courte'
  if (texte.length > TAILLE_MAX || texte.split('\n').length > LIGNES_MAX) return 'la passation est trop longue'
  return undefined
}

// La fin de DECISIONS.md suffit au contrôle : les décisions récentes.
export const finDecisions = (texte: string) => texte.split('\n').slice(-40).join('\n')
