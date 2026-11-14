import { describe, expect, it } from 'vitest';
import { findInvalidTokens, renderTemplate, singleLine } from '../../src/email/template.js';

describe('renderTemplate', () => {
  it('fills known fields', () => {
    expect(
      renderTemplate('Hi {{first_name}} at {{ company }}', {
        first_name: 'Ada',
        company: 'Engines',
      }),
    ).toBe('Hi Ada at Engines');
  });

  it('uses the fallback when a value is missing or blank', () => {
    expect(renderTemplate('Hi {{first_name|there}},', { first_name: null })).toBe('Hi there,');
    expect(renderTemplate('Hi {{first_name|there}},', { first_name: '   ' })).toBe('Hi there,');
    expect(renderTemplate('Hi {{first_name}},', {})).toBe('Hi ,');
  });

  it('does not interpret anything beyond plain substitution', () => {
    expect(renderTemplate('{{first_name}}', { first_name: '{{company}}', company: 'X' })).toBe(
      '{{company}}',
    );
    expect(renderTemplate('{{constructor}} {{ __proto__ }}', {})).toBe(
      '{{constructor}} {{ __proto__ }}',
    );
  });
});

describe('findInvalidTokens', () => {
  it('accepts supported fields with or without fallbacks', () => {
    expect(
      findInvalidTokens('{{first_name}} {{ last_name | there }} {{company|your team}}'),
    ).toEqual([]);
  });

  it('reports unsupported or malformed tokens once each', () => {
    expect(findInvalidTokens('{{firstname}} {{first-name}} {{firstname}} {{}}')).toEqual([
      '{{firstname}}',
      '{{first-name}}',
      '{{}}',
    ]);
  });
});

describe('singleLine', () => {
  it('removes line breaks so a value cannot inject headers', () => {
    expect(singleLine('Hello\r\nBcc: x@example.org')).toBe('Hello Bcc: x@example.org');
  });
});
