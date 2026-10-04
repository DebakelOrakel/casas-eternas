// What a server's refusal says: its `{"error": …}` (httpjson.ClientError),
// else its plain text (http.Error), else the status. In the server's words,
// which are English; the window that shows it says what was refused.
export async function refusalText(response: Response): Promise<string> {
  const text = (await response.text().catch(() => '')).trim()
  try {
    const body = JSON.parse(text) as { error?: unknown }
    if (typeof body.error === 'string' && body.error) return body.error
  } catch {
    // Not JSON: the text itself.
  }
  return text || String(response.status)
}
