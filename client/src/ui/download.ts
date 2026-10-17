// Hands a blob to the user as a file download. Shared by the generator's
// save fallback and the world chooser's download.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  // In the document while it is clicked, and the URL kept a while: a
  // browser may read it only after the click returns, and Safari dropped
  // the download when the URL was revoked at once (2026-10-11).
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
