import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Etat } from '../types'
import type { Passe } from './consignes'
import { extraire, lireAnalyse, MODELE, passeAnalyse, passeReecriture, proteger, SEUIL_DEUX_PASSES } from './consignes'

// Plume : « Améliorer le prompt » / « Revenir à mon texte ». Rien ne se passe sans clic.
// Ses boutons sont dessinés par Jauge+, à côté du relais ; sans Jauge+, tape /plume.
// Seul mod qui lit ton prompt, et seulement au clic. Il ne l'envoie jamais.

const original = atom({ plugin: 'plume', key: 'original' } as const, null)
const etat = atom({ plugin: 'plume', key: 'etat' } as const, 'pret')
const enCours = atom({ plugin: 'plume', key: 'enCours' } as const, false)

// Une passe du modèle ; renvoie le texte, ou pourquoi il n'y en a pas.
async function appeler($: EngineInterface, p: Passe): Promise<{ texte: string } | { pourquoi: string }> {
  const r = await $.model.complete({ model: MODELE, effort: 'medium', ...p })
  if (r.isAnswered) return { texte: r.text }
  return { pourquoi: r.reason === 'aborted' ? 'trop long à répondre' : r.reason === 'api-error' ? `erreur ${r.error}` : 'réponse vide' }
}

async function ameliorer($: EngineInterface) {
  if (await read($, enCours)) return
  const { text } = await $.prompt.read()
  if (!text.trim()) {
    $.ui.toast('Plume : la zone de saisie est vide.')
    return
  }
  await update($, enCours, () => true)
  const p = proteger(text)
  const long = p.texte.length > SEUIL_DEUX_PASSES
  try {
    // Longue dictée : d'abord comprendre et lister toutes les idées, puis réécrire.
    let analyse: string | undefined
    if (long) {
      $.ui.status('Plume : lecture de ta dictée (1/2)…')
      const a = await appeler($, passeAnalyse(p.texte))
      analyse = 'texte' in a ? lireAnalyse(a.texte) : undefined
    }
    $.ui.status(long ? 'Plume : réécriture (2/2)…' : 'Plume : réécriture…')
    const r = await appeler($, passeReecriture(p.texte, analyse))
    const res = 'texte' in r ? extraire(r.texte, p.blocs) : r
    if (!('texte' in res)) {
      await update($, etat, () => 'erreur' as Etat)
      $.ui.toast(`Plume : ${res.pourquoi}, ton texte est inchangé.`)
      return
    }
    await update($, original, () => text)
    await $.prompt.fill({ text: res.texte, mode: 'replace' })
    await update($, etat, () => 'ecrit' as Etat)
  } finally {
    $.ui.status(undefined)
    await update($, enCours, () => false)
  }
}

async function revenir($: EngineInterface) {
  const texte = await read($, original)
  if (texte === null) {
    $.ui.toast('Plume : rien à restaurer.')
    return
  }
  await $.prompt.fill({ text: texte, mode: 'replace' })
  await update($, original, () => null)
  await update($, etat, () => 'pret' as Etat)
}

export const register: Register = on => {
  // Les boutons sont dessinés par Jauge+ (à côté du relais) ; Plume réagit au clic,
  // réécrit dans ta zone de saisie et n'écrit rien dans le chat.
  on('ui.press', async ($, e, next) => {
    const res = await next(e)
    if (e.plugin.startsWith('jauge-plus')) {
      if (e.element === 'plume') void ameliorer($).catch(() => undefined)
      else if (e.element === 'plume-retour') void revenir($).catch(() => undefined)
    }
    return res
  })

  // Une fois la réponse arrivée, on oublie l'ancien texte.
  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    if (!e.agentId) {
      await update($, original, () => null)
      await update($, etat, () => 'pret' as Etat)
    }
    return res
  })
}
