// Deterministic redaction: Jev decides whether PII exists; code finds and masks it.

export type RedactionMatch = { kind: string; match: string; start: number; end: number };

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const API_KEY = /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;

export function luhnValid(digits: string): boolean {
  const d = digits.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = parseInt(d[i], 10);
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function collect(text: string, re: RegExp, kind: string, validate?: (m: string) => boolean): RedactionMatch[] {
  const out: RedactionMatch[] = [];
  for (const m of text.matchAll(re)) {
    if (validate && !validate(m[0])) continue;
    out.push({ kind, match: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

export function findPii(text: string): RedactionMatch[] {
  if (!text) return [];
  const matches = [
    ...collect(text, API_KEY, 'api_key'),
    ...collect(text, SSN, 'ssn'),
    ...collect(text, EMAIL, 'email'),
    ...collect(text, CARD, 'card', luhnValid),
    ...collect(text, PHONE, 'phone'),
  ];
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const deduped: RedactionMatch[] = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.start >= lastEnd) {
      deduped.push(m);
      lastEnd = m.end;
    }
  }
  return deduped;
}

export function maskFor(kind: string): string {
  switch (kind) {
    case 'email': return '[REDACTED_EMAIL]';
    case 'phone': return '[REDACTED_PHONE]';
    case 'ssn': return '[REDACTED_SSN]';
    case 'card': return '[REDACTED_CARD]';
    case 'api_key': return '[REDACTED_API_KEY]';
    default: return '[REDACTED]';
  }
}

export function redact(text: string): { redacted: string; matches: RedactionMatch[] } {
  const matches = findPii(text);
  if (matches.length === 0) return { redacted: text, matches };
  let out = '';
  let cursor = 0;
  for (const m of matches) {
    out += text.slice(cursor, m.start) + maskFor(m.kind);
    cursor = m.end;
  }
  out += text.slice(cursor);
  return { redacted: out, matches };
}
