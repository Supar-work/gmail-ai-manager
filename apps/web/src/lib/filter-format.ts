export type Criteria = {
  from?: string | null;
  to?: string | null;
  subject?: string | null;
  query?: string | null;
  negatedQuery?: string | null;
  hasAttachment?: boolean | null;
  excludeChats?: boolean | null;
  size?: number | null;
  sizeComparison?: string | null;
};

export type Action = {
  addLabelIds?: string[] | null;
  removeLabelIds?: string[] | null;
  forward?: string | null;
};

export const SYSTEM_LABEL_LOOKUP: Record<string, string> = {
  INBOX: 'Inbox',
  SPAM: 'Spam',
  TRASH: 'Trash',
  UNREAD: 'Unread',
  STARRED: 'Starred',
  IMPORTANT: 'Important',
  SENT: 'Sent',
  DRAFT: 'Draft',
  CATEGORY_PERSONAL: 'Category: Personal',
  CATEGORY_SOCIAL: 'Category: Social',
  CATEGORY_PROMOTIONS: 'Category: Promotions',
  CATEGORY_UPDATES: 'Category: Updates',
  CATEGORY_FORUMS: 'Category: Forums',
};

export function labelName(id: string, labelMap: Record<string, string>): string {
  return SYSTEM_LABEL_LOOKUP[id] ?? labelMap[id] ?? id;
}

export function criteriaChips(criteria: Criteria | undefined): Array<{ key: string; label: string }> {
  if (!criteria) return [];
  const chips: Array<{ key: string; label: string }> = [];
  if (criteria.from) chips.push({ key: 'from', label: `from: ${criteria.from}` });
  if (criteria.to) chips.push({ key: 'to', label: `to: ${criteria.to}` });
  if (criteria.subject) chips.push({ key: 'subject', label: `subject: ${criteria.subject}` });
  if (criteria.query) chips.push({ key: 'query', label: `query: ${criteria.query}` });
  if (criteria.negatedQuery)
    chips.push({ key: 'negatedQuery', label: `not: ${criteria.negatedQuery}` });
  if (criteria.hasAttachment) chips.push({ key: 'hasAttachment', label: 'has attachment' });
  if (criteria.excludeChats) chips.push({ key: 'excludeChats', label: 'excludes chats' });
  if (criteria.size != null) {
    const op = criteria.sizeComparison === 'larger' ? '>' : criteria.sizeComparison === 'smaller' ? '<' : '=';
    chips.push({ key: 'size', label: `size ${op} ${criteria.size}` });
  }
  return chips;
}

export function actionChips(
  action: Action | undefined,
  labelMap: Record<string, string>,
): Array<{ key: string; label: string; kind: 'add' | 'remove' | 'forward' }> {
  if (!action) return [];
  const chips: Array<{ key: string; label: string; kind: 'add' | 'remove' | 'forward' }> = [];
  for (const id of action.addLabelIds ?? []) {
    const name = labelName(id, labelMap);
    if (id === 'TRASH') chips.push({ key: `add-${id}`, label: 'Trash', kind: 'remove' });
    else if (id === 'SPAM') chips.push({ key: `add-${id}`, label: 'Spam', kind: 'remove' });
    else chips.push({ key: `add-${id}`, label: `+ ${name}`, kind: 'add' });
  }
  for (const id of action.removeLabelIds ?? []) {
    if (id === 'INBOX') chips.push({ key: `rm-${id}`, label: 'Archive', kind: 'remove' });
    else if (id === 'UNREAD') chips.push({ key: `rm-${id}`, label: 'Mark read', kind: 'remove' });
    else chips.push({ key: `rm-${id}`, label: `− ${labelName(id, labelMap)}`, kind: 'remove' });
  }
  if (action.forward) chips.push({ key: 'forward', label: `Forward → ${action.forward}`, kind: 'forward' });
  return chips;
}
