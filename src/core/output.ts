/** Compare MIME essences and explicit codec sets without inventing absent evidence. */
function parse(value: string): { essence: string; codecs: string[] | null } {
  const parts = value.split(';');
  const essence = (parts.shift() ?? '').trim().toLowerCase();
  let codecs: string[] | null = null;
  for (const parameter of parts) {
    const match = /^\s*codecs\s*=\s*(.*?)\s*$/i.exec(parameter);
    if (match) {
      let content = match[1] ?? '';
      if (content.startsWith('"') && content.endsWith('"')) content = content.slice(1, -1);
      codecs = [...new Set(content.split(',').map(codec => codec.trim()).filter(Boolean))].sort();
    }
  }
  return { essence, codecs };
}

export function compatibleMime(a: string, b: string): boolean {
  if (!a || !b) return true;
  const left = parse(a);
  const right = parse(b);
  return left.essence === right.essence && (left.codecs === null || right.codecs === null ||
    (left.codecs.length === right.codecs.length && left.codecs.every((codec, index) => codec === right.codecs?.[index])));
}

export function informativeMime(previous: string, incoming: string): string {
  if (!previous) return incoming;
  return parse(previous).codecs === null && parse(incoming).codecs !== null ? incoming : previous;
}
