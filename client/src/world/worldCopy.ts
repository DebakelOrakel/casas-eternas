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
// writes — two spaces for its keys. The rest of the file is not read, so a
// save of a newer build is copied as it is. THE ANNOTATIONS BLOCK is every
// line under `  annotations:` that is indented deeper than it, up to the next
// line that is not; its lines are kept as they are (keys may hold a "." and a
// "/", values their quotes), only the copied-from entry and the lines deeper
// than it are dropped, and the new copied-from entry is written last with
// the indent of the block's first entry (four spaces when there is none).
// The line end of `metadata:` is used for the lines of the block (CRLF
// stays CRLF). Until 2026-10-16 a key with a "." ended the block, and the
// lines after it were copied out of it (invalid YAML).
//
// The server's rewrite does the same (save.go, withCopyIdentity); both pass
// the cases of internal/modules/world/testdata/copy-identity.json.
const METADATA_KEY = /^ {2}([\w./-]+):/
const ANNOTATION_KEY = /^ *([\w./-]+):/

export function withCopyIdentity(yaml: string, uid: string, sourceUid: string): string | null {
  const lines = yaml.split('\n')
  const start = lines.findIndex((line) => line.replace(/\r$/, '') === 'metadata:')
  if (start < 0) return null
  const eol = lines[start].endsWith('\r') ? '\r' : ''
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '')
    if (line !== '' && !line.startsWith(' ')) {
      end = i
      break
    }
  }
  const block: string[] = []
  const annotations: string[] = []
  let uidSet = false
  let inAnnotations = false
  let entryIndent = -1
  let skipping = false
  for (const raw of lines.slice(start + 1, end)) {
    const line = raw.replace(/\r$/, '')
    if (line === '') continue
    const indent = line.length - line.replace(/^ +/, '').length
    if (inAnnotations && indent > 2) {
      if (entryIndent < 0) entryIndent = indent
      // An entry (or a line no deeper than one): it starts or ends a skip.
      if (indent <= entryIndent) skipping = line.match(ANNOTATION_KEY)?.[1] === COPIED_FROM_ANNOTATION
      if (!skipping) annotations.push(line)
      continue
    }
    inAnnotations = false
    const key = line.match(METADATA_KEY)?.[1]
    if (key === 'annotations') {
      inAnnotations = true
      continue
    }
    if (key === 'uid') {
      block.push(`  uid: ${uid}`)
      uidSet = true
      continue
    }
    block.push(line)
  }
  if (!uidSet) block.push(`  uid: ${uid}`)
  block.push('  annotations:', ...annotations, `${' '.repeat(entryIndent < 0 ? 4 : entryIndent)}${COPIED_FROM_ANNOTATION}: ${sourceUid}`)
  return [...lines.slice(0, start + 1), ...block.map((line) => line + eol), ...lines.slice(end)].join('\n')
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
