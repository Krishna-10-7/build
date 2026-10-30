export interface TicketCriterion {
  id: string;
  text: string;
}

export interface Ticket {
  key: string;
  title: string;
  status: string;
  description: string;
  criteria: TicketCriterion[];
  source: 'file' | 'jira' | 'api';
}

const AC_LINE = /^\s*(?:[-*]\s*)?(?:\*\*)?(AC-?\d+)(?:\*\*)?\s*[:.)-]\s*(.+)$/i;

/** Pulls numbered acceptance criteria ("AC-1: ...") out of free text; falls back to bullet order. */
export function extractCriteria(text: string): TicketCriterion[] {
  const lines = text.split(/\r?\n/);
  const out: TicketCriterion[] = [];
  for (const line of lines) {
    const m = AC_LINE.exec(line);
    if (m) out.push({ id: m[1].toUpperCase().replace(/^AC-?/, 'AC-'), text: m[2].trim() });
  }
  if (out.length) return out;
  // No AC ids: take bullets under an "Acceptance criteria" heading.
  const start = lines.findIndex((l) => /acceptance criteria/i.test(l));
  if (start < 0) return [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*#/.test(line) && out.length) break;
    const b = /^\s*[-*]\s+(.+)$/.exec(line);
    if (b) out.push({ id: `AC-${out.length + 1}`, text: b[1].trim() });
  }
  return out;
}

/** Ticket files: YAML-ish front matter (key, title, status) followed by markdown. */
export function parseTicketFile(raw: string): Ticket {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  const meta: Record<string, string> = {};
  let body = raw;
  if (fm) {
    body = fm[2];
    for (const line of fm[1].split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  if (!meta.key) throw new Error('ticket file needs a key in its front matter');
  return {
    key: meta.key,
    title: meta.title ?? meta.key,
    status: meta.status ?? 'To Do',
    description: body.trim(),
    criteria: extractCriteria(body),
    source: 'file',
  };
}
