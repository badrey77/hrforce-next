/**
 * Parses JSON and records the 1-based line of every leaf/object key path ("a.b.c").
 * Uses JSON.parse for validation/values; a light scanner only for positions.
 */
export interface JsonWithLines {
  value: unknown;
  lines: Map<string, number>;
}

export function parseJsonWithLines(text: string): JsonWithLines {
  const value: unknown = JSON.parse(text);
  const lines = new Map<string, number>();
  let i = 0;
  let line = 1;

  const skipWs = () => {
    while (i < text.length) {
      const c = text[i];
      if (c === '\n') line++;
      else if (c !== ' ' && c !== '\t' && c !== '\r') break;
      i++;
    }
  };
  const readString = (): string => {
    const start = i;
    i++; // opening quote
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++; // closing quote
    return JSON.parse(text.slice(start, i)) as string;
  };
  const readValue = (pathPrefix: string): void => {
    skipWs();
    const c = text[i];
    if (c === '{') {
      i++;
      skipWs();
      if (text[i] === '}') {
        i++;
        return;
      }
      for (;;) {
        skipWs();
        const keyLine = line;
        const key = readString();
        const keyPath = pathPrefix ? `${pathPrefix}.${key}` : key;
        lines.set(keyPath, keyLine);
        skipWs();
        i++; // colon
        readValue(keyPath);
        skipWs();
        if (text[i] === ',') {
          i++;
          continue;
        }
        i++; // closing brace
        return;
      }
    }
    if (c === '[') {
      i++;
      let index = 0;
      skipWs();
      if (text[i] === ']') {
        i++;
        return;
      }
      for (;;) {
        readValue(`${pathPrefix}[${index++}]`);
        skipWs();
        if (text[i] === ',') {
          i++;
          continue;
        }
        i++;
        return;
      }
    }
    if (c === '"') {
      readString();
      return;
    }
    while (i < text.length && !/[,}\]\s]/.test(text[i] ?? '')) i++;
  };
  readValue('');
  return { value, lines };
}
