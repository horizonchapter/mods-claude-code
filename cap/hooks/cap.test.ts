import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const FINI = 'Tout ce qui était prévu est fait : la page produit est en place et vérifiée.'
const VERDICT_FIN = 'FIN_SANS_SUITE\nÉcrire les tests\nPréparer la mise en ligne\nRelire le texte'

// Cap décide en arrière-plan, juste après la fin de la réponse : on lui laisse le temps.
// (Le lanceur de tests fournit setTimeout ; les types du mod ne le déclarent pas.)
declare const setTimeout: (f: (v?: unknown) => void, ms: number) => unknown
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

type Options = {
  agents?: { status: string }[] // ce que $.agent.list renvoie
  surfaces?: string[] // ce que $.session.surfaces renvoie
  clic?: string // l'option cliquée dans le dialogue (sinon il est fermé)
  lenteur?: number // durée de l'appel à Haiku, en ms
}

// verdict : ce que Haiku répond.
function monde(on: On, verdict: string, o: Options = {}) {
  const envoyes: string[] = []
  const dialogues: string[][] = []
  const appels = { haiku: 0 }
  on('session.root', () => ({ value: 'C:/Users/moi/Desktop/Projets/01-business' }))
  on('session.surfaces', () => ({ value: o.surfaces ?? ['terminal'] }) as never)
  on('fs.exists', () => ({ value: false }))
  const agents = o.agents ?? []
  on('agent.list', () => ({ value: agents.map((a, i) => ({ id: `a${i}`, description: 'x', type: 'general-purpose', ...a })) }) as never)
  on('model.complete', async () => {
    appels.haiku++
    if (o.lenteur) await pause(o.lenteur)
    return { value: { isAnswered: true, text: verdict, usage: USAGE } } as never
  })
  // Le dialogue « Et maintenant, on fait quoi ? » est l'outil AskUserQuestion : on note ses choix,
  // puis on clique l'option demandée ou on le ferme.
  const dialogue = (_: unknown, e: { questions: { question: string; options: { label: string }[] }[] }) => {
    const q = e.questions[0]
    dialogues.push(q ? q.options.map(x => x.label) : [])
    if (!o.clic || !q) return { deny: 'fermé par le test' }
    return { result: { questions: e.questions, answers: { [q.question]: o.clic } } }
  }
  // Typé à la main : les types de tool.call avec matcher sont trop lourds pour tsc ici.
  const brancher = on as unknown as (evt: string, matcher: object, hook: (...a: never[]) => unknown) => void
  brancher('tool.call', { tool: 'AskUserQuestion' }, dialogue)
  brancher('tool.call', { tool: 'mcp__ccd_turn__update_plan' }, () => ({ result: 'ok' }))
  on('prompt.submit', (_, e) => {
    envoyes.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'Tu es Claude.', scope: 'shared' }] }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return { envoyes, dialogues, appels }
}

const finTour = ($: Engine, answer: string, extra: object = {}) =>
  $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', ...extra } as never)
const fin = async ($: Engine, answer = FINI, extra: object = {}) => {
  await finTour($, answer, extra)
  await pause(30)
}
const compose = ($: Engine, traits: string[] = []) =>
  $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits } as never)

test('Claude reçoit la consigne d’enchaîner seul le plan validé, et de demander avant l’irréversible', async ($, on) => {
  monde(on, 'RIEN')
  const cap = (await compose($)).sections.find(s => s.id === 'cap:enchainer')
  expect(cap?.text).toContain('enchaîne-la toi-même dans la même')
  expect(cap?.text).toContain('Veux-tu que je continue ?')
  expect(cap?.text).toContain('push, déploiement')
  expect(cap?.text).not.toContain('Cap lui proposera')
  expect(cap?.scope).toBe('session')
})

test('pas de consigne pour un coéquipier ni pour /context', async ($, on) => {
  monde(on, 'RIEN')
  for (const trait of ['teammate', 'analysis']) {
    const r = await compose($, [trait])
    expect(r.sections.some(s => s.id === 'cap:enchainer')).toBe(false)
  }
})

test('travail clairement fini : Cap propose 3 suites, et rien si on ferme le dialogue', async ($, on) => {
  const w = monde(on, VERDICT_FIN)
  await fin($)
  expect(w.dialogues).toEqual([['Écrire les tests', 'Préparer la mise en ligne', 'Relire le texte', 'Masquer']])
  expect(w.envoyes).toHaveLength(0)
})

test('un clic envoie l’option choisie, comme si tu l’avais tapée', async ($, on) => {
  const w = monde(on, VERDICT_FIN, { clic: 'Relire le texte' })
  await fin($)
  expect(w.envoyes).toEqual(['Relire le texte'])
})

test('par défaut (RIEN), Cap ne montre rien', async ($, on) => {
  const w = monde(on, 'RIEN')
  await fin($)
  expect(w.appels.haiku).toBe(1)
  expect(w.dialogues).toHaveLength(0)
})

test('une étape annoncée : ni Haiku ni dialogue, Claude enchaîne', async ($, on) => {
  const w = monde(on, VERDICT_FIN)
  await fin($, 'Étape 2 faite, les tests passent. Je passe maintenant à l’étape 3 : écrire la page produit.')
  expect(w.appels.haiku).toBe(0)
  expect(w.dialogues).toHaveLength(0)
})

test('« while I… » avec un sous-agent en fond : aucun dialogue', async ($, on) => {
  const w = monde(on, VERDICT_FIN, { agents: [{ status: 'running' }] })
  await fin($, "Backups complete. I'll delegate the cap fix to a dedicated agent while I handle the relais myself.")
  expect(w.appels.haiku).toBe(0)
  expect(w.dialogues).toHaveLength(0)
})

test('un sous-agent en attente, lancé ou en pause : Cap ne demande même pas à Haiku', async ($, on) => {
  const agents = [{ status: 'pending' }]
  const w = monde(on, VERDICT_FIN, { agents })
  for (const status of ['pending', 'running', 'waiting']) {
    agents[0] = { status }
    await fin($)
  }
  expect(w.appels.haiku).toBe(0)
  expect(w.dialogues).toHaveLength(0)
})

test('liste de tâches avec des étapes restantes : rien', async ($, on) => {
  const w = monde(on, VERDICT_FIN)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'a', status: 'in_progress' }] } as never)
  await fin($)
  expect(w.appels.haiku).toBe(0)
})

test('tour d’un sous-agent, tour interrompu, réponse en question : ignorés', async ($, on) => {
  const w = monde(on, VERDICT_FIN)
  await fin($, FINI, { agentId: 'a1' })
  await fin($, FINI, { isAborted: true, reason: 'aborted' })
  await fin($, 'La page est en place. Tu veux que je la relise avec toi ?')
  expect(w.appels.haiku).toBe(0)
})

test('« Relais prêt » de Jauge+ : ignoré', async ($, on) => {
  const w = monde(on, VERDICT_FIN)
  await fin($, 'RELAIS PRÊT : passation écrite dans .passations, la nouvelle session reprendra.')
  expect(w.appels.haiku).toBe(0)
})

test('tour lancé par un mod (relais, contrôle, reprise) : ignoré ; tour suivant normal', async ($, on) => {
  const w = monde(on, VERDICT_FIN)
  await $.prompt.submit({ text: 'relais', origin: { kind: 'plugin', name: 'jauge-plus' }, wait: false } as never)
  await $.turn.start({ text: '', turnId: 't1' })
  await fin($)
  expect(w.appels.haiku).toBe(0)
  await $.prompt.submit({ text: 'suite', origin: { kind: 'composer' }, wait: false } as never)
  await $.turn.start({ text: '', turnId: 't2' })
  await fin($)
  expect(w.appels.haiku).toBe(1)
})

test('pas d’écran pour cliquer : pas d’appel à Haiku', async ($, on) => {
  const w = monde(on, VERDICT_FIN, { surfaces: [] })
  await fin($)
  expect(w.appels.haiku).toBe(0)
})

test('un nouveau tour commence pendant que Haiku réfléchit : pas de dialogue périmé', async ($, on) => {
  const w = monde(on, VERDICT_FIN, { lenteur: 20 })
  await finTour($, FINI)
  await $.turn.start({ text: '', turnId: 't2' })
  await pause(60)
  expect(w.dialogues).toHaveLength(0)
})
