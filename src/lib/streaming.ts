export async function simulateStreaming(
  text: string,
  onChunk: (chunk: string) => void,
  delayMs: number = 20,
): Promise<void> {
  if (!text) return;
  const words = text.split(' ');
  for (const word of words) {
    onChunk(word + ' ');
    await new Promise((r) => setTimeout(r, delayMs));
  }
}
