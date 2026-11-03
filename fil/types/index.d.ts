export type Agent = {
  n: number
  desc: string
  modele: string
  debut: number
  outil: string
  finA?: number
  // Vers qui l'employé a escaladé : 'sonnet' ou 'chef'.
  escalade?: string
}

export type Tache = {
  titre: string
  total: number
  faits: number
  outil: string
  debut: number
  maj: number
  finiA?: number
  // Heure de la dernière étape finie, pour estimer le temps restant.
  faitA?: number
  // Dossier du projet de la conversation, pour la reconnaître depuis une autre.
  nom?: string
  // La dernière réponse de Claude, avec ou sans liste de tâches.
  tour?: { debut: number; finA?: number }
  // Claude attend ta réponse depuis cette heure : la liste est en pause, le chrono figé.
  attente?: number
  agents: Record<string, Agent>
}

export type Taches = Record<string, Tache>

declare module 'claude-code' {
  interface PluginState {
    fil: { taches: Shaped<Taches>; moi: string }
  }
}
