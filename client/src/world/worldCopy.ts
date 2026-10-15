import JSZip from 'jszip'

// A COPY OF A WORLD is a new world with the same content: a new uid, the same
// terrain, and a note in world.yaml of where it came from
// (docs/decisions/template-worlds.md). The terrain id (identity.deriveWorldId)
// does not move, since nothing it is made of changes.
//
// Two ways to make one, by where the copy is to rest. On the server the
// server makes it (POST /v1/worlds/{uid}/copy, server/worldClient.ts) and
// nothing travels. In this browser it is made from the fetched archive by
// copyArchive below, and kept under the new uid (the world list does both). The two write the same world.yaml — the rewrite below is the mirror
// of the server's (internal/modules/world/save.go, withCopyIdentity), and
// harness:roundtrip holds the two to one shape.

// The annotation that names the source world, by its uid. Kubernetes style,
// with the prefix the save's own apiVersion carries (casas-eternas/v1alpha1).
// The same key as the server's CopiedFromAnnotation. Documentation only:
// nothing ranks or keys by it.
export const COPIED_FROM_ANNOTATION = 'casas-eternas/copied-from'

// world.yaml with a copy's identity: `metadata.uid` replaced and the
// copied-from annotation set to the source (any other annotation kept, in its
// order). A copy of a copy names its direct source. Null when the file has no
// metadata block.
//
// A text edit of the metadata block, in the shape worldRecord.recordToYaml
// writes — two spaces for its keys, four for annotations. The rest of the file
// is not read, so a save of a newer build is copied as it is.
export function withCopyIdentity(yaml: string, uid: string, sourceUid: string): string | null {
  const lines = yaml.split('\n')
  const start = lines.findIndex((line) => line.replace(/\r$/, '') === 'metadata:')
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '')
    if (line !== '' && !line.startsWith(' ')) {
      end = i
      break
    }
  }
  const block: string[] = []
  const annotations: [string, string][] = []
  let uidSet = false
  let inAnnotations = false
  for (const raw of lines.slice(start + 1, end)) {
    const line = raw.replace(/\r$/, '')
    const match = line.match(/^(\s*)([\w/-]+):\s*(.*)$/)
    const indent = match ? match[1].length : -1
    if (match && indent === 4 && inAnnotations) {
      if (match[2] !== COPIED_FROM_ANNOTATION) annotations.push([match[2], match[3]])
      continue
    }
    inAnnotations = false
    if (match && indent === 2 && match[2] === 'annotations') {
      inAnnotations = true
      continue
    }
    if (match && indent === 2 && match[2] === 'uid') {
      block.push(`  uid: ${uid}`)
      uidSet = true
      continue
    }
    if (line === '') continue
    block.push(line)
  }
  if (!uidSet) block.push(`  uid: ${uid}`)
  annotations.push([COPIED_FROM_ANNOTATION, sourceUid])
  block.push('  annotations:', ...annotations.map(([key, value]) => `    ${key}: ${value}`))
  return [...lines.slice(0, start + 1), ...block, ...lines.slice(end)].join('\n')
}

// The archive under a copy's identity: world.yaml rewritten, every other
// entry as it was. Null when the archive is no world.
export async function copyArchive(archive: Blob, uid: string, sourceUid: string): Promise<Blob | null> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(await archive.arrayBuffer())
  } catch {
    return null
  }
  const yaml = await zip.file('world.yaml')?.async('string')
  const rewritten = yaml === undefined ? null : withCopyIdentity(yaml, uid, sourceUid)
  if (rewritten === null) return null
  zip.file('world.yaml', rewritten)
  // The compression worldArchive writes with.
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
}
