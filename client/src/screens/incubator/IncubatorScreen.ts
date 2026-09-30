import { ArcRotateCamera, Color4, Scene, Vector3 } from '@babylonjs/core'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import { relabel } from '../../i18n/relabel'
import { listServerArtifacts } from '../../server/artifactsClient'
import { meshLevelStage, meshPipelineVersion } from '../../world/meshArtifacts'
import { createHelpTooltip } from '../../ui/help/HelpTooltip'
import { createServerIndicator } from '../../ui/serverIndicator/ServerIndicator'
import { createSidebar } from '../../ui/sidebar/Sidebar'
import { createTitleBar } from '../../ui/titleBar/TitleBar'
import { createWorldChooser } from '../../ui/worldChooser/WorldChooser'
import '../../ui/theme/design.css'

// THE INCUBATOR: the step between the generator and the game. The generator
// makes a world; the incubator will grow its prehistory — not the geological
// one, the human one: peoples, their spread, what they did before the game
// starts. It replaces the generator's migration step once it can.
//
// It works on a FINISHED world and needs level 1 of it (the world refined on
// the server, the finishing step's job): that is the terrain it will run on.
// So its first step is the generator's world list, which opens only the
// worlds that hold level 1.
//
// Built so far: the title bar, the column and the world list. After a
// choice the column names the world; the scene stays empty until the world
// is drawn here.

// The level the incubator runs on.
const LEVEL = 1

// The server worlds (by uid) that hold the level for this client's pipeline.
// Any revision of a world counts: the world list does not say which terrain
// a world holds now, so the level can belong to an older one. Not in
// world/meshArtifacts beside meshPipelineVersion, because the job worker
// bundles that module and must not carry the server client.
async function worldsWithLevel(): Promise<Set<string>> {
  const listed = await listServerArtifacts()
  const stage = meshLevelStage(LEVEL)
  const version = meshPipelineVersion(LEVEL)
  const uids = new Set<string>()
  for (const a of listed?.artifacts ?? []) {
    if (a.stage === stage && a.pipelineVersion === version && a.worldUid !== '') uids.add(a.worldUid)
  }
  return uids
}

export const createIncubatorScreen: ScreenFactory = (ctx: ScreenContext): Screen => {
  const scene = new Scene(ctx.engine)
  scene.clearColor = new Color4(1, 1, 1, 1)
  // A scene renders only through a camera; this one looks at nothing yet.
  new ArcRotateCamera('camera', -Math.PI / 2, Math.PI / 2.5, 6, Vector3.Zero(), scene)

  const root = document.createElement('div')
  root.className = 'incubator-screen'

  // Sign-in for the title bar's account chip, as on the other screens.
  const serverIndicator = createServerIndicator(root)

  const titleBar = createTitleBar(root, {
    nameKey: 'common.title.nav.incubator',
    onSignIn: () => serverIndicator.openSignIn(),
    // Nothing here is lost by leaving: the world stays where it is kept.
    onHomeClick: () => ctx.goTo('title'),
    onLocaleChange: () => {
      sidebar.relabel()
      relabel(sidebar.body)
      worldChooser.relabel()
    },
  })
  titleBar.setWorld(null)

  const sidebar = createSidebar(root, 'incubator.step')
  sidebar.setStep('world')

  const worldChooser = createWorldChooser(root, {
    titleKey: 'incubator.load.title',
    subtitleKey: 'incubator.load.subtitle',
    // A browser world never holds a level: the levels are server jobs.
    openable: {
      load: async () => {
        const uids = await worldsWithLevel()
        return (where, uid) => where === 'server' && uids.has(uid)
      },
      reasonKey: 'incubator.load.noLevel',
    },
    // The archive is not read yet: nothing here uses the world's fields.
    // The list's name and seed are enough to say which world is open.
    onOpenArchive: (_archive, kept) => {
      titleBar.setWorld({ name: kept.name || undefined, seed: kept.seed })
      titleBar.setSaveState({ kind: kept.where === 'server' ? 'server' : 'local', at: new Date(kept.savedAt) })
      worldChooser.close()
      sidebar.setVisible(true)
    },
  })

  // The list first, the column behind it — as the generator opens.
  sidebar.setVisible(false)
  worldChooser.open()

  ctx.overlay.appendChild(root)

  const helpTooltip = createHelpTooltip(root)

  return {
    scene,
    dispose() {
      worldChooser.dispose()
      sidebar.dispose()
      titleBar.dispose()
      helpTooltip.dispose()
      serverIndicator.dispose()
      scene.dispose()
    },
  }
}
