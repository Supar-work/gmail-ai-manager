import { describe, expect, it } from 'vitest';
import { buildGmailFilterXml } from './filter-xml-export.js';

describe('buildGmailFilterXml', () => {
  it('renders a single filter with from + label', () => {
    const xml = buildGmailFilterXml(
      [
        {
          id: 'abc',
          criteria: { from: 'noreply-travel@google.com' },
          action: { addLabelIds: ['Label_1'] },
        },
      ],
      { Label_1: 'google flights' },
    );
    expect(xml).toContain("<apps:property name='from' value='noreply-travel@google.com'/>");
    expect(xml).toContain("<apps:property name='label' value='google flights'/>");
    expect(xml).toContain("tag:mail.google.com,2008:filter:abc");
  });

  it('maps system labels to their shouldX properties', () => {
    const xml = buildGmailFilterXml(
      [
        {
          id: 'x',
          criteria: { subject: 'receipt' },
          action: {
            addLabelIds: ['STARRED', 'IMPORTANT'],
            removeLabelIds: ['INBOX', 'UNREAD'],
          },
        },
      ],
      {},
    );
    expect(xml).toContain("shouldStar' value='true'");
    expect(xml).toContain("shouldAlwaysMarkAsImportant' value='true'");
    expect(xml).toContain("shouldArchive' value='true'");
    expect(xml).toContain("shouldMarkAsRead' value='true'");
  });

  it('escapes special XML characters in criteria', () => {
    const xml = buildGmailFilterXml(
      [{ id: '1', criteria: { subject: "hello & 'world'" } }],
      {},
    );
    expect(xml).toContain("value='hello &amp; &apos;world&apos;'");
  });

  it('is a valid round-trip with the Export schema (starts with Atom feed)', () => {
    const xml = buildGmailFilterXml([{ id: '1', criteria: { from: 'a@b' } }], {});
    expect(xml.startsWith("<?xml version='1.0' encoding='UTF-8'?>")).toBe(true);
    expect(xml).toContain("<feed xmlns='http://www.w3.org/2005/Atom'");
    expect(xml).toContain('xmlns:apps=');
  });
});
