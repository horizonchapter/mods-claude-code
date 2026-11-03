export type Mesure = {
  ctxTokens: number | null
  ctxWindow: number
  ctxPct: number | null
  pct5h: number | null
  reset5h: string | null
  pct7j: number | null
}

// ecriture : Claude écrit la passation ; controle : un Claude neuf la relit, rien
// ne doit bouger avant l'effacement.
export type Phase = 'repos' | 'ecriture' | 'controle'

// tours : corrections déjà demandées ; attentes : réponses de la tâche en cours finies
// avant celle du relais ; decisionsAvant : DECISIONS.md avant le relais, qui doit
// rester intact au début du nouveau.
export type Relais = {
  debut: number
  racine: string
  archive: string
  tours: number
  attentes: number
  decisionsAvant: string
}

declare module 'claude-code' {
  interface PluginState {
    'jauge-plus': {
      mesure: Shaped<Mesure | null>
      phase: Phase
      dernierEchange: number | null
      relais: Shaped<Relais | null>
    }
  }
}
