import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Agent, Tache, Taches } from '../types'
import * as SONS from './sons'

// Fil : une barre par tâche en cours (liste de tâches de Claude) et une par lot de
// sous-agents, visibles dans toutes les conversations (un fichier par conversation dans
// ~/.claude/fil-sessions), la plus récente en haut, son à la fin, croix
// pour fermer. Ne lit pas les prompts. Aucun réseau.

const taches = atom({ plugin: 'fil', key: 'taches' } as const, {}, { shape: 'taches-2' })
const moi = atom({ plugin: 'fil', key: 'moi' } as const, '')

type Etape = { texte: string; statut: 'pending' | 'in_progress' | 'completed' }

// Ce qui est fini reste visible 12 h, ou jusqu'au × ou à /fil vider.
const GARDE_FINI = 12 * 3_600_000
const OUBLI = 2 * 3_600_000
const VIOLET = '#8b7cf6'
const VERT = '#3fb950'

const OUTILS: Record<string, string> = {
  Read: 'Lecture',
  Grep: 'Recherche',
  Glob: 'Recherche',
  Edit: 'Édition',
  Write: 'Écriture',
  NotebookEdit: 'Édition',
  Bash: 'Commande',
  PowerShell: 'Commande',
  WebFetch: 'Web',
  WebSearch: 'Web',
  Agent: 'Sous-agent',
  Task: 'Sous-agent',
  Skill: 'Skill',
}
const libelle = (tool: string) => OUTILS[tool] ?? (tool.startsWith('mcp__') ? 'Outil' : tool)

// claude-haiku-5-5 → haiku 5.5
const modeleCourt = (m: string) => {
  const x = /(haiku|sonnet|opus|fable)[-_ ]?(\d+)(?:[-_.](\d+))?/i.exec(m)
  return x ? `${x[1]!.toLowerCase()} ${x[2]}${x[3] ? `.${x[3]}` : ''}` : m
}

// Partage entre conversations : chaque conversation écrit son seul fichier,
// ~/.claude/fil-sessions/<id>.json, et lit ceux des autres. Personne n'écrit chez
// l'autre (sauf _fermes.json, au clic sur ×), donc pas de conflit.
let dossier: string | undefined
let nom = ''
let mien: Tache | null = null
let mienId = ''
const lus = new Map<string, { mtime: number; valeur: unknown }>()

type Fermes = Record<string, number>

async function lireJson($: EngineInterface, chemin: string): Promise<unknown> {
  try {
    return JSON.parse(await $.fs.read(chemin))
  } catch {
    return undefined
  }
}

// Relit un fichier seulement quand il a changé.
async function lireSiChange($: EngineInterface, nomFichier: string, mtime: number) {
  const c = lus.get(nomFichier)
  if (c && c.mtime === mtime) return c.valeur
  const valeur = await lireJson($, `${dossier}/${nomFichier}`)
  lus.set(nomFichier, { mtime, valeur })
  return valeur
}

async function lireTout($: EngineInterface, ici: string, now: number): Promise<Taches> {
  const t: Taches = {}
  if (mien) t[ici] = mien
  if (!dossier) return t
  let fermes: Fermes = {}
  try {
    for (const f of await $.fs.list(dossier)) {
      if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
      if (f.name === '_fermes.json') {
        fermes = ((await lireSiChange($, f.name, f.mtimeMs)) as Fermes | undefined) ?? {}
        continue
      }
      const id = f.name.slice(0, -5)
      // Une conversation muette depuis 12 h est oubliée sans même ouvrir son fichier.
      if (id === ici || now - f.mtimeMs > GARDE_FINI) continue
      const x = (await lireSiChange($, f.name, f.mtimeMs)) as Tache | null | undefined
      if (x) t[id] = x
    }
  } catch {
    return t
  }
  for (const [id, x] of Object.entries(t)) {
    const fa = fermes[`${id}:agents`]
    t[id] = {
      ...x,
      total: fermes[`${id}:plan`] === x.debut ? 0 : x.total,
      tour: x.tour && fermes[`${id}:tour`] === x.tour.debut ? undefined : x.tour,
      agents: fa ? Object.fromEntries(Object.entries(x.agents ?? {}).filter(([, a]) => a.debut > fa)) : (x.agents ?? {}),
    }
  }
  return t
}

const agentsFinis = (t: Tache) => {
  const a = Object.values(t.agents ?? {})
  return a.length > 0 && a.every(x => x.finA) ? Math.max(...a.map(x => x.finA ?? 0)) : 0
}

// Retire ce qui est fini depuis 12 h et ce qui est abandonné depuis 2 h.
function nettoyer(t: Taches, now: number): Taches {
  const garde: Taches = {}
  for (const [id, x] of Object.entries(t)) {
    const agents: Record<string, Agent> = {}
    for (const [k, a] of Object.entries(x.agents ?? {})) {
      if (a.finA ? now - a.finA < GARDE_FINI : now - a.debut < OUBLI) agents[k] = a
    }
    const plan = x.total > 0 && (x.finiA ? now - x.finiA < GARDE_FINI : now - x.maj < OUBLI)
    const tour = x.tour && (x.tour.finA ? now - x.tour.finA < GARDE_FINI : now - x.maj < OUBLI) ? x.tour : undefined
    if (plan || tour || Object.keys(agents).length) garde[id] = { ...x, total: plan ? x.total : 0, agents, tour }
  }
  return garde
}

// Sous Windows, $.audio.play ne joue rien : PowerShell joue le son à la place.
// Un son embarqué (mp3 en base64) est écrit une fois dans %TEMP%, puis lu ; à
// défaut, un son du système. Fin : le bip ; attente : le son d'attente.
// L'attente est jouée deux fois, un peu plus fort : une seconde lecture superposée
// au tiers du volume, le lecteur de Windows ne dépassant pas 100 %.
const SONS_WINDOWS: Record<string, { mp3?: string; nom: string; systeme: string; fois: number; renfort: number }> = {
  'fx/fin.mp3': { mp3: SONS.FIN, nom: 'fil-fin-1', systeme: 'Windows Notify System Generic', fois: 1, renfort: 0 },
  'fx/attente.mp3': { mp3: SONS.ATTENTE, nom: 'fil-attente-1', systeme: 'Windows Notify Messaging', fois: 2, renfort: 0.35 },
}
const LIRE_MP3 =
  "$f = Join-Path $env:TEMP ($env:FIL_SON + '.mp3'); " +
  'if (-not (Test-Path $f)) { [IO.File]::WriteAllBytes($f, [Convert]::FromBase64String([Console]::In.ReadToEnd())) }; ' +
  'Add-Type -AssemblyName PresentationCore; $renfort = [double]$env:FIL_RENFORT; ' +
  'function Lecteur($v) { $p = New-Object System.Windows.Media.MediaPlayer; $p.Open([Uri]$f); $p.Volume = $v; ' +
  '$t = 0; while (-not $p.NaturalDuration.HasTimeSpan -and $t -lt 60) { Start-Sleep -Milliseconds 50; $t++ }; $p }; ' +
  '$a = Lecteur 1; $b = if ($renfort -gt 0) { Lecteur $renfort } else { $null }; ' +
  '$ms = if ($a.NaturalDuration.HasTimeSpan) { $a.NaturalDuration.TimeSpan.TotalMilliseconds } else { 2000 }; ' +
  'for ($i = 0; $i -lt [int]$env:FIL_FOIS; $i++) { ' +
  '$a.Position = [TimeSpan]::Zero; $a.Play(); if ($b) { $b.Position = [TimeSpan]::Zero; $b.Play() }; ' +
  'Start-Sleep -Milliseconds ([int]$ms + 250); $a.Stop(); if ($b) { $b.Stop() } }; ' +
  '$a.Close(); if ($b) { $b.Close() }'

// Joue un son et garde la cause d'un échec, que /fil son affiche.
async function jouer($: EngineInterface, asset: string) {
  try {
    const son = SONS_WINDOWS[asset]
    if (son && (await $.env.get('OS')) === 'Windows_NT') {
      const r = son.mp3
        ? await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-STA', '-Command', LIRE_MP3], {
            stdin: son.mp3,
            env: { FIL_SON: son.nom, FIL_FOIS: String(son.fois), FIL_RENFORT: String(son.renfort) },
            timeoutMs: 15_000,
          })
        : await $.process.run(
            ['powershell', '-NoProfile', '-NonInteractive', '-Command', `(New-Object Media.SoundPlayer 'C:\\Windows\\Media\\${son.systeme}.wav').PlaySync()`],
            { timeoutMs: 15_000 },
          )
      if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `PowerShell a rendu ${r.exitCode}`)
    } else await $.audio.play({ asset })
    await $.store.set('sonErreur', '')
    return ''
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    await $.store.set('sonErreur', cause)
    return cause
  }
}

// Une réponse sans liste ne sonne que si elle a duré : pas de son à chaque message.
const TOUR_LONG = 30_000

// Lit toutes les conversations ; le son ne sonne que dans celle qui a fini ou attend.
async function synchroniser($: EngineInterface) {
  const now = await $.clock.now()
  const ici = await $.session.id()
  const t = nettoyer(await lireTout($, ici, now), now)
  const x = t[ici]
  if (x) {
    const sons = ((await $.store.get('sons')) as Record<string, number> | undefined) ?? {}
    const tourFini = x.total === 0 && x.tour?.finA && x.tour.finA - x.tour.debut >= TOUR_LONG ? x.tour.finA : 0
    let son = ''
    for (const [cle, quand, asset] of [
      [ici, x.finiA ?? 0, 'fx/fin.mp3'],
      [`${ici}:agents`, agentsFinis(x), 'fx/fin.mp3'],
      [`${ici}:tour`, tourFini, 'fx/fin.mp3'],
      [`${ici}:attente`, x.attente ?? 0, 'fx/attente.mp3'],
    ] as const) {
      if (quand && sons[cle] !== quand && now - quand < 60_000) {
        sons[cle] = quand
        son = asset
      }
    }
    if (son) {
      await $.store.set('sons', sons)
      void jouer($, son)
    }
  }
  const avant = await read($, taches)
  if (JSON.stringify(avant) !== JSON.stringify(t)) await update($, taches, () => t)
  return t
}

async function ecrireMien($: EngineInterface, id: string) {
  if (!dossier) return
  // Après /clear la conversation change d'identifiant : on vide l'ancien fichier.
  if (mienId && mienId !== id) await $.fs.write(`${dossier}/${mienId}.json`, 'null')
  mienId = id
  await $.fs.write(`${dossier}/${id}.json`, JSON.stringify(mien))
}

// Ne lève jamais : Fil ne doit pas gêner un outil ou un sous-agent.
async function modifier($: EngineInterface, fn: (x: Tache, now: number) => Tache | null) {
  try {
    const id = await $.session.id()
    const now = await $.clock.now()
    const x = mien ?? { titre: '', total: 0, faits: 0, outil: '', debut: now, maj: now, agents: {} }
    const y = fn(x, now)
    const avant = JSON.stringify(mien)
    mien = y ? (nettoyer({ [id]: { ...y, nom, maj: now } }, now)[id] ?? null) : null
    if (JSON.stringify(mien) !== avant || mienId !== id) await ecrireMien($, id)
    await synchroniser($)
  } catch {
    // affichage seulement : on ignore
  }
}

// Fin de la pause : le temps d'attente ne compte ni dans le chrono ni dans l'estimation.
const reprendre = (x: Tache, now: number): Tache => {
  if (x.attente === undefined) return x
  const pause = Math.max(0, now - x.attente)
  return { ...x, debut: x.debut + pause, faitA: x.faitA === undefined ? undefined : x.faitA + pause, attente: undefined }
}

async function publierPlan($: EngineInterface, etapes: Etape[]) {
  const total = etapes.length
  const faits = etapes.filter(x => x.statut === 'completed').length
  const enCours = etapes.find(x => x.statut === 'in_progress')
  const titre = enCours?.texte ?? etapes[etapes.length - 1]?.texte ?? 'Tâche'
  const avant = mien
  await modifier($, (x, now) => {
    const nouveau = x.total === 0 || x.finiA !== undefined
    const fini = total > 0 && faits === total
    return {
      ...x,
      titre: fini ? x.titre || titre : titre,
      total,
      faits,
      debut: nouveau && !fini ? now : x.debut,
      finiA: fini ? (x.finiA ?? now) : undefined,
      faitA: nouveau && !fini ? undefined : faits > x.faits ? now : x.faitA,
      attente: undefined,
    }
  })
  // Liste finie : sa durée par étape affine l'estimation des prochaines listes.
  const apres = mien as Tache | null
  if (apres?.finiA && !avant?.finiA && apres.total > 0) {
    const d = Math.max(10_000, Math.min(15 * 60_000, (apres.finiA - apres.debut) / apres.total))
    moyenneEtape = Math.round(moyenneEtape * 0.7 + d * 0.3)
    try {
      await $.store.set('moyenneEtape', moyenneEtape)
    } catch {
      // estimation seulement : on ignore
    }
  }
}

// × : chez soi on efface ; pour une autre conversation on note la fermeture dans
// _fermes.json, lu par toutes, sans toucher à son fichier. « plan » ferme la ligne
// principale : la liste de tâches et la réponse.
async function fermer($: EngineInterface, id: string, quoi: 'plan' | 'agents') {
  if (id === (await $.session.id())) {
    await modifier($, x => (quoi === 'plan' ? { ...x, total: 0, tour: undefined } : { ...x, agents: {} }))
    return
  }
  const x = (await read($, taches))[id]
  if (!x || !dossier) return
  const f = ((await lireJson($, `${dossier}/_fermes.json`)) as Fermes | undefined) ?? {}
  if (quoi === 'agents') f[`${id}:agents`] = await $.clock.now()
  else {
    f[`${id}:plan`] = x.debut
    if (x.tour) f[`${id}:tour`] = x.tour.debut
  }
  // On garde les 50 dernières fermetures.
  const garde = Object.fromEntries(Object.entries(f).slice(-50))
  await $.fs.write(`${dossier}/_fermes.json`, JSON.stringify(garde))
  await synchroniser($)
}

// /fil vider : ferme tout ce qui est terminé, dans toutes les conversations.
async function vider($: EngineInterface) {
  let n = 0
  for (const [id, x] of Object.entries(await read($, taches))) {
    const ag = Object.values(x.agents ?? {})
    if ((x.total > 0 && x.finiA) || x.tour?.finA) {
      await fermer($, id, 'plan')
      n++
    }
    if (ag.length && ag.every(a => a.finA)) {
      await fermer($, id, 'agents')
      n++
    }
  }
  return n
}

// --- Dessin SVG (bureau) : point animé, titre, matrice de points, pastille, %
const AMBRE = '#D29922'
const STYLE =
  '<style>text{font-family:"Segoe UI Variable Text","Segoe UI",-apple-system,system-ui,sans-serif;font-variant-numeric:tabular-nums}' +
  '.t{fill:#ECEAE6}.d{fill:#8E8A84}.f{fill:#5E5B57}.p{fill:#fff;fill-opacity:.07}.c{stroke:#8E8A84}' +
  '@media (prefers-color-scheme: light){.t{fill:#1F1E1C}.d{fill:#6B6862}.f{fill:#A19D97}.p{fill:#000;fill-opacity:.07}.c{stroke:#6B6862}}</style>'
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const tronquer = (s: string | undefined, n: number) => (!s ? '' : s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)
const chrono = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`
}
// Pour ce qui est fini : depuis combien de temps.
const depuis = (ms: number) => {
  const m = Math.floor(ms / 60_000)
  return m < 1 ? 'à l’instant' : m < 60 ? `il y a ${m} min` : `il y a ${Math.floor(m / 60)} h`
}
// Le temps est dessiné dans la barre, dans une colonne de même largeur sur
// toutes les lignes : il reste aligné, qu'il y ait une croix ou non.
const TEMPS_W = 104
// Colonne du temps restant estimé, entre le % et le temps.
const RESTE_W = 60
// Le temps est dans une bulle identique à la pastille de gauche (taille, police,
// contour), collée à droite. Sa couleur dit où en est la tâche : violet en cours,
// vert juste fini, gris quand c'est fini depuis plus de 15 min.
const GRIS = '#8E8A84'
const RECENT = 15 * 60_000
const couleurFin = (depuisMs: number) => (depuisMs < RECENT ? VERT : GRIS)
// Longueur du titre le plus long de la bande (titre + dossier), fixée à chaque
// dessin : les barres raccourcissent toutes ensemble pour lui laisser la place.
let titreMax = 0
// Largeur de la plus large pastille de la bande (« ✓ 7s » est étroite, « 3 en cours »
// plus large) : la barre s'arrête juste avant, sans la coller ni la laisser loin.
let pastilleMax = 64
const largPastille = (t: string) => (t ? Math.round(t.length * 11 * 0.56 + 18) : 0)

// Durée d'une étape : celle de cette liste dès qu'une étape est finie, sinon la
// moyenne des listes précédentes (gardée dans le store), sinon 90 s.
let moyenneEtape = 90_000
const dureeEtape = (x: Tache) => (x.faitA && x.faits > 0 ? (x.faitA - x.debut) / x.faits : moyenneEtape)

// Avancement continu : les étapes finies, plus une part de l'étape en cours qui
// monte avec le temps (vite au début, puis de plus en plus lentement, sans
// jamais atteindre l'étape suivante avant qu'elle soit vraiment finie).
function avancement(x: Tache, now: number): number {
  if (x.finiA !== undefined) return 100
  const t = (x.attente ?? now) - (x.faitA ?? x.debut)
  const part = Math.min(0.95, 1 - Math.exp(-Math.max(0, t) / dureeEtape(x)))
  return Math.min(99, Math.round(((x.faits + part) / x.total) * 100))
}

// Temps restant d'une liste en cours : la durée d'une étape, fois les étapes qui
// restent, moins ce que l'étape en cours a déjà pris.
function reste(x: Tache, now: number): string {
  if (x.faits >= x.total || x.finiA !== undefined) return ''
  const ms = Math.max(0, dureeEtape(x) * (x.total - x.faits) - (now - (x.faitA ?? x.debut)))
  const min = Math.round(ms / 60_000)
  if (min < 1) return '< 1 min'
  return min < 60 ? `≈ ${min} min` : `≈ ${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`
}

// Barre lisse : rail arrondi, dégradé, et un reflet qui glisse tant que la tâche tourne.
const matrice = (x: number, y: number, w: number, pct: number, coul: string, anime: boolean) => {
  const h = 6
  // Chaque SVG est un document à part : un id fixe suffit et garde la source stable.
  const id = `b${coul.slice(1)}`
  const lw = pct < 0 ? w : Math.max(h, (w * Math.max(0, Math.min(100, pct))) / 100)
  let s =
    `<defs><linearGradient id="${id}" x1="0" x2="1"><stop offset="0" stop-color="${coul}" stop-opacity=".5"/><stop offset="1" stop-color="${coul}"/></linearGradient>` +
    `<linearGradient id="${id}r" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
    `<clipPath id="${id}c"><rect x="${x}" y="${y + 2}" width="${lw.toFixed(1)}" height="${h}" rx="${h / 2}"/></clipPath></defs>` +
    `<rect class="p" x="${x}" y="${y + 2}" width="${w}" height="${h}" rx="${h / 2}"/>`
  if (pct < 0) {
    // Sans étapes à compter : un segment qui va et vient sur le rail.
    const seg = Math.round(w * 0.3)
    return (
      s +
      `<g clip-path="url(#${id}c)"><rect x="${x - seg}" y="${y + 2}" width="${seg}" height="${h}" rx="${h / 2}" fill="url(#${id})">` +
      `<animate attributeName="x" from="${x - seg}" to="${x + w}" dur="1.6s" repeatCount="indefinite"/></rect></g>`
    )
  }
  if (pct > 0) {
    s += `<rect x="${x}" y="${y + 2}" width="${lw.toFixed(1)}" height="${h}" rx="${h / 2}" fill="url(#${id})"/>`
    if (anime) {
      s += `<g clip-path="url(#${id}c)"><rect x="${x - 40}" y="${y + 2}" width="40" height="${h}" fill="url(#${id}r)">` +
        `<animate attributeName="x" from="${x - 40}" to="${(x + lw).toFixed(1)}" dur="1.8s" repeatCount="indefinite"/></rect></g>`
    }
  }
  return s
}

const icone = (type: 'point' | 'robot', coul: string, fini: boolean, anime: boolean) => {
  if (type === 'robot') {
    return (
      `<rect x="2.5" y="7" width="12" height="10" rx="3" fill="none" stroke="${coul}" stroke-width="1.4"/>` +
      `<line x1="8.5" y1="4" x2="8.5" y2="7" stroke="${coul}" stroke-width="1.4"/><circle cx="8.5" cy="3.5" r="1.3" fill="${coul}"/>` +
      `<circle cx="6" cy="12" r="1.3" fill="${coul}"/><circle cx="11" cy="12" r="1.3" fill="${coul}"/>`
    )
  }
  if (!fini && !anime) {
    // En pause : deux barres, Claude attend ta réponse.
    return `<circle cx="8.5" cy="12" r="6.5" fill="${coul}" fill-opacity=".18"/><rect x="5.6" y="8.8" width="2" height="6.4" rx="1" fill="${coul}"/><rect x="9.4" y="8.8" width="2" height="6.4" rx="1" fill="${coul}"/>`
  }
  if (fini) {
    return `<circle cx="8.5" cy="12" r="6" fill="${coul}" fill-opacity=".18"/><path d="M5.6,12.2 l2,2 l3.8,-4.2" fill="none" stroke="${coul}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
  }
  return (
    (anime
      ? `<circle cx="8.5" cy="12" r="3.5" fill="${coul}" fill-opacity=".5"><animate attributeName="r" values="3.5;7.5" dur="1.6s" repeatCount="indefinite"/><animate attributeName="fill-opacity" values=".45;0" dur="1.6s" repeatCount="indefinite"/></circle>`
      : '') + `<circle cx="8.5" cy="12" r="3.5" fill="${coul}"/>`
  )
}

const pastilleSvg = (xFin: number, y: number, h: number, texte: string, coul: string, anime: boolean, taille = 11) => {
  const w = Math.round(texte.length * taille * 0.56 + 18)
  const x = xFin - w
  const fond = anime
    ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${coul}" fill-opacity=".16"><animate attributeName="fill-opacity" values=".12;.26;.12" dur="2.2s" repeatCount="indefinite"/></rect>`
    : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${coul}" fill-opacity=".16"/>`
  return {
    w,
    svg:
      fond +
      `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="${(h - 1) / 2}" fill="none" stroke="${coul}" stroke-opacity=".35"/>` +
      `<text x="${x + w / 2}" y="${y + h / 2 + taille * 0.36}" font-size="${taille}" font-weight="600" text-anchor="middle" fill="${coul}">${esc(texte)}</text>`,
  }
}

type LigneSvg = {
  W: number
  titre: string
  suffixe: string
  pct: number
  pastille: string
  fini: boolean
  icone: 'point' | 'robot'
  temps: string
  couleurTemps?: string
  reste?: string
  indetermine?: boolean
  // Claude attend ta réponse : ambre, immobile.
  attente?: boolean
}

const svgLigne = (l: LigneSvg) => {
  const H = 24
  const coul = l.attente ? AMBRE : l.fini ? VERT : VIOLET
  const anime = !l.fini && !l.attente
  const pctTxt = l.indetermine ? '' : `${l.pct} %`
  const xPct = l.W - TEMPS_W - RESTE_W
  const p = pastilleSvg(xPct - 40, 3, 18, l.pastille, coul, anime)
  // Place fixe pour la pastille : toutes les barres commencent et finissent au même endroit.
  const finBarre = xPct - 40 - Math.max(pastilleMax, p.w) - 8
  // Une longueur de base généreuse, quitte à couper le titre ; plus longue si le titre est court.
  const base = Math.max(170, Math.min(240, Math.round(l.W * 0.28)))
  const mw = Math.max(base, Math.min(300, finBarre - 30 - titreMax * 6.4 - 8))
  const xMat = finBarre - mw
  // Le titre s'arrête une quinzaine de pixels avant la barre.
  const place = Math.max(8, Math.floor((xMat - 46) / 6))
  // Le titre passe avant le nom du dossier : on coupe le dossier d'abord.
  const titre = tronquer(l.titre, Math.max(6, place - (l.suffixe ? 4 : 0)))
  const suffixe = tronquer(l.suffixe, Math.max(0, place - titre.length))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${l.W}" height="${H}" viewBox="0 0 ${l.W} ${H}">${STYLE}` +
    icone(l.icone, coul, l.fini, anime) +
    `<text x="24" y="16.5" font-size="12.5"><tspan class="t" font-weight="600">${esc(titre)}</tspan>` +
    (suffixe ? `<tspan class="f">${esc(suffixe)}</tspan>` : '') +
    `</text>` +
    matrice(xMat, 6.5, mw, l.indetermine ? -1 : l.pct, coul, anime) +
    p.svg +
    `<text class="d" x="${xPct}" y="16.5" font-size="11.5" text-anchor="end">${pctTxt}</text>` +
    // L'estimation suit le %, à gauche ; le temps reste à droite, dans son cadre.
    (l.reste ? `<text class="d" x="${xPct + 12}" y="16.5" font-size="11.5">${esc(l.reste)}</text>` : '') +
    (l.temps ? pastilleSvg(l.W, 3, 18, l.temps, l.couleurTemps ?? coul, anime).svg : '') +
    `</svg>`
  )
}

// Un employé qui rend la main à son supérieur répond « STATUT : ESCALADE → … » :
// Fil ne lit que cette ligne de sa réponse, pour savoir vers qui il est monté.
function lireEscalade(reponse: string): string | undefined {
  const ligne = /STATUT\s*:\s*ESCALADE[^\n]*/i.exec(reponse)?.[0]
  if (!ligne) return undefined
  return /sonnet/i.test(ligne) ? 'sonnet' : 'chef'
}

const svgAgent = (W: number, a: Agent, temps: string) => {
  const H = 20
  const fini = !!a.finA
  // Ambre : l'employé a appelé son supérieur.
  const coul = a.escalade ? AMBRE : fini ? VERT : VIOLET
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${STYLE}`
  s += `<text class="f" x="30" y="14" font-size="11">${a.n}</text>`
  s += `<circle cx="44" cy="10" r="3" fill="${coul}">${fini ? '' : '<animate attributeName="fill-opacity" values="1;.35;1" dur="1.4s" repeatCount="indefinite"/>'}</circle>`
  s += pastilleSvg(W, 2, 16, temps, coul, !fini, 10).svg
  let xFin = W - TEMPS_W
  const etiquette = a.escalade ? `↑ ${a.escalade}` : a.outil && !fini ? a.outil : ''
  if (etiquette) {
    const p = pastilleSvg(xFin, 2, 16, etiquette, a.escalade ? AMBRE : VIOLET, !fini, 10)
    s += p.svg
    xFin -= p.w + 10
  }
  const place = Math.max(8, Math.floor((xFin - 56) / 6.6))
  const modele = ` (${a.modele})`
  s +=
    `<text x="54" y="14" font-size="12"><tspan class="t">${esc(tronquer(a.desc, Math.max(6, place - modele.length)))}</tspan>` +
    `<tspan class="d">${esc(modele)}</tspan></text>`
  return s + `</svg>`
}

export const register: Register = on => {
  // La liste de la session courante, telle que Claude la tient.
  let etapes: Etape[] = []
  let compteur = 0
  let ticks = 0

  on('session.start', async ($, e, next) => {
    const id = await $.session.id()
    await update($, moi, () => id)
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    dossier = home ? `${home.replace(/[\\/]+$/, '')}/.claude/fil-sessions` : undefined
    const racine = await $.session.root()
    nom = /scratch-workspaces/i.test(racine) ? '' : (racine.split(/[\\/]/).filter(Boolean).pop() ?? '')
    // Après un rechargement du mod, on reprend sa propre barre là où elle était.
    if (dossier && !mien) {
      mien = ((await lireJson($, `${dossier}/${id}.json`)) as Tache | null | undefined) ?? null
      mienId = mien ? id : ''
    }
    const m = await $.store.get('moyenneEtape')
    if (typeof m === 'number' && m > 0) moyenneEtape = m
    await $.command.register({ name: 'fil', description: 'Fil : masquer, afficher ou vider les barres de tâches', argumentHint: 'masquer | afficher | vider | son' })
    await synchroniser($)
    $.clock.every(1000, () => {
      void synchroniser($).then(x => {
        // Chaque seconde tant qu'une barre tourne ; chaque minute sinon, pour « il y a … ».
        const tourne = Object.values(x).some(
          y => (y.total && !y.finiA && y.attente === undefined) || (y.tour && !y.tour.finA) || Object.values(y.agents).some(a => !a.finA),
        )
        if (tourne || ++ticks % 60 === 0) {
          $.ui.invalidate('ui.render')
        }
      })
    })
    return next(e)
  })

  // Sous-agents : lancement, outil en cours, fin.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (!('deny' in r && r.deny) && r.agentId) {
      const agentId = r.agentId
      compteur += 1
      const n = compteur
      await modifier($, (x, now) => ({
        ...x,
        agents: {
          ...x.agents,
          [agentId]: { n, desc: e.description || e.subagentType, modele: modeleCourt(r.model), debut: now, outil: '' },
        },
      }))
    }
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      await modifier($, x => {
        const a = x.agents?.[agentId]
        return a ? { ...x, agents: { ...x.agents, [agentId]: { ...a, outil: libelle(e.tool) } } } : x
      })
    } else if (!e.tool.startsWith('mcp__ccd_turn__')) {
      await modifier($, x => (x.total || (x.tour && !x.tour.finA) ? { ...x, outil: libelle(e.tool) } : x))
    }

    // Une question posée en cours de réponse met aussi la liste en pause.
    const question = !agentId && e.tool === 'AskUserQuestion'
    if (question) await modifier($, (x, now) => (x.total && !x.finiA ? { ...x, attente: now } : x))
    const res = await next(e)
    if (question) await modifier($, (x, now) => reprendre(x, now))
    if (agentId) return res
    const a = e as unknown as Record<string, unknown>

    if (e.tool === 'mcp__ccd_turn__update_plan') {
      const items = a.items as { content: string; status: Etape['statut'] }[] | undefined
      if (items) etapes = items.map(x => ({ texte: x.content, statut: x.status }))
      const marquer = (i: number, statut: Etape['statut']) => {
        const x = etapes[i]
        if (x) x.statut = statut
      }
      if (a.advance) {
        const i = etapes.findIndex(x => x.statut === 'in_progress')
        if (i >= 0) marquer(i, 'completed')
        const j = etapes.findIndex(x => x.statut === 'pending')
        if (j >= 0) marquer(j, 'in_progress')
      }
      for (const n of (a.done as number[] | undefined) ?? []) marquer(n - 1, 'completed')
      if (typeof a.start === 'number') marquer(a.start - 1, 'in_progress')
      await publierPlan($, etapes)
    } else if (e.tool === 'mcp__ccd_turn__wrap_up' && etapes.length) {
      etapes = etapes.map(x => ({ ...x, statut: 'completed' }))
      await publierPlan($, etapes)
    } else if (e.tool === 'TodoWrite') {
      const todos = a.todos as { content: string; status: Etape['statut']; activeForm: string }[] | undefined
      if (todos) {
        etapes = todos.map(x => ({ texte: x.status === 'in_progress' ? x.activeForm : x.content, statut: x.status }))
        await publierPlan($, etapes)
      }
    }
    return res
  }).catch(($, e, next) => next(e))

  // Une réponse commence (fil principal) : une barre même sans liste de tâches.
  // Fil n'ouvre jamais le texte de ton message.
  on('turn.start', async ($, e, next) => {
    const res = await next(e)
    if (!e.agentId) await modifier($, (x, now) => ({ ...reprendre(x, now), tour: { debut: now }, outil: '' }))
    return res
  })

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    const agentId = e.agentId
    if (!agentId) {
      // La réponse s'arrête avant la fin de la liste : Claude attend la tienne.
      await modifier($, (x, now) => ({
        ...x,
        tour: x.tour ? { ...x.tour, finA: x.tour.finA ?? now } : x.tour,
        outil: '',
        attente: x.total && !x.finiA ? (x.attente ?? now) : undefined,
      }))
    } else {
      await modifier($, (x, now) => {
        const a = x.agents?.[agentId]
        const escalade = lireEscalade(e.answer)
        return a ? { ...x, agents: { ...x.agents, [agentId]: { ...a, finA: now, outil: '', escalade } } } : x
      })
    }
    return res
  })

  // Masquer ne coupe que l'affichage : le suivi et le son continuent.
  on('command.run', { command: 'fil' }, async ($, e) => {
    const a = e.args.trim()
    if (a === 'masquer' || a === 'afficher') {
      await $.store.set('masque', a === 'masquer')
      $.ui.invalidate('ui.render')
      return { text: a === 'masquer' ? 'Fil masqué. /fil afficher pour le revoir.' : 'Fil affiché.' }
    }
    if (a === 'son') {
      const fin = await jouer($, 'fx/fin.mp3')
      const attente = fin ? '' : await jouer($, 'fx/attente.mp3')
      const cause = fin || attente
      return { text: cause ? `Son impossible ici : ${cause}` : 'Deux sons joués : la fin, puis l’attente. Rien entendu ? Vérifie le volume de Windows.' }
    }
    if (a === 'vider') {
      const n = await vider($)
      return { text: n ? `${n} barre${n > 1 ? 's' : ''} terminée${n > 1 ? 's' : ''} fermée${n > 1 ? 's' : ''}.` : 'Rien de terminé à fermer.' }
    }
    const masque = (await $.store.get('masque')) === true
    return { text: `Fil ${masque ? 'masqué' : 'affiché'}.\n/fil masquer · /fil afficher · /fil vider (ferme tout ce qui est terminé) · /fil son (teste le son)` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const autres = await next(e)
    if ((await $.store.get('masque')) === true) return autres
    // La plus récente en haut, toutes conversations confondues.
    const recence = (x: Tache) =>
      Math.max(x.total > 0 ? x.debut : 0, x.tour?.debut ?? 0, ...Object.values(x.agents ?? {}).map(a => a.debut))
    const liste = Object.entries(await read($, taches)).sort((x, y) => recence(y[1]) - recence(x[1]))
    if (e.props.hasSurvey || liste.length === 0) return autres
    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const Svg = 'Svg' in t ? t.Svg : null
    const ici = await read($, moi)
    const now = await $.clock.now()
    const w = e.props.bodyColumns
    // La barre va presque jusqu'à la croix : le temps reste collé à elle.
    const W = Math.max(300, Math.min(1130, Math.round(w * 7.4) - 22))

    titreMax = Math.max(
      0,
      ...liste.map(([id, x]) => {
        const nomLong = id === ici ? 0 : x.nom ? x.nom.length + 3 : 21
        return Math.max(x.titre.length, 17) + nomLong
      }),
    )
    pastilleMax = Math.max(
      64,
      ...liste.flatMap(([, x]) => {
        const ags = Object.values(x.agents ?? {})
        return [
          x.outil ?? '',
          x.tour && x.tour.finA === undefined ? 'réfléchit' : '',
          ags.some(a => !a.finA) ? '9 en cours' : ags.length ? 'terminés' : '',
          ags.some(a => a.escalade) ? '9 ↑ escaladés' : '',
        ].map(largPastille)
      }),
    )
    const lignes: any[] = []
    // Le temps est dans la barre ; à droite, seulement la croix (style léger).
    const ligne = (cle: string, svg: string, alt: string, hauteur: number, fermer?: () => unknown) =>
      lignes.push(
        <Box key={cle} flexDirection="row" alignItems="center" columnGap={1}>
          {Svg ? <Svg source={svg} alt={alt} width={W} height={hauteur} /> : <Text>{alt}</Text>}
          {/* La croix colle au bord droit de la bande. */}
          <Box flexGrow={1} />
          {fermer ? <Button key={`x-${cle}`} label="✕" plain dimColor onPress={fermer} /> : null}
        </Box>,
      )

    for (const [id, x] of liste) {
      // Une barre d'une autre conversation porte le nom de son dossier de projet.
      const suffixe = id === ici ? '' : x.nom ? ` · ${x.nom}` : ' · autre conversation'

      // Une ligne principale par conversation : la liste de tâches, sauf si une
      // réponse plus récente a commencé après qu'elle est finie.
      const planVisible = x.total > 0 && !(x.finiA !== undefined && x.tour && x.tour.debut > x.finiA)
      if (planVisible) {
        const pct = avancement(x, now)
        const fini = x.finiA !== undefined
        const attente = !fini && x.attente !== undefined
        const pastille = fini ? `✓ ${chrono((x.finiA ?? now) - x.debut)}` : attente ? '⏸ à toi' : x.outil || `${x.faits}/${x.total}`
        const temps = fini ? depuis(now - (x.finiA ?? now)) : chrono((x.attente ?? now) - x.debut)
        const r = attente ? '' : reste(x, now)
        ligne(
          `p-${id}`,
          svgLigne({
            W,
            titre: x.titre,
            suffixe,
            pct,
            pastille,
            fini,
            icone: 'point',
            temps,
            reste: r,
            couleurTemps: fini ? couleurFin(now - (x.finiA ?? now)) : attente ? AMBRE : VIOLET,
            attente,
          }),
          `${x.titre}${suffixe} : ${pct} %${attente ? ' · attend ta réponse' : ''}${r ? ` · reste ${r}` : ''} · ${temps}`,
          24,
          () => fermer($, id, 'plan'),
        )
      } else if (x.tour) {
        const fini = x.tour.finA !== undefined
        const titre = fini ? 'Réponse terminée' : 'Réponse en cours'
        const temps = fini ? depuis(now - (x.tour.finA ?? now)) : chrono(now - x.tour.debut)
        ligne(
          `r-${id}`,
          svgLigne({
            W,
            titre,
            suffixe,
            pct: fini ? 100 : 0,
            pastille: fini ? `✓ ${chrono((x.tour.finA ?? now) - x.tour.debut)}` : x.outil || 'réfléchit',
            fini,
            icone: 'point',
            temps,
            couleurTemps: fini ? couleurFin(now - (x.tour.finA ?? now)) : VIOLET,
            indetermine: !fini,
          }),
          `${titre}${suffixe} · ${temps}`,
          24,
          () => fermer($, id, 'plan'),
        )
      }

      const agents = Object.values(x.agents ?? {}).sort((a, b) => a.n - b.n)
      if (agents.length) {
        const finis = agents.filter(a => a.finA).length
        const actifs = agents.length - finis
        const escalades = agents.filter(a => a.escalade).length
        const pct = Math.round((finis / agents.length) * 100)
        ligne(
          `a-${id}`,
          svgLigne({
            W,
            titre: `Agents · ${agents.length} lancé${agents.length > 1 ? 's' : ''}`,
            suffixe,
            pct,
            pastille: actifs ? `${actifs} en cours` : escalades ? `${escalades} ↑ escaladé${escalades > 1 ? 's' : ''}` : 'terminés',
            fini: actifs === 0,
            icone: 'robot',
            temps: '',
          }),
          `Agents${suffixe} : ${actifs} en cours`,
          24,
          () => fermer($, id, 'agents'),
        )
        for (const a of agents) {
          const temps = chrono((a.finA ?? now) - a.debut)
          ligne(`ag-${id}-${a.n}`, svgAgent(W, a, temps), `Agent ${a.n} : ${a.desc} · ${temps}`, 20)
        }
      }
    }

    // Fil passe au-dessus de tout le reste de la bande.
    return (
      <Box flexDirection="column">
        {lignes}
        {autres ?? null}
      </Box>
    )
  })
}
