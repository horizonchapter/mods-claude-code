export type Etat = 'pret' | 'ecrit' | 'erreur'

declare module 'claude-code' {
  interface PluginState {
    plume: { original: string | null; etat: Etat; enCours: boolean }
  }
}
