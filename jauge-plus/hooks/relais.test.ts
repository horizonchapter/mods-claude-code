import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { On } from 'claude-code'

import { defautsMecaniques, lireControle } from './passation'

// Un projet en mémoire : chaque fichier garde son texte et l'heure de sa dernière écriture.
const PROJET = 'C:/Users/moi/Desktop/Projets/01-business'
const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const STATE_COMPLET =
  '# STATE\n\n## Reprise exacte\n- Tâche en cours : page produit, demandée par « fais simple ».\n' +
  '- Plan : [x] maquette [>] page produit [ ] tests\n- Dernière action : écrit src/produit.tsx (moitié), npm test non lancé.\n' +
  '- Fichiers touchés : src/produit.tsx — en-tête fait — reste le prix.\n' +
  '- Prochaine action : ajouter le prix dans src/produit.tsx puis lancer npm test (doit passer).\n- Ne pas refaire : la maquette.\n\n' +
  '## Objectif\nLancer la boutique.\n\n## Où on en est\nMaquette faite.\n\n## Fait\n- Maquette.\n\n' +
  "## Demandes de l'utilisateur\n« fais simple »\n\n" +
  '## Décidé\nShopify, parce que déjà payé.\n\n## Pièges déjà rencontrés\nAucun.\n\n' +
  '## Fichiers, liens et chiffres clés\nsrc/produit.tsx\n\n## Attend une validation\nMise en ligne.\n\n## Questions ouvertes\nAucune.\n'

const COMPRIS = '<compris>Page produit à moitié, prochaine action : le prix puis npm test.</compris>'

function monde(on: On, racineDepart: string, controles: string[] = [`${COMPRIS}<manques>AUCUN</manques>`]) {
  let racine = racineDepart
  const horloge = mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  const fichiers = new Map<string, { texte: string; mtime: number }>()
  const envoyes: string[] = []
  const commandes: string[] = []
  const toasts: string[] = []
  const lus: string[] = []
  const lignes: string[] = []

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({ value: { context: { tokens: 120_000, window: 200_000, percent: 60 }, rateLimits: [], startedAt: 0 } }))
  on('session.root', () => ({ value: racine }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  // Le moteur écrit les chemins à la façon Windows (\) : on les ramène à des /.
  const cle = (p: string) => p.replace(/\\/g, '/')
  on('fs.exists', (_, e) => ({ value: fichiers.has(cle(e.path)) || [...fichiers.keys()].some(k => k.startsWith(`${cle(e.path)}/`)) }))
  on('fs.read', (_, e) => {
    const f = fichiers.get(cle(e.path))
    if (!f) throw new Error(`absent : ${e.path}`)
    return { value: f.texte }
  })
  on('fs.write', (_, e) => {
    fichiers.set(cle(e.path), { texte: e.text, mtime: horloge.now() })
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    const f = fichiers.get(cle(e.path))
    return { value: { kind: 'file', size: f?.texte.length ?? 0, mtimeMs: f?.mtime ?? 0, isLink: false } }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    lignes.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.invalidate', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => {
    envoyes.push(e.text)
    return { text: e.text }
  })
  on('command.run', (_, e) => {
    commandes.push(e.command)
    return { text: '' }
  })
  // Le Claude neuf du contrôle à froid : il ne reçoit que STATE.md et la fin de DECISIONS.md.
  // « modifie » : STATE.md change pendant le contrôle.
  on('model.complete', (_, e) => {
    lus.push(e.prompt)
    const t = controles.length > 1 ? controles.shift()! : controles[0]!
    if (t === 'panne') return { value: { isAnswered: false, reason: 'aborted', usage: USAGE } } as never
    if (t === 'modifie') ecrire('STATE.md', STATE_COMPLET + '\nmodifié pendant le contrôle\n')
    const texte = t === 'modifie' ? `${COMPRIS}<manques>AUCUN</manques>` : t
    return { value: { isAnswered: true, text: texte, usage: USAGE } } as never
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  // Claude écrit un fichier pendant son tour.
  const ecrire = (nom: string, texte: string) => fichiers.set(`${racine}/${nom}`, { texte, mtime: horloge.now() })
  const archive = (nom: string) => [...fichiers.keys()].find(k => k.endsWith(nom))
  const archives = (nom: string) => [...fichiers.keys()].filter(k => k.endsWith(nom))
  // Un vrai dossier projet a déjà son STATE.md.
  if (!/scratch-workspaces/.test(racine)) ecrire('STATE.md', '## Objectif\nancienne version')
  const changerRacine = (r: string) => (racine = r)
  return { horloge, fichiers, envoyes, commandes, toasts, lus, lignes, ecrire, archive, archives, changerRacine }
}

// Comme si l'utilisateur tapait « /jauge relais ».
const RELAIS = { command: 'jauge', args: 'relais', origin: { kind: 'composer' }, presentation: { layout: 'main', columns: 80 } } as never
const finDeTour = (answer: string) => ({ answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' as const })
const demarrer = ($: Engine) => $.session.start({ cwd: PROJET, surface: 'desktop', isInteractive: true })

// Claude écrit STATE.md et répond ; le mod contrôle une seconde après.
async function tour(w: ReturnType<typeof monde>, $: Engine, state: string) {
  await w.horloge.advance(3000)
  w.ecrire('STATE.md', state)
  await $.turn.complete(finDeTour('Passation écrite.\nRelais prêt'))
  await w.horloge.advance(1500)
}

test('relais complet : sauvegarde, récap détaillé, contrôle à froid, conversation vidée, reprise exacte', async ($, on) => {
  const w = monde(on, PROJET)
  w.ecrire('STATE.md', '## Objectif\nancienne version')
  w.ecrire('DECISIONS.md', '2026-11-01 — Shopify — déjà payé')
  await demarrer($)

  await $.command.run(RELAIS)
  await w.horloge.advance(0)

  // L'ancien STATE.md est copié avant toute chose.
  expect(w.archive('STATE-avant.md')).toMatch(/\.passations\/\d{4}-\d{2}-\d{2}_\d{2}h\d{2}m\d{2}\/STATE-avant\.md$/)
  expect(w.fichiers.get(w.archive('STATE-avant.md')!)?.texte).toBe('## Objectif\nancienne version')
  // La demande de passation exige la reprise exacte.
  expect(w.envoyes).toHaveLength(1)
  for (const s of ['## Reprise exacte', 'Dernière action', 'Fichiers touchés', 'Prochaine action', 'Ne pas refaire', "N'avance pas la tâche"])
    expect(w.envoyes[0]).toContain(s)

  await tour(w, $, STATE_COMPLET)

  // Le contrôleur n'a lu que les fichiers.
  expect(w.lus).toHaveLength(1)
  expect(w.lus[0]).toContain('## Reprise exacte')
  expect(w.lus[0]).toContain('Shopify')
  expect(w.fichiers.get(w.archive('controle.md')!)?.texte).toContain('Aucun')
  expect(w.commandes).toContain('clear')
  expect(w.lignes.some(l => l.startsWith('Chat vidé.'))).toBe(true)
  expect(w.envoyes).toHaveLength(2)
  expect(w.envoyes[1]).toContain('Reprise après relais')
  expect(w.envoyes[1]).toContain("vérifie l'état réel")
  expect(w.envoyes[1]).toContain('recrée ta liste de tâches')
  expect(w.archive('STATE-apres.md')).toBeDefined()
})

test('le contrôle à froid trouve un manque : la conversation complète avant d’être vidée', async ($, on) => {
  const w = monde(on, PROJET, [`${COMPRIS}<manques>\n- Quel test lancer après le prix ?\n</manques>`, `${COMPRIS}<manques>AUCUN</manques>`])
  await demarrer($)
  await $.command.run(RELAIS)
  await tour(w, $, STATE_COMPLET)

  // Pas encore vidée : on demande le complément à la conversation, qui a tout le contexte.
  expect(w.commandes).not.toContain('clear')
  expect(w.envoyes).toHaveLength(2)
  expect(w.envoyes[1]).toContain('Quel test lancer après le prix ?')

  await tour(w, $, STATE_COMPLET.replace('lancer npm test', 'lancer npm test -- produit'))

  expect(w.lus).toHaveLength(2)
  expect(w.commandes).toContain('clear')
  expect(w.envoyes[2]).toContain('Reprise après relais')
  expect(w.fichiers.get(w.archive('controle.md')!)?.texte).toContain('## Contrôle 2')
})

test('encore flou après deux compléments : les points sont notés dans STATE.md, puis relais', async ($, on) => {
  const w = monde(on, PROJET, [`${COMPRIS}<manques>\n- Quel client ?\n</manques>`])
  await demarrer($)
  await $.command.run(RELAIS)
  for (let i = 0; i < 3; i++) await tour(w, $, STATE_COMPLET)

  expect(w.lus).toHaveLength(3)
  expect(w.commandes).toContain('clear')
  const state = w.fichiers.get(`${PROJET}/STATE.md`)!.texte
  expect(state).toContain('## Points flous signalés au relais')
  expect(state).toContain('Quel client ?')
})

test('contrôle à froid en panne : on n’efface rien, et on le dit', async ($, on) => {
  const w = monde(on, PROJET, ['panne'])
  await demarrer($)
  await $.command.run(RELAIS)
  await tour(w, $, STATE_COMPLET)

  expect(w.commandes).not.toContain('clear')
  expect(w.toasts.join(' ')).toContain('n’a pas pu se faire')
  expect(w.toasts.join(' ')).toContain('Le chat n’est pas effacé')
})

test('passation incomplète : correction demandée, puis rien n’est effacé si elle reste incomplète', async ($, on) => {
  const w = monde(on, PROJET)
  await demarrer($)
  await $.command.run(RELAIS)
  for (let i = 0; i < 3; i++) await tour(w, $, '## Objectif\nTrop court, sans reprise exacte.')

  expect(w.envoyes[1]).toMatch(/STATE\.md n.est pas prêt/)
  expect(w.lus).toHaveLength(0)
  expect(w.commandes).not.toContain('clear')
  // L'annulation dit où est la sauvegarde.
  expect(w.toasts.join(' ')).toContain('Le chat n’est pas effacé')
  expect(w.toasts.join(' ')).toContain('.passations/')
})

test('session sans dossier projet : pas de relais', async ($, on) => {
  const racine = 'C:/Users/moi/AppData/Roaming/Claude/scratch-workspaces/abc'
  const w = monde(on, racine)
  await $.session.start({ cwd: racine, surface: 'desktop', isInteractive: true })
  await $.command.run(RELAIS)
  await w.horloge.advance(0)

  expect(w.envoyes).toHaveLength(0)
  expect(w.toasts.join(' ')).toContain('pas de dossier projet')
})

// Un Cap minimal : à la fin d'une réponse, il relance une suite, comme Cap.
const cap: Plugin = {
  name: 'cap',
  register: on => {
    on('turn.complete', async ($, e, next) => {
      const res = await next(e)
      if (!e.agentId) await $.prompt.submit({ text: 'Cap : continue.' })
      return res
    })
  },
}

test('pendant le relais, la suite automatique de Cap ne s’intercale pas', { plugins: [cap] }, async ($, on) => {
  const w = monde(on, PROJET)
  await demarrer($)
  await $.command.run(RELAIS)
  await w.horloge.advance(0)

  // La tâche en cours finit sa réponse alors que le relais attend : Cap voudrait continuer.
  await $.turn.complete(finDeTour('Étape 3 faite.'))
  expect(w.envoyes.some(x => x.includes('Cap : continue'))).toBe(false)

  // Une fois la reprise lancée, Cap retrouve la main.
  await tour(w, $, STATE_COMPLET)
  expect(w.envoyes.some(x => x.includes('Reprise après relais'))).toBe(true)
  await $.turn.complete(finDeTour('Reprise faite, je continue.'))
  expect(w.envoyes.at(-1)).toBe('Cap : continue.')
})

// --- Défauts corrigés en 0.7

test('le dossier de la session change pendant le relais : rien n’est effacé', async ($, on) => {
  const w = monde(on, PROJET)
  await demarrer($)
  await $.command.run(RELAIS)
  w.changerRacine('C:/Users/moi/Desktop/Projets/02-content')
  await tour(w, $, STATE_COMPLET)

  expect(w.commandes).not.toContain('clear')
  expect(w.toasts.join(' ')).toContain('dossier de la session a changé')
})

test('une sauvegarde de la même seconde existe déjà : nouveau dossier, rien d’écrasé', async ($, on) => {
  const w = monde(on, PROJET)
  const d = new Date(1_800_000_000_000)
  const deux = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${deux(d.getMonth() + 1)}-${deux(d.getDate())}_${deux(d.getHours())}h${deux(d.getMinutes())}m${deux(d.getSeconds())}`
  w.ecrire(`.passations/${stamp}/STATE-avant.md`, 'sauvegarde précédente')
  await demarrer($)
  await $.command.run(RELAIS)

  expect(w.fichiers.get(`${PROJET}/.passations/${stamp}/STATE-avant.md`)?.texte).toBe('sauvegarde précédente')
  expect(w.fichiers.get(`${PROJET}/.passations/${stamp}-2/STATE-avant.md`)?.texte).toBe('## Objectif\nancienne version')
})

test('relais annulé puis relancé : chaque relais garde sa propre sauvegarde', async ($, on) => {
  const w = monde(on, PROJET)
  await demarrer($)
  await $.command.run(RELAIS)
  // Le relais n'aboutit pas (réponses sans « Relais prêt », même après les rappels), STATE.md a déjà été réécrit.
  w.ecrire('STATE.md', 'réécrit mais incomplet')
  for (let i = 0; i < 25; i++) {
    await $.turn.complete(finDeTour('Je travaille encore.'))
    await w.horloge.advance(1000)
  }
  await $.command.run(RELAIS)

  const copies = w.archives('STATE-avant.md').map(k => w.fichiers.get(k)?.texte)
  expect(copies).toEqual(['## Objectif\nancienne version', 'réécrit mais incomplet'])
})

test('double clic : un seul relais', async ($, on) => {
  const w = monde(on, PROJET)
  await demarrer($)
  await Promise.all([$.command.run(RELAIS), $.command.run(RELAIS)])
  await w.horloge.advance(0)

  expect(w.envoyes).toHaveLength(1)
  expect(w.archives('STATE-avant.md')).toHaveLength(1)
})

test('message tapé pendant le contrôle à froid : inscrit dans STATE.md, puis le relais continue seul', async ($, on) => {
  const w = monde(on, PROJET)
  await demarrer($)
  await $.command.run(RELAIS)
  await w.horloge.advance(3000)
  w.ecrire('STATE.md', STATE_COMPLET)
  await $.turn.complete(finDeTour('Passation écrite.\nRelais prêt'))
  // Tu écris juste après la réponse du relais, pendant que le Claude neuf relit.
  await $.turn.start({ text: '', turnId: 'u1' } as never)
  await w.horloge.advance(1500)

  // Pas d'effacement tout de suite, pas d'annulation : on demande d'inscrire ton message.
  expect(w.commandes).not.toContain('clear')
  expect(w.toasts.join(' ')).not.toContain('annulé')
  expect(w.envoyes.at(-1)).toContain("l'utilisateur a écrit pendant le relais")

  // Ta réponse arrive, puis la mise à jour du relais : effacement et reprise, sans toi.
  await $.turn.complete(finDeTour('Réponse à ta question.'))
  await tour(w, $, STATE_COMPLET + '\n« ta demande »\n')
  expect(w.commandes).toContain('clear')
  expect(w.envoyes.at(-1)).toContain('Reprise après relais')
})

test('STATE.md modifié pendant le contrôle à froid : revérifié, puis le relais continue seul', async ($, on) => {
  const w = monde(on, PROJET, ['modifie', `${COMPRIS}<manques>AUCUN</manques>`])
  await demarrer($)
  await $.command.run(RELAIS)
  await tour(w, $, STATE_COMPLET)

  expect(w.commandes).not.toContain('clear')
  expect(w.envoyes.at(-1)).toContain('STATE.md a changé pendant le contrôle')

  await tour(w, $, STATE_COMPLET)
  expect(w.commandes).toContain('clear')
})

test('passation qui tarde : rappel automatique au lieu d’annuler', async ($, on) => {
  const w = monde(on, PROJET)
  await demarrer($)
  await $.command.run(RELAIS)
  await w.horloge.advance(0)
  for (let i = 0; i < 4; i++) {
    await $.turn.complete(finDeTour('Je finis l’étape en cours.'))
    await w.horloge.advance(1000)
  }
  expect(w.toasts.join(' ')).not.toContain('annulé')
  expect(w.envoyes.at(-1)).toContain('Relais en attente')

  await tour(w, $, STATE_COMPLET)
  expect(w.commandes).toContain('clear')
})

test('la tâche en cours modifie STATE.md : le relais attend sa propre réponse au lieu d’annuler', async ($, on) => {
  const w = monde(on, PROJET)
  await demarrer($)
  await $.command.run(RELAIS)
  // La tâche en cours met à jour STATE.md et finit sa réponse, sans « Relais prêt ».
  await w.horloge.advance(2000)
  w.ecrire('STATE.md', '## Objectif\nmis à jour par la tâche')
  await $.turn.complete(finDeTour('Étape 2 faite.'))
  await w.horloge.advance(1500)
  expect(w.toasts.join(' ')).not.toContain('annulé')

  await tour(w, $, STATE_COMPLET)
  expect(w.commandes).toContain('clear')
})

test('pas de STATE.md dans le dossier (Projets lui-même, sous-dossier) : pas de relais', async ($, on) => {
  const w = monde(on, PROJET)
  w.fichiers.delete(`${PROJET}/STATE.md`)
  await demarrer($)
  await $.command.run(RELAIS)
  await w.horloge.advance(0)

  expect(w.envoyes).toHaveLength(0)
  expect(w.toasts.join(' ')).toContain('pas de STATE.md')
})

test('DECISIONS.md réécrit au lieu d’être complété : correction demandée, pas d’effacement', async ($, on) => {
  const w = monde(on, PROJET)
  w.ecrire('DECISIONS.md', '2026-11-01 — Shopify — déjà payé\n')
  await demarrer($)
  await $.command.run(RELAIS)
  w.ecrire('DECISIONS.md', '2026-11-03 — nouvelle décision seule\n')
  await tour(w, $, STATE_COMPLET)

  expect(w.commandes).not.toContain('clear')
  expect(w.envoyes[1]).toContain('DECISIONS-avant.md')
})

test('contrôle de structure : sections obligatoires, section vide, 180 lignes au plus', () => {
  expect(defautsMecaniques(STATE_COMPLET)).toBeUndefined()
  expect(defautsMecaniques(STATE_COMPLET.replace('- Ne pas refaire : la maquette.\n', ''))).toContain('Ne pas refaire')
  expect(defautsMecaniques(STATE_COMPLET.replace('## Pièges déjà rencontrés\nAucun.', '## Pièges déjà rencontrés\n'))).toContain('section vide')
  expect(defautsMecaniques(STATE_COMPLET + '\n- ligne'.repeat(200))).toBe('la passation est trop longue')
})

test('« - AUCUN » veut dire qu’il ne manque rien', () => {
  expect(lireControle(`${COMPRIS}<manques>\n- AUCUN\n</manques>`)?.manques).toEqual([])
})

test("/clear tapé à la main : une ligne sépare l'ancien chat du nouveau", async ($, on) => {
  const w = monde(on, PROJET)
  await demarrer($)
  await $.command.run({ command: 'clear', args: '', origin: { kind: 'composer' }, presentation: { layout: 'main', columns: 80 } } as never)
  expect(w.commandes).toContain('clear')
  expect(w.lignes).toHaveLength(1)
  expect(w.lignes[0]).toContain("n'utilise plus ses boutons")
})
