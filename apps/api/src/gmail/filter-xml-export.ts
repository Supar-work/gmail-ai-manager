import type { GmailFilter } from './filters.js';

/**
 * Render a set of Gmail filters as the Atom XML Gmail emits from
 * Settings → Filters → Export. The file is importable back into Gmail via
 * Settings → Filters → Import filters, so users can restore a backup if
 * they later decide to undo the AI-rules migration.
 */
export function buildGmailFilterXml(
  filters: GmailFilter[],
  labelMap: Record<string, string>,
): string {
  const now = new Date().toISOString();
  const entries = filters.map((f) => renderEntry(f, labelMap, now)).join('\n');
  return [
    `<?xml version='1.0' encoding='UTF-8'?>`,
    `<feed xmlns='http://www.w3.org/2005/Atom' xmlns:apps='http://schemas.google.com/apps/2006'>`,
    `  <title>Mail Filters</title>`,
    `  <updated>${now}</updated>`,
    `  <author>`,
    `    <name>Gmail AI Filters backup</name>`,
    `  </author>`,
    entries,
    `</feed>`,
  ].join('\n');
}

function renderEntry(f: GmailFilter, labelMap: Record<string, string>, now: string): string {
  const props: Array<[string, string]> = [];
  const c = f.criteria ?? {};
  if (c.from) props.push(['from', c.from]);
  if (c.to) props.push(['to', c.to]);
  if (c.subject) props.push(['subject', c.subject]);
  if (c.query) props.push(['hasTheWord', c.query]);
  if (c.negatedQuery) props.push(['doesNotHaveTheWord', c.negatedQuery]);
  if (c.hasAttachment) props.push(['hasAttachment', 'true']);
  if (c.excludeChats) props.push(['excludeChats', 'true']);
  if (c.size != null) {
    props.push(['size', String(c.size)]);
    if (c.sizeComparison === 'larger') props.push(['sizeOperator', 's_sl']);
    else if (c.sizeComparison === 'smaller') props.push(['sizeOperator', 's_ss']);
  }

  const a = f.action ?? {};
  for (const id of a.addLabelIds ?? []) {
    if (id === 'TRASH') props.push(['shouldTrash', 'true']);
    else if (id === 'SPAM') props.push(['shouldSpam', 'true']);
    else if (id === 'STARRED') props.push(['shouldStar', 'true']);
    else if (id === 'IMPORTANT') props.push(['shouldAlwaysMarkAsImportant', 'true']);
    else props.push(['label', labelMap[id] ?? id]);
  }
  for (const id of a.removeLabelIds ?? []) {
    if (id === 'INBOX') props.push(['shouldArchive', 'true']);
    else if (id === 'UNREAD') props.push(['shouldMarkAsRead', 'true']);
    else if (id === 'IMPORTANT') props.push(['shouldNeverMarkAsImportant', 'true']);
    // Custom-label removal has no direct equivalent in Gmail's XML schema.
  }
  if (a.forward) props.push(['forwardTo', a.forward]);
  // Gmail always emits these in exports; present for round-trip compatibility.
  props.push(['sizeOperator', 's_sl']);
  props.push(['sizeUnit', 's_smb']);

  const propsXml = props
    .map(([k, v]) => `    <apps:property name='${esc(k)}' value='${esc(v)}'/>`)
    .join('\n');
  const id = f.id ?? 'unknown';
  return [
    `  <entry>`,
    `    <category term='filter'></category>`,
    `    <title>Mail Filter</title>`,
    `    <id>tag:mail.google.com,2008:filter:${esc(id)}</id>`,
    `    <updated>${now}</updated>`,
    `    <content></content>`,
    propsXml,
    `  </entry>`,
  ].join('\n');
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
    .replace(/"/g, '&quot;');
}
