import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { On } from 'claude-code'

import { extraire, proteger } from './consignes'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

// Une zone de saisie et un modèle qui répond ce qu'on lui dit.
function monde(on: On, saisie: string, reponses: string[]) {
  mock.clock(on, { now: 0 })
  let zone = saisie
  const appels: { system?: string; prompt: string; maxTokens?: number }[] = []
  const toasts: string[] = []
  on('prompt.read', () => ({ value: { text: zone } }) as never)
  on('prompt.fill', (_, e) => {
    zone = e.text
    return { isFilled: true } as never
  })
  on('model.complete', (_, e) => {
    appels.push({ system: e.system, prompt: e.prompt, maxTokens: e.maxTokens })
    return { value: { isAnswered: true, text: reponses.shift() ?? '', usage: USAGE } } as never
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }) as never)
  return { zone: () => zone, appels, toasts }
}

// Les boutons de Plume sont dessinés par Jauge+ : une Jauge+ minimale les porte ici.
const jauge: Plugin = {
  name: 'jauge-plus',
  register: on => {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
      const { Box, Button } = $.ui.resolve(e)
      return (
        <Box>
          <Button key="plume" label="Améliorer le prompt" onPress={() => undefined} />
          <Button key="plume-retour" label="Revenir à mon texte" onPress={() => undefined} />
        </Box>
      )
    })
  },
}
const BANDE = {
  plugin: 'jauge-plus',
  component: 'AbovePrompt',
  surface: 'desktop',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
async function cliquer($: Engine, key: string) {
  const ui = await $.ui.mount(BANDE as never)
  await ui.press({ key })
  await ui.unmount()
}

test('réécrit, puis « Revenir à mon texte » rend exactement l’original', { plugins: [jauge] }, async ($, on) => {
  const original = 'euh je veux que tu corrige le bouton  merci merci'
  const w = monde(on, original, ['<prompt>Corrige le bouton.</prompt>'])
  await cliquer($, 'plume')
  expect(w.zone()).toBe('Corrige le bouton.')
  expect(w.appels).toHaveLength(1)
  expect(w.appels[0]!.prompt).toContain('<dictee>')

  await cliquer($, 'plume-retour')
  expect(w.zone()).toBe(original)
})

test('réponse coupée (pas de balise de fin) : le texte ne bouge pas', { plugins: [jauge] }, async ($, on) => {
  const w = monde(on, 'mon texte', ['<prompt>Début de réécri'])
  await cliquer($, 'plume')
  expect(w.zone()).toBe('mon texte')
  expect(w.toasts.join(' ')).toContain('inchangé')
})

test('longue dictée : deux passes, l’analyse est donnée à la réécriture, sans plafond trop bas', { plugins: [jauge] }, async ($, on) => {
  const long = 'je dis une idée puis une autre '.repeat(200)
  const w = monde(on, long, ['<analyse>IDÉES : 1. une idée</analyse>', '<prompt>Version propre.</prompt>'])
  await cliquer($, 'plume')
  expect(w.appels).toHaveLength(2)
  expect(w.appels[1]!.prompt).toContain('IDÉES : 1. une idée')
  expect(w.appels[1]!.maxTokens).toBeGreaterThan(2000)
  expect(w.zone()).toBe('Version propre.')
})

test('code, liens et chemins ne passent pas par le modèle et reviennent tels quels', () => {
  const p = proteger('regarde C:\\Users\\moi\\a.txt et https://exemple.fr/x, puis `npm test`.')
  expect(p.texte).not.toContain('exemple.fr')
  expect(p.blocs).toEqual(['C:\\Users\\moi\\a.txt', 'https://exemple.fr/x', '`npm test`'])
  const r = extraire('<prompt>Lis ⟦1⟧, ouvre ⟦2⟧ et lance ⟦3⟧.</prompt>', p.blocs)
  expect(r).toEqual({ texte: 'Lis C:\\Users\\moi\\a.txt, ouvre https://exemple.fr/x et lance `npm test`.' })
  expect(extraire('<prompt>Lis ⟦1⟧.</prompt>', p.blocs)).toEqual({ pourquoi: 'un bloc de code, lien ou chemin a disparu' })
})
