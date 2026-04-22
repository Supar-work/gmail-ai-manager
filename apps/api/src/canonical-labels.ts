/**
 * Canonical label taxonomy. Every Gmail filter we translate gets placed into
 * one of these slots based on sample-email analysis. Labels with a <Placeholder>
 * token (Notifications/<Service>, Marketing/<Brand>, …) are resolved per-user
 * by filling the placeholder with a specific brand / vendor / source inferred
 * from the actual emails.
 */
export type CanonicalSlug =
  | 'family'
  | 'friends'
  | 'work'
  | 'action.unsubscribe'
  | 'action.followup'
  | 'notifications'
  | 'marketing'
  | 'subscriptions'
  | 'receipts'
  | 'shopping'
  | 'finance'
  | 'travel'
  | 'skip';

export type Disposition = 'inbox' | 'archive';

export type CanonicalLabel = {
  slug: CanonicalSlug;
  label: string;
  /** Default label path. Contains `<Placeholder>` when the leaf is per-user. */
  defaultLabelPath: string;
  /** Which placeholder token (if any) needs filling for this slot. */
  placeholder: string | null;
  /** Where messages matching this slot should end up by default. */
  disposition: Disposition;
};

// Every category supports up to two levels: the top-level bucket plus an
// optional sub-level inferred from samples (e.g. Family/Basis, Marketing/Nike).
// The placeholder is always filled if there's a single dominant sub-category;
// dropped otherwise.
export const CANONICAL_LABELS: CanonicalLabel[] = [
  {
    slug: 'family',
    label: 'Family',
    defaultLabelPath: 'Family/<Source>',
    placeholder: '<Source>',
    disposition: 'inbox',
  },
  {
    slug: 'friends',
    label: 'Friends',
    defaultLabelPath: 'Friends/<Person>',
    placeholder: '<Person>',
    disposition: 'inbox',
  },
  {
    slug: 'work',
    label: 'Work',
    defaultLabelPath: 'Work/<Company>',
    placeholder: '<Company>',
    disposition: 'inbox',
  },
  {
    slug: 'action.unsubscribe',
    label: 'Unsubscribe (Action)',
    defaultLabelPath: 'Action/Unsubscribe',
    placeholder: null,
    disposition: 'inbox',
  },
  {
    slug: 'action.followup',
    label: 'Follow-up (Action)',
    defaultLabelPath: 'Action/Follow-up',
    placeholder: null,
    disposition: 'inbox',
  },
  {
    slug: 'notifications',
    label: 'Notifications',
    defaultLabelPath: 'Notifications/<Service>',
    placeholder: '<Service>',
    disposition: 'archive',
  },
  {
    slug: 'marketing',
    label: 'Marketing',
    defaultLabelPath: 'Marketing/<Brand>',
    placeholder: '<Brand>',
    disposition: 'archive',
  },
  {
    slug: 'subscriptions',
    label: 'Subscriptions',
    defaultLabelPath: 'Subscriptions/<Source>',
    placeholder: '<Source>',
    disposition: 'archive',
  },
  {
    slug: 'receipts',
    label: 'Receipts',
    defaultLabelPath: 'Receipts/<Vendor>',
    placeholder: '<Vendor>',
    disposition: 'archive',
  },
  {
    slug: 'shopping',
    label: 'Shopping',
    defaultLabelPath: 'Shopping/<Retailer>',
    placeholder: '<Retailer>',
    disposition: 'archive',
  },
  {
    slug: 'finance',
    label: 'Finance',
    defaultLabelPath: 'Finance/<Institution>',
    placeholder: '<Institution>',
    disposition: 'archive',
  },
  {
    slug: 'travel',
    label: 'Travel',
    defaultLabelPath: 'Travel/<Destination>',
    placeholder: '<Destination>',
    disposition: 'archive',
  },
  {
    slug: 'skip',
    label: 'Skip — decide later',
    defaultLabelPath: '',
    placeholder: null,
    disposition: 'inbox',
  },
];

export function canonicalBySlug(slug: string): CanonicalLabel | undefined {
  return CANONICAL_LABELS.find((c) => c.slug === slug);
}
