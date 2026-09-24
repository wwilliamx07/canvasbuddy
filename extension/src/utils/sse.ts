/**
 * Yields the `data:` payload of each server-sent event. The model providers and MCP servers both
 * stream this way; the caller decides what a payload means. Events are separated by a blank line
 * and may use CRLF.
 */
export async function* readSSE(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new Error('The server returned no response body to stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dataOf = (event: string): string =>
    event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const data = dataOf(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (data) yield data;
      }
    }
    buffer += decoder.decode();
    const tail = dataOf(buffer);
    if (tail) yield tail;
  } finally {
    // Leaving early (`[DONE]`, an error, the awaited reply) must close the connection, not just drop the lock
    reader.cancel().catch(() => {});
  }
}

export function parseSSEJson(data: string): any {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
