import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

// Cap : quand Claude sait quoi faire ensuite (plan validé dans la conversation), il enchaîne
// seul, dans la même réponse (consigne ajoutée à ses instructions).
// Par défaut, Cap ne montre rien. Il ouvre « Et maintenant, on fait quoi ? » seulement quand la
// réponse termine clairement le travail sans suite prévue : pas d'étape annoncée, pas de travail
// en cours ou en attente (sous-agent, liste de tâches), pas de question. Dans le doute, rien.
// Rien n'est envoyé sans clic. Lit la réponse de Claude et la « Prochaine action » de STATE.md,
// jamais tes prompts (seulement leur origine). L'appel à Haiku est à part.

// Ajoutée aux instructions de Claude : il enchaîne lui-même ce qui est déjà décidé.
const CONSIGNE =
  "Enchaînement (mod Cap) : quand la suite fait partie du plan validé avec l'utilisateur dans cette conversation, " +
  "enchaîne-la toi-même dans la même réponse, sans t'arrêter pour l'annoncer et sans demander « Veux-tu que je " +
  "continue ? » pour une étape déjà décidée. Ne reprends pas de toi-même la « Prochaine action » de STATE.md : " +
  "seulement si l'utilisateur a demandé de reprendre. Demande toujours avant une action irréversible ou vers " +
  "l'extérieur (push, déploiement, publication, envoi, installation, paiement, suppression ou écrasement sans " +
  "sauvegarde). Arrête-toi aussi pour un choix qui revient à l'utilisateur, une information qui te manque, " +
  "l'attente d'un travail en arrière-plan, ou quand tout ce qui était prévu est fait. Si un point d'ajustement " +
  "avec l'utilisateur te semble utile avant de continuer, arrête-toi et dis-le en une phrase."

const SYSTEME =
  "Tu aides à piloter un assistant de code. On te donne la fin de sa dernière réponse et la prochaine action " +
  'notée dans le projet.\n' +
  'Première ligne, un seul mot :\n' +
  "- FIN_SANS_SUITE seulement si la réponse termine clairement tout le travail demandé et que rien n'est prévu : " +
  "aucune étape annoncée, aucun travail lancé ou en attente (sous-agent, tâche de fond, « pendant que… », " +
  "« en attendant »), aucune question ni validation demandée ; ou si l'assistant s'arrête pour proposer un point " +
  "d'ajustement ;\n" +
  '- RIEN dans tous les autres cas, et dans le doute.\n' +
  'Si FIN_SANS_SUITE, ajoute ensuite exactement 3 lignes : 3 prochaines actions concrètes tirées du contexte, ' +
  "jamais génériques, à l'impératif, en français, 55 caractères maximum, sans numéro ni puce ni guillemets. " +
  'Une action irréversible ou vers l’extérieur s’écrit « Préparer … », jamais « Publier », « Envoyer » ni ' +
  '« Déployer ». Rien d’autre.'

const MASQUER = 'Masquer'
// Rendus du prompt où la consigne n'a pas sa place.
const SANS_CONSIGNE = ['teammate', 'bare', 'analysis']
// La réponse annonce une suite ou un travail qui continue : pas besoin de Haiku pour le voir.
const SUITE_ANNONCEE =
  /\b(while I|meanwhile|in the meantime|I'll now|next,? I'll|en attendant|pendant que|je continue|je reviens|je passe (maintenant )?à|je vais maintenant|ensuite,? je)/i

// Seul le bloc « Prochaine action » de STATE.md (jusqu'au titre suivant).
async function lireProchaineAction($: EngineInterface) {
  const chemin = `${await $.session.root()}/STATE.md`
  if (!(await $.fs.exists(chemin))) return ''
  const texte = await $.fs.read(chemin)
  if (typeof texte !== 'string') return ''
  const debut = texte.search(/^.*prochaine action.*$/im)
  if (debut < 0) return ''
  const bloc = texte.slice(debut)
  const fin = bloc.slice(1).search(/^#/m)
  return (fin < 0 ? bloc : bloc.slice(0, fin + 1)).trim().slice(0, 400)
}

// Un sous-agent ou une tâche de fond est encore actif : sa fin relancera Claude.
async function travailEnCours($: EngineInterface) {
  try {
    return (await $.agent.list()).some(a => a.status === 'pending' || a.status === 'running' || a.status === 'waiting')
  } catch {
    return false
  }
}

// Une invite envoyée par un mod (relais de Jauge+, contrôle, reprise), pas par toi.
const venantDunMod = (o: PromptOrigin) => o.kind === 'plugin' && !o.asUser

// `aJour` : faux dès que la conversation a bougé ; on abandonne alors sans rien montrer ni envoyer.
async function proposer($: EngineInterface, reponse: string, aJour: () => boolean, signal: AbortSignal) {
  if ((await $.session.surfaces()).length === 0) return // personne pour cliquer
  if (await travailEnCours($)) return
  const action = await lireProchaineAction($).catch(() => '')
  if (!aJour()) return
  const prompt =
    (action ? `Prochaine action notée (STATE.md) :\n${action}\n\n` : '') +
    `Fin de la dernière réponse de l'assistant :\n${reponse.slice(-1500)}`
  const r = await $.model.complete(
    { model: 'haiku', system: SYSTEME, prompt, maxTokens: 150, effort: 'low', timeoutMs: 20_000 },
    { signal },
  )
  if (!r.isAnswered || !aJour()) return
  const [tete = '', ...reste] = r.text.trim().split('\n')
  if (!tete.trim().toUpperCase().startsWith('FIN_SANS_SUITE')) return

  const suites = reste
    .map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^["«]\s*|\s*["»]$/g, '').trim())
    .filter(l => l.length > 2 && l !== MASQUER)
    .slice(0, 3)
  if (suites.length < 2) return
  // Revérifié juste avant d'ouvrir : un sous-agent a pu démarrer pendant l'appel à Haiku.
  if (!aJour() || (await travailEnCours($)) || !aJour()) return
  let choix: string
  try {
    choix = await $.ui.ask('Et maintenant, on fait quoi ?', { header: 'Suite', options: [...suites, MASQUER] })
  } catch {
    return // « Passer » ou fermé
  }
  // Le dialogue ne peut pas être fermé de force : un choix arrivé après un nouveau tour est ignoré.
  const t = choix.trim()
  if (t && t !== MASQUER && aJour()) await $.prompt.submit({ text: t, asUser: true })
}

type Etape = { status?: string }
type Plan = { items?: Etape[]; advance?: boolean; done?: number[]; start?: number }

export const register: Register = on => {
  // Compteur d'activité de la conversation principale (début de tour, appel d'outil), sans lire de texte.
  let activite = 0
  // Le prochain tour vient-il d'un mod ? Et le tour en cours ?
  let prochainParMod = false
  let tourParMod = false
  // Une seule décision à la fois ; remis à zéro à chaque nouveau tour.
  let enCours = false
  let arret: AbortController | undefined
  // Statuts de la liste de tâches de Claude (outil update_plan), pour savoir s'il reste des étapes.
  let plan: string[] = []

  const bouger = () => {
    activite++
    arret?.abort() // coupe l'appel à Haiku en cours
  }

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (e.traits.some(t => SANS_CONSIGNE.includes(t))) return r
    return { sections: [...r.sections, { id: 'cap:enchainer', text: CONSIGNE, scope: 'session' as const }] }
  })

  // Seule l'origine est lue, jamais le texte.
  on('prompt.submit', async ($, e, next) => {
    if (!e.turnId) prochainParMod = venantDunMod(e.origin)
    return next(e)
  }).catch(($, e, next) => next(e)) // Cap ne bloque jamais une invite

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      bouger()
      tourParMod = prochainParMod
      prochainParMod = false
      enCours = false
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined && e.tool !== 'AskUserQuestion') {
      bouger()
      const p = e as unknown as Plan
      if (e.tool === 'mcp__ccd_turn__update_plan') {
        if (Array.isArray(p.items)) plan = p.items.map(i => i.status ?? 'pending')
        if (p.advance) {
          const i = plan.indexOf('in_progress')
          if (i >= 0) plan[i] = 'completed'
          const j = plan.indexOf('pending')
          if (j >= 0) plan[j] = 'in_progress'
        }
        for (const n of p.done ?? []) plan[n - 1] = 'completed'
        if (p.start) plan[p.start - 1] = 'in_progress'
      }
      if (e.tool === 'mcp__ccd_turn__wrap_up') plan = [] // coche toute la liste
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // ni un outil

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    const reponse = e.answer.trim()
    if (e.agentId || e.reason !== 'answer' || e.isAborted || tourParMod || enCours) return res
    if (plan.some(s => s === 'pending' || s === 'in_progress')) return res
    // Trop court, une question, une suite annoncée, ou le relais de Jauge+ qui gère lui-même la suite.
    if (reponse.length <= 40 || /\?[\s*_)»"]*$/.test(reponse) || SUITE_ANNONCEE.test(reponse)) return res
    if (/relais prêt/i.test(reponse)) return res
    enCours = true
    const monActivite = activite
    const controle = new AbortController()
    arret = controle
    const aJour = () => activite === monActivite && !controle.signal.aborted
    void proposer($, reponse, aJour, controle.signal)
      .catch(() => undefined)
      .finally(() => {
        if (activite === monActivite) enCours = false
      })
    return res
  })
}
