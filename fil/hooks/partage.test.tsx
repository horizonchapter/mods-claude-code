import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// Deux conversations : celle-ci (A, dans 01-business) et d'autres qui ont déjà
// écrit leur fichier dans ~/.claude/fil-sessions.
const HOME = 'C:/Users/moi'
const DOSSIER = `${HOME}/.claude/fil-sessions`
const T0 = 1_800_000_000_000

function monde(on: On) {
  const horloge = mock.clock(on, { now: T0 })
  mock.store(on)
  const fichiers = new Map<string, { texte: string; mtime: number }>()
  const cle = (p: string) => p.replace(/\\/g, '/')

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'A' }))
  on('session.root', () => ({ value: 'C:/Users/moi/Desktop/Projets/01-business' }))
  on('env.get', (_, e) => ({ value: e.name === 'USERPROFILE' ? HOME : undefined }))
  on('command.register', () => ({ value: { command: 'fil' } }))
  on('fs.read', (_, e) => {
    const f = fichiers.get(cle(e.path))
    if (!f) throw new Error(`absent : ${e.path}`)
    return { value: f.texte }
  })
  on('fs.write', (_, e) => {
    fichiers.set(cle(e.path), { texte: e.text, mtime: horloge.now() })
    return { value: undefined }
  })
  on('fs.list', (_, e) => ({
    value: [...fichiers.entries()]
      .filter(([k]) => k.startsWith(`${cle(e.path ?? '')}/`))
      .map(([k, f]) => ({ name: k.split('/').pop()!, kind: 'file' as const, size: f.texte.length, mtimeMs: f.mtime, isLink: false })),
  }))
  on('ui.invalidate', () => ({ value: undefined }))
  const sons: string[] = []
  on('audio.play', (_, e) => {
    sons.push((e as { clip: { asset: string } }).clip.asset)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: {} }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  // Sous Fil, rien d'autre ne dessine dans la bande.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  const ecrire = (id: string, tache: object) =>
    fichiers.set(`${DOSSIER}/${id}.json`, { texte: JSON.stringify(tache), mtime: horloge.now() })
  const ecrireAutre = (id: string, titre: string, debut: number, nom: string, finiA?: number) =>
    ecrire(id, { titre, total: 3, faits: finiA ? 3 : 1, outil: '', debut, maj: debut, agents: {}, nom, finiA })
  return { horloge, fichiers, ecrire, ecrireAutre, sons }
}

// Les lignes principales de la bande, de haut en bas : p-<id> pour une liste de
// tâches, r-<id> pour une réponse sans liste.
async function lignes($: Engine) {
  const ui = await $.ui.mount({
    plugin: 'fil',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  } as never)
  const arbre = JSON.stringify(await ui.drawn())
  await ui.unmount()
  return [...arbre.matchAll(/"key":"([pr]-\w+)"/g)].map(m => m[1])
}

const demarrer = ($: Engine) => $.session.start({ cwd: 'C:/x', surface: 'desktop', isInteractive: true })

test('les barres des autres conversations apparaissent ici, la plus récente en haut', async ($, on) => {
  const w = monde(on)
  w.ecrireAutre('B', 'Écrire la fiche', T0 - 120_000, '02-content')
  w.ecrireAutre('C', 'Corriger le site', T0 - 30_000, '')
  await demarrer($)

  expect(await lignes($)).toEqual(['p-C', 'p-B'])
})

test('le plan de cette conversation va dans son propre fichier et passe au-dessus', async ($, on) => {
  const w = monde(on)
  w.ecrireAutre('B', 'Écrire la fiche', T0 - 60_000, '02-content')
  await demarrer($)
  await $.tool.call({
    tool: 'mcp__ccd_turn__update_plan',
    items: [
      { content: 'Étape un', status: 'in_progress' },
      { content: 'Étape deux', status: 'pending' },
    ],
  } as never)

  const a = JSON.parse(w.fichiers.get(`${DOSSIER}/A.json`)!.texte)
  expect(a.titre).toBe('Étape un')
  expect(a.nom).toBe('01-business')
  // Le fichier de l'autre conversation n'est pas touché.
  expect(JSON.parse(w.fichiers.get(`${DOSSIER}/B.json`)!.texte).titre).toBe('Écrire la fiche')
  expect(await lignes($)).toEqual(['p-A', 'p-B'])
})

test('une conversation muette depuis plus de 2 h est ignorée', async ($, on) => {
  const w = monde(on)
  w.ecrireAutre('B', 'Écrire la fiche', T0 - 60_000, '02-content')
  await w.horloge.advance(3 * 3_600_000)
  await demarrer($)

  expect(await lignes($)).toEqual([])
})

test('une réponse sans liste de tâches s’affiche aussi, ici et ailleurs', async ($, on) => {
  const w = monde(on)
  w.ecrire('B', { titre: '', total: 0, faits: 0, outil: 'Lecture', debut: T0, maj: T0, agents: {}, nom: '02-content', tour: { debut: T0 - 5_000 } })
  await demarrer($)
  await $.turn.start({ text: '', turnId: 't1' } as never)

  expect(JSON.parse(w.fichiers.get(`${DOSSIER}/A.json`)!.texte).tour.debut).toBe(T0)
  expect(await lignes($)).toEqual(['r-A', 'r-B'])

  await w.horloge.advance(3000)
  await $.turn.complete({ answer: 'ok', durationMs: 3000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  expect(JSON.parse(w.fichiers.get(`${DOSSIER}/A.json`)!.texte).tour.finA).toBe(T0 + 3000)
})

test('une tâche terminée reste visible des heures, puis /fil vider la ferme partout', async ($, on) => {
  const w = monde(on)
  w.ecrireAutre('B', 'Écrire la fiche', T0 - 7_200_000, '02-content', T0 - 3_600_000)
  await demarrer($)
  expect(await lignes($)).toEqual(['p-B'])

  const r = await $.command.run({ command: 'fil', args: 'vider', origin: { kind: 'composer' }, presentation: { layout: 'main', columns: 80 } } as never)
  expect(JSON.stringify(r)).toContain('fermée')
  expect(JSON.parse(w.fichiers.get(`${DOSSIER}/_fermes.json`)!.texte)['B:plan']).toBe(T0 - 7_200_000)
  // Le fichier de l'autre conversation n'est pas touché.
  expect(JSON.parse(w.fichiers.get(`${DOSSIER}/B.json`)!.texte).finiA).toBe(T0 - 3_600_000)
  expect(await lignes($)).toEqual([])
})

// Le texte des barres telles que le bureau les dessine.
async function dessin($: Engine) {
  const ui = await $.ui.mount({
    plugin: 'fil',
    component: 'AbovePrompt',
    surface: 'desktop',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  } as never)
  const arbre = JSON.stringify(await ui.drawn())
  await ui.unmount()
  return arbre
}

const plan = (statuts: string[]) =>
  ({ tool: 'mcp__ccd_turn__update_plan', items: statuts.map((status, i) => ({ content: `Étape ${i + 1}`, status })) }) as never

test('temps restant : estimé dès le départ, puis d’après la durée des étapes finies', async ($, on) => {
  const w = monde(on)
  await demarrer($)
  await $.tool.call(plan(['in_progress', 'pending', 'pending', 'pending']))
  // Avant la première étape : 4 × 90 s par défaut, soit environ 6 min.
  expect(await dessin($)).toContain('≈ 6 min')
  // La barre avance pendant l'étape, sans attendre qu'elle soit finie.
  expect(await dessin($)).toContain('>0 %<')
  await w.horloge.advance(60_000)
  expect(await dessin($)).not.toContain('>0 %<')

  // Une étape en 6 min (1 + 5), il en reste 3 : environ 18 min.
  await w.horloge.advance(5 * 60_000)
  await $.tool.call(plan(['completed', 'in_progress', 'pending', 'pending']))
  expect(await dessin($)).toContain('≈ 18 min')

  // 2 min plus tard, l'étape en cours a avancé : environ 16 min.
  await w.horloge.advance(2 * 60_000)
  expect(await dessin($)).toContain('≈ 16 min')

  // Finie : plus d'estimation.
  await $.tool.call(plan(['completed', 'completed', 'completed', 'completed']))
  expect(await dessin($)).not.toContain('≈')
})

test('une réponse qui s’arrête avant la fin de la liste met la barre en pause, avec un son', async ($, on) => {
  const w = monde(on)
  await demarrer($)
  await $.turn.start({ text: '', turnId: 't1' } as never)
  await $.tool.call(plan(['completed', 'in_progress', 'pending']))
  await w.horloge.advance(60_000)
  await $.turn.complete({ answer: 'Tu choisis A ou B ?', durationMs: 60_000, isAborted: false, turnId: 't1', reason: 'answer' } as never)

  const a = JSON.parse(w.fichiers.get(`${DOSSIER}/A.json`)!.texte)
  expect(a.attente).toBe(T0 + 60_000)
  expect(w.sons).toContain('fx/attente.mp3')
  expect(await dessin($)).toContain('à toi')

  // 10 min d'attente : le chrono reste figé, puis ne les compte pas à la reprise.
  await w.horloge.advance(10 * 60_000)
  expect(await dessin($)).toContain('1m 00s')
  await $.turn.start({ text: '', turnId: 't2' } as never)
  const b = JSON.parse(w.fichiers.get(`${DOSSIER}/A.json`)!.texte)
  expect(b.attente).toBeUndefined()
  expect(b.debut).toBe(T0 + 10 * 60_000)
  expect(await dessin($)).not.toContain('à toi')
})

test('un employé qui escalade vers son supérieur est signalé en ambre', async ($, on) => {
  const w = monde(on)
  w.ecrire('A', {
    titre: '',
    total: 0,
    faits: 0,
    outil: '',
    debut: T0,
    maj: T0,
    nom: '01-business',
    agents: { ag1: { n: 1, desc: 'Résumer les fichiers', modele: 'haiku 5.5', debut: T0 - 5_000, outil: 'Lecture' } },
  })
  await demarrer($)
  await $.turn.complete({
    answer: 'STATUT : ESCALADE → employe-sonnet (il faut corriger du code)\nRÉSUMÉ : …',
    durationMs: 5000,
    isAborted: false,
    turnId: 't2',
    reason: 'answer',
    agentId: 'ag1',
  } as never)

  const a = JSON.parse(w.fichiers.get(`${DOSSIER}/A.json`)!.texte)
  expect(a.agents.ag1.escalade).toBe('sonnet')
  const d = await dessin($)
  expect(d).toContain('↑ sonnet')
  expect(d).toContain('1 ↑ escaladé')
})
