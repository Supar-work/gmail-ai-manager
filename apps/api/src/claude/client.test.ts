import { describe, expect, it } from 'vitest';
import { _internal } from './client.js';

const { extractJson } = _internal;

describe('extractJson', () => {
  it('parses a plain JSON object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON fenced in markdown code blocks', () => {
    const text = '```json\n{"matches":[{"ruleId":"r1"}]}\n```';
    expect(extractJson(text)).toEqual({ matches: [{ ruleId: 'r1' }] });
  });

  it('parses JSON in an unlabelled fence', () => {
    expect(extractJson('```\n[1,2,3]\n```')).toEqual([1, 2, 3]);
  });

  it('extracts a balanced object embedded in prose', () => {
    const text = 'Here is the answer: {"result":"ok","count":5} hope this helps';
    expect(extractJson(text)).toEqual({ result: 'ok', count: 5 });
  });

  it('handles strings containing braces', () => {
    const text = 'noise {"msg":"hello {world}","n":1} tail';
    expect(extractJson(text)).toEqual({ msg: 'hello {world}', n: 1 });
  });

  it('returns null when nothing parses', () => {
    expect(extractJson('no json here')).toBeNull();
  });

  it('handles escaped quotes inside strings', () => {
    expect(extractJson('{"q":"she said \\"hi\\""}')).toEqual({ q: 'she said "hi"' });
  });

  it('extracts first of two top-level objects', () => {
    expect(extractJson('{"a":1}\n{"b":2}')).toEqual({ a: 1 });
  });
});
