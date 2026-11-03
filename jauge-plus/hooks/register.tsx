import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Mesure, Phase, Relais } from '../types'
import type { Controle } from './passation'
import {
  defautsMecaniques,
  FIN_RELAIS,
  LIGNE_CHAT_VIDE,
  finDecisions,
  lireControle,
  messageControle,
  MODELE_CONTROLE,
  notePointsFlous,
  REPRISES_MAX,
  SYSTEME_CONTROLE,
  texteComplement,
  texteMiseAJour,
  texteRappel,
  texteRelais,
  texteReprise,
  TOURS_MAX,
} from './passation'

// Jauge+ : contexte, usage 5 h / 7 j, relais vers STATE.md / DECISIONS.md puis conversation neuve.
// Les boutons de Plume sont dessinés ici ; Plume réagit au clic.
// Ne lit jamais le texte des prompts. Un seul appel au modèle : au relais, un Claude neuf
// relit le récap (Sonnet). Aucun autre réseau. Stockage : $.store du mod.

const mesure = atom({ plugin: 'jauge-plus', key: 'mesure' } as const, null, { shape: 'mesure-3' })
const phase = atom({ plugin: 'jauge-plus', key: 'phase' } as const, 'repos')
const dernierEchange = atom({ plugin: 'jauge-plus', key: 'dernierEchange' } as const, null)
// Le relais en cours appartient à CETTE conversation ($.state), jamais partagé avec une
// autre : deux projets qui passent le relais en même temps ne se mélangent pas.
const relaisAtom = atom({ plugin: 'jauge-plus', key: 'relais' } as const, null, { shape: 'relais-2' })

// auto : true → relais lancé seul au seuil ; false → simple rappel, tu cliques quand tu veux.
// masque : la bande disparaît, mais la mesure et le relais continuent.
type Reglages = { seuil: number; auto: boolean; masque: boolean }
const DEFAUT: Reglages = { seuil: 60, auto: true, masque: false }

const VERT = '#3FB950'
const AMBRE = '#D29922'
const ROUGE = '#F85149'
const STYLE =
  '<style>text{font-family:"Segoe UI Variable Text","Segoe UI",-apple-system,system-ui,sans-serif;font-variant-numeric:tabular-nums}' +
  '.t{fill:#ECEAE6}.d{fill:#8E8A84}.p{fill:#fff;fill-opacity:.08}' +
  '@media (prefers-color-scheme: light){.t{fill:#1F1E1C}.d{fill:#6B6862}.p{fill:#000;fill-opacity:.08}}</style>'

// --- Mise en forme
const virgule = (n: number, d = 0) => n.toFixed(d).replace('.', ',')
const taille = (n: number) => (n >= 1_000_000 ? `${virgule(n / 1_000_000, 1)} M` : n >= 1000 ? `${Math.round(n / 1000)} k` : `${n}`)
const duree = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')}`
  if (m > 0) return `${m} min ${s % 60} s`
  return `${s} s`
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const couleurCtx = (pct: number, seuil: number) => (pct < 50 ? VERT : pct <= seuil ? AMBRE : ROUGE)
// Largeur approximative d'un texte (px) pour éviter les chevauchements.
const largeurTexte = (s: string, px: number) => s.length * px * 0.56

const barreLisse = (x: number, y: number, w: number, h: number, pct: number, coul: string) => {
  const lw = Math.max(h, (w * Math.max(0, Math.min(100, pct))) / 100)
  return (
    `<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="${coul}" stop-opacity=".55"/><stop offset="1" stop-color="${coul}"/></linearGradient></defs>` +
    `<rect class="p" x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/>` +
    (pct > 0
      ? `<rect x="${x}" y="${y}" width="${lw.toFixed(1)}" height="${h}" rx="${h / 2}" fill="url(#g)"/>` +
        `<rect x="${x + h / 2}" y="${y + 1}" width="${Math.max(0, lw - h).toFixed(1)}" height="1" rx=".5" fill="#fff" fill-opacity=".22"/>`
      : '')
  )
}

// Bandeau : « Contexte » + chiffres sur une ligne, la barre juste dessous, le repère du relais posé sur la barre.
const svgBandeau = (m: Mesure, seuil: number, auto: boolean, W: number, now: number) => {
  if (m.ctxTokens === null) {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="22" viewBox="0 0 ${W} 22">${STYLE}` +
      `<text x="0" y="16"><tspan class="t" font-size="14" font-weight="600">Contexte</tspan>` +
      `<tspan class="d" font-size="12" dx="8">mesuré au premier message · fenêtre ${esc(taille(m.ctxWindow))}</tspan></text></svg>`
    )
  }
  const pct = m.ctxPct ?? 0
  const coul = couleurCtx(pct, seuil)
  const chiffres = `${taille(m.ctxTokens)} / ${taille(m.ctxWindow)}`
  const gauche =
    `<tspan class="t" font-size="14" font-weight="600">Contexte</tspan>` +
    `<tspan class="d" font-size="12" dx="9">${esc(chiffres)}</tspan>` +
    `<tspan fill="${coul}" font-size="12" font-weight="600" dx="6">${virgule(pct)} %</tspan>`
  const finGauche = largeurTexte('Contexte', 14) + 9 + largeurTexte(chiffres, 12) + 6 + largeurTexte(`${virgule(pct)} %`, 12)

  // Pastille du relais centrée sur son repère ; à droite, usage 5 h et 7 j, raccourci si la place manque.
  const xRel = (W * seuil) / 100
  const libelle = auto ? `Relais ${seuil} %` : `Rappel ${seuil} %`
  const lw = Math.round(largeurTexte(libelle, 10) + 14)
  const lx = Math.max(finGauche + 12, Math.min(W - lw, xRel - lw / 2))
  const resetTxt = m.reset5h ? ` · ${duree(Date.parse(m.reset5h) - now)} restantes` : ''
  const longueur = (avecReset: boolean) =>
    (m.pct5h !== null ? largeurTexte(`5 h ${virgule(m.pct5h)} %`, 12) + (avecReset ? largeurTexte(resetTxt, 12) : 0) : 0) +
    (m.pct7j !== null ? 14 + largeurTexte(`7 j ${virgule(m.pct7j)} %`, 12) : 0)
  const avecReset = resetTxt !== '' && W - longueur(true) > lx + lw + 12
  let droite = ''
  if (m.pct5h !== null) {
    droite += `<tspan class="d">5 h</tspan><tspan class="t" dx="4">${virgule(m.pct5h)} %</tspan>`
    if (avecReset) droite += `<tspan class="d" dx="4">${esc(resetTxt.trim())}</tspan>`
  }
  if (m.pct7j !== null) droite += `<tspan class="d" dx="14">7 j</tspan><tspan class="t" dx="4">${virgule(m.pct7j)} %</tspan>`

  const yBarre = 24
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${yBarre + 7}" viewBox="0 0 ${W} ${yBarre + 7}">${STYLE}` +
    `<text x="0" y="15">${gauche}</text>` +
    (droite ? `<text x="${W}" y="15" font-size="12" text-anchor="end">${droite}</text>` : '') +
    `<rect x="${lx.toFixed(1)}" y="4" width="${lw}" height="14" rx="7" fill="${coul}" fill-opacity=".12" stroke="${coul}" stroke-opacity=".35"/>` +
    `<text x="${(lx + lw / 2).toFixed(1)}" y="14.3" font-size="10" font-weight="600" text-anchor="middle" fill="${coul}">${libelle}</text>` +
    barreLisse(0, yBarre, W, 6, pct, coul) +
    `<rect x="${(xRel - 0.75).toFixed(1)}" y="${yBarre - 3}" width="1.5" height="12" rx=".75" fill="${coul}"/>` +
    `</svg>`
  )
}

async function lireReglages($: EngineInterface): Promise<Reglages> {
  return { ...DEFAUT, ...(((await $.store.get('reglages')) as Partial<Reglages>) ?? {}) }
}

// --- Relais : passation écrite, contrôlée à froid par un Claude neuf, complétée
// par la conversation (qui a encore tout le contexte), puis conversation neuve.

const deux = (n: number) => String(n).padStart(2, '0')
const horodatage = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${deux(d.getMonth() + 1)}-${deux(d.getDate())}_${deux(d.getHours())}h${deux(d.getMinutes())}m${deux(d.getSeconds())}`
}

// Un dossier d'archive neuf : jamais deux relais dans le même, jamais d'écrasement.
async function dossierNeuf($: EngineInterface, base: string) {
  for (let i = 1; ; i++) {
    const d = i === 1 ? base : `${base}-${i}`
    if (!(await $.fs.exists(d))) return d
  }
}

// Copie un fichier du projet dans l'archive du relais s'il existe. N'écrase jamais
// une copie existante, et relit la copie : une sauvegarde ratée lève une erreur.
async function archiver($: EngineInterface, racine: string, archive: string, nom: string, suffixe: string) {
  const source = `${racine}/${nom}`
  if (!(await $.fs.exists(source))) return
  const texte = await $.fs.read(source)
  if (typeof texte !== 'string') return
  const cible = `${archive}/${nom.replace('.md', `${suffixe}.md`)}`
  if (await $.fs.exists(cible)) throw new Error(`${cible} existe déjà`)
  await $.fs.write(cible, texte)
  if ((await $.fs.read(cible)) !== texte) throw new Error(`copie de ${nom} incorrecte`)
}

async function lireTexte($: EngineInterface, chemin: string) {
  try {
    if (!(await $.fs.exists(chemin))) return ''
    const t = await $.fs.read(chemin)
    return typeof t === 'string' ? t : ''
  } catch {
    return ''
  }
}

// Verrou posé avant le premier await : un double clic, ou un clic au moment du
// déclenchement automatique, ne lance jamais deux relais.
let verrou = false
// Réponses de la conversation commencées depuis le chargement (sans lire leur texte).
let toursDemarres = 0

// Relance un relais. Renvoie ce qui s'est passé, pour /jauge relais.
async function lancerRelais($: EngineInterface): Promise<string> {
  const refus = (texte: string) => {
    $.ui.toast(texte, { timeoutMs: 10000 })
    return texte
  }
  if (verrou) return 'Un relais est déjà en cours.'
  verrou = true
  try {
    if ((await read($, phase)) !== 'repos') return 'Un relais est déjà en cours.'
    const racine = await $.session.root()
    // Une session sans dossier vit dans un dossier temporaire supprimé avec elle : la passation y serait perdue.
    if (/scratch-workspaces/i.test(racine)) {
      return refus('Relais impossible : cette session n’a pas de dossier projet. Ouvre-la dans Bureau\\Projets\\… d’abord.')
    }
    // Seul un vrai dossier projet a déjà un STATE.md (pas Projets lui-même, ni un sous-dossier).
    if (!(await $.fs.exists(`${racine}/STATE.md`))) {
      return refus('Relais impossible : pas de STATE.md dans ce dossier. Ouvre la session à la racine du projet (là où est son STATE.md).')
    }
    const debut = await $.clock.now()
    const archive = await dossierNeuf($, `${racine}/.passations/${horodatage(debut)}`)
    try {
      await archiver($, racine, archive, 'STATE.md', '-avant')
      await archiver($, racine, archive, 'DECISIONS.md', '-avant')
    } catch {
      return refus('Relais annulé : la sauvegarde de STATE.md ou DECISIONS.md a échoué. Rien n’a été touché.')
    }
    const decisionsAvant = await lireTexte($, `${racine}/DECISIONS.md`)
    const m = await read($, mesure)
    await update($, relaisAtom, () => ({ debut, racine, archive, tours: 0, attentes: 0, decisionsAvant }))
    await update($, phase, () => 'ecriture' as Phase)
    const pct = m?.ctxPct != null ? virgule(m.ctxPct) : null
    const nomArchive = archive.slice(racine.length + 1)
    // Envoyé juste après : depuis la commande /jauge relais elle-même, le moteur refuse
    // (le message attendrait la fin de cette commande).
    $.clock.after(0, () =>
      void $.prompt.submit({ text: texteRelais(racine, pct, nomArchive) }).then(
        async r => {
          if ('drop' in r && r.drop) await annuler($, 'le message du relais a été refusé')
        },
        err => annuler($, `le message du relais n’a pas pu être envoyé (${err instanceof Error ? err.message : String(err)})`),
      ),
    )
    return `Relais lancé. Sauvegarde : ${nomArchive}`
  } finally {
    verrou = false
  }
}

// Arrête le relais sans rien effacer, en disant où est la sauvegarde.
async function annuler($: EngineInterface, pourquoi: string) {
  const relais = await read($, relaisAtom)
  await update($, phase, () => 'repos' as Phase)
  await update($, relaisAtom, () => null)
  const ou = relais ? ` L’ancien STATE.md est sauvegardé dans ${relais.archive.slice(relais.racine.length + 1)}.` : ''
  $.ui.toast(`Relais annulé : ${pourquoi}. Le chat n’est pas effacé.${ou} Relance avec « Passer le relais » quand tu veux.`, { timeoutMs: 12000 })
}

// Renvoie la conversation corriger STATE.md : elle seule a encore tout le contexte.
async function redemander($: EngineInterface, relais: Relais, texte: string) {
  await update($, relaisAtom, () => ({ ...relais, tours: relais.tours + 1, attentes: 0 }))
  await update($, phase, () => 'ecriture' as Phase)
  const r = await $.prompt.submit({ text: texte })
  if ('drop' in r && r.drop) await annuler($, 'la correction demandée a été refusée')
}

// Garde la trace de chaque contrôle à froid dans l'archive du relais.
async function noterControle($: EngineInterface, relais: Relais, c: Controle) {
  const chemin = `${relais.archive}/controle.md`
  const avant = await lireTexte($, chemin)
  const bloc =
    `## Contrôle ${relais.tours + 1}\n\n### Compris\n${c.compris}\n\n### Manques\n` +
    (c.manques.length ? c.manques.map(x => `- ${x}`).join('\n') : 'Aucun') +
    '\n\n'
  await $.fs.write(chemin, avant + bloc)
}

async function controlerAFroid($: EngineInterface, racine: string, state: string): Promise<Controle | undefined> {
  $.ui.status('Relais : un Claude neuf relit le récap…')
  try {
    const decisions = finDecisions(await lireTexte($, `${racine}/DECISIONS.md`))
    const r = await $.model.complete({
      model: MODELE_CONTROLE,
      effort: 'medium',
      system: SYSTEME_CONTROLE,
      prompt: messageControle(state, decisions),
      maxTokens: 4000,
      timeoutMs: 120_000,
    })
    return r.isAnswered ? lireControle(r.text) : undefined
  } finally {
    $.ui.status(undefined)
  }
}

// N'efface la conversation que si STATE.md a été réécrit pendant le relais, est complet,
// que DECISIONS.md a seulement été complété, qu'un Claude neuf qui ne lit que le récap
// peut reprendre sans question, et que rien n'a bougé pendant ce contrôle.
// toursAuDepart : réponses commencées au moment où celle du relais s'est terminée.
async function finirRelais($: EngineInterface, reponse: string, toursAuDepart: number) {
  const relais = await read($, relaisAtom)
  if (!relais) {
    await update($, phase, () => 'repos' as Phase)
    return
  }
  // Ce relais appartient à un autre dossier : on n'y touche pas.
  if (relais.racine !== (await $.session.root())) return annuler($, 'le dossier de la session a changé')
  // Relais lancé en pleine tâche : les réponses de la tâche finissent d'abord. Seule une
  // réponse qui finit par « Relais prêt » est jugée (trois autres au plus).
  if (!reponse.includes(FIN_RELAIS)) {
    if (relais.attentes < 3) {
      await update($, relaisAtom, () => ({ ...relais, attentes: relais.attentes + 1 }))
      return
    }
    // Toujours automatique : on redemande la passation avant d'abandonner.
    if (relais.tours < TOURS_MAX + REPRISES_MAX) return redemander($, relais, texteRappel())
    return annuler($, 'la passation n’est pas allée au bout')
  }
  const chemin = `${relais.racine}/STATE.md`
  const ecrit = (await $.fs.exists(chemin)) && (await $.fs.stat(chemin)).mtimeMs >= relais.debut - 2000
  if (!ecrit) return annuler($, 'STATE.md n’a pas été réécrit')
  await update($, phase, () => 'controle' as Phase)

  const texte = await lireTexte($, chemin)
  const decisions = await lireTexte($, `${relais.racine}/DECISIONS.md`)
  const defaut =
    defautsMecaniques(texte) ??
    (decisions.trimEnd().startsWith(relais.decisionsAvant.trimEnd())
      ? undefined
      : 'DECISIONS.md a été réécrit au lieu d’être complété')
  if (defaut) {
    if (relais.tours < TOURS_MAX) {
      const decisionsCasse = defaut.startsWith('DECISIONS')
      await redemander(
        $,
        relais,
        `Contrôle du relais : ${decisionsCasse ? 'DECISIONS.md n’est pas prêt' : 'STATE.md n’est pas prêt'} (${defaut}). ` +
          (decisionsCasse
            ? `Remets DECISIONS.md exactement comme la sauvegarde ${relais.archive}/DECISIONS-avant.md, puis ajoute seulement les nouvelles lignes à la fin. `
            : `Corrige-le en suivant la structure demandée${/longue/.test(defaut) ? ', en condensant sans rien perdre d’utile pour la reprise' : ''}. `) +
          `N'avance pas la tâche et ne modifie aucun autre fichier. Termine ta réponse par exactement : ${FIN_RELAIS}`,
      )
      return
    }
    return annuler($, defaut)
  }

  // Tout ce qui se passe à partir d'ici annule l'effacement : un message tapé depuis la
  // réponse du relais, ou un STATE.md modifié après sa relecture.
  const c = await controlerAFroid($, relais.racine, texte).catch(() => undefined)
  // Sans contrôle à froid (limite atteinte, panne, réponse coupée), on n'efface rien.
  if (!c) return annuler($, 'le contrôle par un Claude neuf n’a pas pu se faire (limite atteinte ou panne)')
  await noterControle($, relais, c).catch(() => undefined)
  if (c.manques.length) {
    if (relais.tours < TOURS_MAX) {
      await redemander($, relais, texteComplement(c))
      return
    }
    // Encore flou après les compléments : on le note pour la reprise plutôt que de bloquer.
    await $.fs.write(chemin, texte.trimEnd() + notePointsFlous(c.manques))
  }
  const final = await lireTexte($, chemin)
  const ecritPendant = toursDemarres !== toursAuDepart
  if (ecritPendant || final !== (c.manques.length ? texte.trimEnd() + notePointsFlous(c.manques) : texte)) {
    // Ton message n'est jamais perdu : la conversation l'inscrit dans STATE.md, puis on
    // recontrôle et le relais continue seul (0.8 ; avant, il s'annulait).
    if (relais.tours < TOURS_MAX + REPRISES_MAX) return redemander($, relais, texteMiseAJour(ecritPendant))
    return annuler($, ecritPendant ? 'tu as écrit pendant le contrôle, ton message ne doit pas être effacé' : 'STATE.md a changé pendant le contrôle')
  }

  try {
    await archiver($, relais.racine, relais.archive, 'STATE.md', '-apres')
    await archiver($, relais.racine, relais.archive, 'DECISIONS.md', '-apres')
  } catch {
    return annuler($, 'la copie finale de la passation a échoué')
  }
  try {
    await $.command.run({ command: 'clear' })
  } catch {
    await update($, phase, () => 'repos' as Phase)
    await update($, relaisAtom, () => null)
    $.ui.toast('Passation écrite et vérifiée. Lance /clear puis « lis STATE.md et reprends » pour repartir à neuf.', { timeoutMs: 12000 })
    return
  }
  // Le clear lancé ici ne repasse pas par le hook command.run du mod : la ligne est ajoutée ici.
  $.ui.log(LIGNE_CHAT_VIDE)
  await update($, phase, () => 'repos' as Phase).catch(() => undefined)
  await update($, relaisAtom, () => null).catch(() => undefined)
  try {
    await $.prompt.submit({ text: texteReprise(relais.racine) })
  } catch {
    $.ui.toast('Chat vidé, passation prête. Écris : « Lis STATE.md et DECISIONS.md, puis reprends ».', { timeoutMs: 15000 })
  }
}

type Usage = { context: SessionContextUsage; rateLimits: SessionRateLimit[] }

async function mesurer($: EngineInterface, u: Usage) {
  const sept = u.rateLimits.find(x => x.kind === 'seven_day')
  const cinq = u.rateLimits.find(x => x.kind === 'five_hour')
  const m: Mesure = {
    ctxTokens: u.context.tokens ?? null,
    ctxWindow: u.context.window,
    ctxPct: u.context.percent ?? null,
    pct5h: cinq?.percentUsed ?? null,
    reset5h: cinq?.resetsAt ?? null,
    pct7j: sept?.percentUsed ?? null,
  }
  await update($, mesure, () => m)
  return m
}

export const register: Register = on => {
  let relaisFait = false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'jauge', description: 'Jauge+ : seuil du relais et relais manuel (/jauge aide)' })
    await mesurer($, await $.session.usage())
    // Rafraîchit « dernier échange il y a … » chaque seconde.
    $.clock.every(1000, () => $.ui.invalidate('ui.render'))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const m = await mesurer($, e)
    const r = await lireReglages($)
    if (m.ctxPct !== null) {
      if (m.ctxPct < r.seuil - 10) relaisFait = false
      else if (m.ctxPct >= r.seuil && !relaisFait) {
        relaisFait = true
        if (r.auto) void lancerRelais($).catch(() => undefined)
        else $.ui.toast(`Contexte à ${Math.round(m.ctxPct)} % : clique sur « Relais » quand tu veux passer à un chat neuf.`, { timeoutMs: 8000 })
      }
    }
    return next(e)
  })

  // Pendant le relais, rien ne s'intercale : les suites automatiques des autres mods
  // (Cap) attendent la reprise. Tes propres messages passent toujours.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin' && !e.origin.name.startsWith('jauge-plus') && (await read($, phase)) !== 'repos') {
      return { drop: 'Relais en cours : la suite automatique attend la reprise.' }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Compte les réponses qui commencent, sans lire le message : sert à voir qu'on a
  // écrit pendant le contrôle du relais.
  on('turn.start', async ($, e, next) => {
    const res = await next(e)
    if (!e.agentId) toursDemarres++
    return res
  })

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    if (e.agentId) return res
    await update($, dernierEchange, () => Date.now())
    if ((await read($, phase)) === 'ecriture') {
      const reponse = e.answer
      const tours = toursDemarres
      // Aucune erreur n'est silencieuse : le relais s'arrête et le dit, sans rien effacer.
      $.clock.after(1000, () =>
        void finirRelais($, reponse, tours).catch(err => annuler($, `erreur inattendue (${err instanceof Error ? err.message : String(err)})`).catch(() => undefined)),
      )
    }
    return res
  })

  // Après chaque /clear (le tien ou celui du relais), une ligne sépare l'ancien chat du nouveau.
  on('command.run', { command: 'clear' }, async ($, e, next) => {
    const r = await next(e)
    $.ui.log(LIGNE_CHAT_VIDE)
    return r
  })

  on('command.run', { command: 'jauge' }, async ($, e) => {
    const [cmd = '', a = ''] = e.args.trim().split(/\s+/)
    const r = await lireReglages($)
    if (cmd === 'relais') return { text: await lancerRelais($) }
    if (cmd === 'seuil' && Number(a) > 0 && Number(a) < 100) {
      await $.store.set('reglages', { ...r, seuil: Number(a) })
      return { text: `Seuil du relais : ${a} %.` }
    }
    if (cmd === 'auto' && (a === 'on' || a === 'off')) {
      await $.store.set('reglages', { ...r, auto: a === 'on' })
      return { text: a === 'on' ? `Relais automatique à ${r.seuil} %.` : `Relais manuel : simple rappel à ${r.seuil} %.` }
    }
    if (cmd === 'masquer' || cmd === 'afficher') {
      await $.store.set('reglages', { ...r, masque: cmd === 'masquer' })
      $.ui.invalidate('ui.render')
      return { text: cmd === 'masquer' ? 'Jauge masquée (le relais reste actif). /jauge afficher pour la revoir.' : 'Jauge affichée.' }
    }
    const mode = r.auto ? `automatique à ${r.seuil} %` : `manuel, rappel à ${r.seuil} %`
    return {
      text:
        `Jauge+ — relais ${mode}${r.masque ? ', jauge masquée' : ''}.\n` +
        `/jauge relais · /jauge seuil 55 · /jauge auto off · /jauge auto on · /jauge masquer · /jauge afficher`,
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Les autres mods (Fil) s'affichent au-dessus ; la jauge reste en bas.
    const autres = await next(e)
    if (e.props.hasSurvey) return autres
    const r = await lireReglages($)
    if (r.masque) return autres
    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const Svg = 'Svg' in t ? t.Svg : null
    const m = await read($, mesure)
    const now = Date.now()
    const enCours = (await read($, phase)) !== 'repos'
    const W = Math.max(360, Math.min(1100, Math.round(e.props.bodyColumns * 7.4)))

    // Le cache de la conversation tient 1 h dans l'app : ambre à 50 min, rouge passé 1 h
    // (le prochain message relit alors tout au prix fort).
    const dernier = await read($, dernierEchange)
    const age = dernier === null ? null : now - dernier
    const coulAge = age === null || age < 50 * 60_000 ? undefined : age < 60 * 60_000 ? AMBRE : ROUGE
    const noteCache = coulAge === AMBRE ? ' · cache bientôt expiré' : coulAge === ROUGE ? ' · cache expiré' : ''

    let haut: any
    if (Svg && m) {
      haut = (
        <Svg
          source={svgBandeau(m, r.seuil, r.auto, W, now)}
          alt={`Contexte ${virgule(m.ctxPct ?? 0)} %`}
          width={W}
          height={m.ctxTokens === null ? 22 : 31}
        />
      )
    } else if (m && m.ctxTokens !== null) {
      const pct = m.ctxPct ?? 0
      haut = (
        <Text>
          <Text color={couleurCtx(pct, r.seuil)} weight="bold">
            Contexte {taille(m.ctxTokens)} / {taille(m.ctxWindow)} ({virgule(pct)} %)
          </Text>
          <Text dimColor>
            {m.pct5h !== null ? ` · 5 h ${virgule(m.pct5h)} %` : ''}
            {m.pct7j !== null ? ` · 7 j ${virgule(m.pct7j)} %` : ''} · {r.auto ? 'relais' : 'rappel'} {r.seuil} %
          </Text>
        </Text>
      )
    } else {
      haut = <Text dimColor>Contexte : mesuré au premier message</Text>
    }

    const petit = (texte: string) => <Text size="footnote">{texte}</Text>
    return (
      <Box flexDirection="column">
        {autres ?? null}
        <Box flexDirection="column" marginTop={autres ? 1 : 0}>
          {haut}
          <Box flexDirection="row" alignItems="center" columnGap={1} marginTop={1}>
            {age !== null ? (
              <Text size="footnote" color={coulAge} dimColor={coulAge === undefined}>
                dernier échange il y a {duree(age)}
                {noteCache}
              </Text>
            ) : null}
            <Box flexGrow={1} />
            <Button key="relais" variant="secondary" onPress={() => (enCours ? undefined : void lancerRelais($))}>
              {petit(enCours ? 'Relais…' : 'Passer le relais')}
            </Button>
            <Button key="plume" dimColor onPress={() => undefined}>
              {petit('Améliorer le prompt')}
            </Button>
            <Button key="plume-retour" dimColor onPress={() => undefined}>
              {petit('↺')}
            </Button>
          </Box>
        </Box>
      </Box>
    )
  })
}
