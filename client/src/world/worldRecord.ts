import { readRecipeValue } from './save/recipeYaml'
import { historyFromYaml, historyToYamlLines, type WorldHistory } from './save/worldHistory'
import { specFromYaml, specToYamlLines, WORLD_SPEC_FIELDS, type WorldSpec } from './save/worldSpec'

// A WORLD AS THE GENERATOR HOLDS IT, as one value: who it is, what it was
// made with, and how far it was taken — everything world.yaml says and a
// save's "has it changed since" compares. Saving and loading the recipe are
// functions of this value (recordToYaml, recordFromYaml), and so is the
// comparison (recordSignature, recordDiff), so the three cannot drift
// apart. The generator screen used to keep these as a dozen loose variables
// that the save gathered and the load scattered (2026-10-02).
//
// Not here: the simulation's own state (state.json and the rasters) and
// the computed fields — those are the snapshot and the layers of the
// archive (world/save/worldArchive.ts), written beside this.

export interface WorldRecord {
  // The world's stable identity in the server's store (`metadata.uid`).
  uid: string
  // Its name — not part of the spec: renaming does not make another world.
  name: string
  // How many times it has been written (the server's optimistic lock).
  revision: number
  // The recipe: the seed and one value per control.
  spec: WorldSpec
  // The runs that made it (save/worldHistory.ts).
  history: WorldHistory
  // How far it was taken: the Archean's epochs, the tectonics' epoch, and
  // how many of those eroded. The first two travel in the snapshot
  // (state.json), not in world.yaml; the last in `status.erosionRun`.
  archeanEpochs: number
  epoch: number
  erosionRun: number
}

// world.yaml. `generator` is the build that writes it — provenance, never
// compared.
export function recordToYaml(record: WorldRecord, generator: string): string {
  return [
    'apiVersion: casas-eternas/v1alpha1',
    'kind: FlatWorld',
    'metadata:',
    `  name: ${record.name || record.spec.seed || 'world'}`,
    // The world's own identity, stable across further erosion and across
    // re-saves — the key the server's world store is addressed by. Distinct
    // from the TERRAIN's identity (identity.deriveWorldId), which moves
    // whenever the terrain does.
    `  uid: ${record.uid}`,
    'spec:',
    ...specToYamlLines(record.spec),
    'status:',
    // Only what state.json does not carry: the snapshot holds the epochs.
    `  erosionRun: ${record.erosionRun}`,
    `  revision: ${record.revision}`,
    // PROVENANCE (app/buildVersion.ts): which build wrote this stand.
    `  generator: ${generator}`,
    // The runs, absent while no run has happened.
    ...historyToYamlLines(record.history),
    '',
  ].join('\n')
}

// A record from world.yaml and the snapshot's epochs. `fallbackUid` names a
// save written before `metadata.uid` existed (identity.deriveWorldUid).
export function recordFromYaml(yaml: string, epochs: { archeanEpochs: number; epoch: number }, fallbackUid: () => string): WorldRecord {
  const seed = readRecipeValue(yaml, 'spec.seed') ?? ''
  return {
    uid: readRecipeValue(yaml, 'metadata.uid') || fallbackUid(),
    // A world saved before step 0 existed was named after its seed.
    name: readRecipeValue(yaml, 'metadata.name') ?? seed,
    revision: Number(readRecipeValue(yaml, 'status.revision') ?? 0),
    spec: specFromYaml(yaml, seed),
    history: historyFromYaml(yaml),
    archeanEpochs: epochs.archeanEpochs,
    epoch: epochs.epoch,
    erosionRun: Number(readRecipeValue(yaml, 'status.erosionRun') ?? 0),
  }
}

// What "unchanged since the save" compares: the name, the recipe, how far
// the world was taken and the code its runs were made with. Not the uid or
// the revision (bookkeeping, not the world), not the rest of the history
// (it follows the epochs and the values). The code, because a world made
// again by other code (world/replay.ts) is a different world under the
// same values.
export function recordSignature(record: WorldRecord): string {
  return JSON.stringify(signatureParts(record))
}

// The fields in which two records differ, by name — what the screen logs
// when a world it just loaded reads as changed.
export function recordDiff(a: WorldRecord, b: WorldRecord): string[] {
  const pa = signatureParts(a)
  const pb = signatureParts(b)
  return Object.keys(pa).filter((k) => JSON.stringify(pa[k]) !== JSON.stringify(pb[k])).map((k) => `${k}: ${JSON.stringify(pa[k])} → ${JSON.stringify(pb[k])}`)
}

function signatureParts(record: WorldRecord): Record<string, unknown> {
  const parts: Record<string, unknown> = {
    name: record.name,
    seed: record.spec.seed,
    archeanEpochs: record.archeanEpochs,
    epoch: record.epoch,
    erosionRun: record.erosionRun,
    code: [...record.history.genesis, ...record.history.tectonics].map((run) => run.code),
  }
  for (const field of WORLD_SPEC_FIELDS) parts[field.path] = record.spec.values[field.path]
  return parts
}
