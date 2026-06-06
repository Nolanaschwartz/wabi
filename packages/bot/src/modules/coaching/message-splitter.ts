const MAX_MESSAGE_LENGTH = 2000;

export function splitMessage(text: string, maxLen = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf('\n', maxLen);
    if (splitIndex === -1) {
      splitIndex = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitIndex === -1 || splitIndex < maxLen * 0.5) {
      splitIndex = maxLen;
    }

    parts.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return parts;
}
