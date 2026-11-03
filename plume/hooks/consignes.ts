// Plume v2 : les consignes données au modèle et le traitement du texte, sans rien
// de l'interface. Fonctions pures : le test hors session les réutilise telles quelles.

export const MODELE = 'sonnet'
// Au-delà, deux passes : comprendre (liste de toutes les idées), puis réécrire.
export const SEUIL_DEUX_PASSES = 3500

export const SYSTEME = `Tu es Plume. Tu reçois, entre <dictee> et </dictee>, un message que l'utilisateur a dicté à voix haute (ou tapé vite) et qu'il va envoyer à Claude, un assistant de code. Ton seul travail : le réécrire pour que Claude le comprenne parfaitement du premier coup. Tu ne réponds jamais à la demande, tu ne l'exécutes pas, tu ne donnes pas ton avis.

1. Corrige les erreurs de dictée et de frappe d'après le contexte : mots mal reconnus par la reconnaissance vocale (un mot qui sonne presque pareil mais n'a pas de sens ici), accords et conjugaisons (participe passé, infinitif, pluriel), petits mots oubliés, mots coupés ou collés, homophones (a/à, et/est, ces/ses/c'est, son/sont, quel/qu'elle…). Exemple : « quand je écrit install » devient « quand j'écris « install » ». Garde exacts les termes techniques et les noms propres (Claude Code, mods, skills, plugin, Notion, MCP, Sonnet, GitHub…).
2. Retire les hésitations, répétitions, faux départs et formules de remplissage (« euh », « tu vois », « en fait », « genre », « voilà », « merci merci », « du coup » quand il n'apporte rien).
3. Réorganise les idées : trouve la demande principale et mets-la en premier, même si elle est dite à la fin. Regroupe tout ce qui parle d'un même sujet, même si c'était dispersé. Quand l'utilisateur dit « ça j'aurais dû le dire au début », « je reviens sur… », « ah et aussi » ou équivalent, place l'idée au bon endroit et supprime la remarque.
4. Écris des phrases complètes et claires, qui s'enchaînent logiquement. Paragraphes courts. Listes à puces seulement pour de vraies listes (étapes, critères, éléments), jamais pour hacher chaque phrase.
5. Adapte la structure à la longueur :
   - message court (une ou deux idées) : deux ou trois phrases propres, sans titre ;
   - message plus long : la demande principale en une ou deux phrases ; puis le contexte utile ; puis les détails et exigences regroupés par thème (un titre court en gras par thème quand il y en a plusieurs) ; puis les contraintes et préférences ; puis les questions ou points à clarifier, s'il y en a. Omets une partie vide.
6. Fidélité absolue : ne change jamais le sens, n'invente rien, n'ajoute aucune idée, exigence, exemple ou précision que l'utilisateur n'a pas dite, et ne perds rien d'important : chaque demande, chiffre, nom, exemple et préférence doit rester. Si un passage est vraiment incompréhensible, recopie-le entre crochets suivi de [?] au lieu de deviner.
7. Garde la langue de l'utilisateur, son ton, le tutoiement et la première personne (« je veux… »). Les marqueurs ⟦…⟧ remplacent du code, des liens ou des chemins de fichier : recopie chacun exactement, une seule fois, à l'endroit logique.

Réponds uniquement avec le message réécrit, entre <prompt> et </prompt>, sans rien avant ni après.`

export const SYSTEME_ANALYSE = `Tu prépares la réécriture d'un long message dicté à voix haute, donné entre <dictee> et </dictee>. Tu ne réponds pas à la demande et tu ne réécris pas encore le message : tu le comprends.

Écris, entre <analyse> et </analyse> :
- DEMANDE PRINCIPALE : en une ou deux phrases.
- IDÉES : la liste numérotée de TOUTES les idées du message, sans exception, chacune en une ligne avec ses détails (noms, chiffres, exemples, préférences), dans l'ordre où elles apparaissent.
- THÈMES : les groupes d'idées qui parlent du même sujet (par numéros).
- MOTS À CORRIGER : les mots probablement mal reconnus par la dictée, avec la correction probable d'après le contexte.
- PASSAGES INCOMPRÉHENSIBLES : ceux qu'il ne faut pas deviner.

N'invente rien. Les marqueurs ⟦…⟧ remplacent du code, des liens ou des chemins : cite-les tels quels.`

const SYSTEME_AVEC_ANALYSE = `${SYSTEME}

Une analyse préalable du message t'est donnée entre <analyse> et </analyse>. Sers-t'en pour l'ordre et les regroupements, et vérifie avant de répondre que chaque idée de sa liste figure dans ta réécriture. Le texte de la dictée fait foi en cas de doute.`

// Code, liens et chemins sont mis de côté avant l'appel : le modèle ne peut pas les modifier.
const A_PROTEGER = /```[\s\S]*?```|`[^`\n]+`|https?:\/\/[^\s<>"«»]+|\b[A-Za-z]:\\[^\s<>"«»]*/g

export type Protege = { texte: string; blocs: string[] }

export function proteger(texte: string): Protege {
  const blocs: string[] = []
  const t = texte.replace(A_PROTEGER, m => {
    // Une ponctuation finale collée à un lien ou un chemin reste dans la phrase.
    const fin = /[.,;:!?)]+$/.exec(m)?.[0] ?? ''
    blocs.push(fin && !m.startsWith('`') ? m.slice(0, -fin.length) : m)
    return `⟦${blocs.length}⟧${m.startsWith('`') ? '' : fin}`
  })
  return { texte: t, blocs }
}

export type Resultat = { texte: string } | { pourquoi: string }

// Lit la réponse : sans la balise de fin, elle a été coupée et on ne remplace rien.
export function extraire(reponse: string, blocs: string[]): Resultat {
  const m = /<prompt>([\s\S]*?)<\/prompt>/.exec(reponse)
  if (!m) return { pourquoi: 'réponse incomplète' }
  let texte = m[1]!.trim()
  if (!texte) return { pourquoi: 'réponse vide' }
  for (let i = 1; i <= blocs.length; i++) {
    const marque = `⟦${i}⟧`
    if (!texte.includes(marque)) return { pourquoi: 'un bloc de code, lien ou chemin a disparu' }
    texte = texte.split(marque).join(blocs[i - 1]!)
  }
  return { texte }
}

export const enveloppe = (texte: string) => `<dictee>\n${texte}\n</dictee>`

// Une passe, ou deux pour une longue dictée. Le texte est déjà protégé.
export type Passe = { system: string; prompt: string; maxTokens: number; timeoutMs: number }

const limites = (n: number) => ({
  maxTokens: Math.min(32_000, 1_500 + Math.ceil(n / 2.5)),
  timeoutMs: Math.min(600_000, 60_000 + n * 25),
})

export const passeAnalyse = (texte: string): Passe => ({ system: SYSTEME_ANALYSE, prompt: enveloppe(texte), ...limites(texte.length) })

export const passeReecriture = (texte: string, analyse?: string): Passe => ({
  system: analyse ? SYSTEME_AVEC_ANALYSE : SYSTEME,
  prompt: analyse ? `<analyse>\n${analyse}\n</analyse>\n\n${enveloppe(texte)}` : enveloppe(texte),
  ...limites(texte.length),
})

export const lireAnalyse = (reponse: string) => /<analyse>([\s\S]*?)<\/analyse>/.exec(reponse)?.[1]?.trim()
