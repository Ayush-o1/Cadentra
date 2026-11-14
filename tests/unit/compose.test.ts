import { describe, expect, it } from 'vitest';
import { composeEmail, type ComposeInput } from '../../src/email/compose.js';

const input: ComposeInput = {
  step: {
    subject: 'Hello {{first_name|there}}',
    body: 'Hi {{first_name|there}},\n\nCan we talk about {{company}}?\nThanks',
  },
  contact: {
    email: 'ada@example.org',
    firstName: 'Ada',
    lastName: 'Lovelace',
    company: 'Engines <Ltd>',
    consentBasis: 'event_attendee',
  },
  sender: {
    name: 'Priya at Northwind',
    email: 'priya@northwind.example',
    replyTo: 'help@northwind.example',
    postalAddress: '12 Harbour Road\nBristol BS1 4AA',
  },
  unsubscribeUrl: 'https://app.example.org/u/12.abc',
};

describe('composeEmail', () => {
  const { email, subject } = composeEmail(input);

  it('fills merge fields in the subject and body', () => {
    expect(subject).toBe('Hello Ada');
    expect(email.text).toContain('Hi Ada,');
    expect(email.text).toContain('Can we talk about Engines <Ltd>?');
  });

  it('addresses the message and sets reply-to', () => {
    expect(email.from).toBe('Priya at Northwind <priya@northwind.example>');
    expect(email.to).toBe('ada@example.org');
    expect(email.replyTo).toBe('help@northwind.example');
  });

  it('adds the one-click unsubscribe headers required by Gmail and Yahoo', () => {
    expect(email.headers['List-Unsubscribe']).toBe('<https://app.example.org/u/12.abc>');
    expect(email.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('ends with sender identity, postal address, the reason and the unsubscribe link', () => {
    expect(email.text).toContain('--\nPriya at Northwind\n12 Harbour Road, Bristol BS1 4AA');
    expect(email.text).toContain('because we met at an event you attended');
    expect(email.text.trimEnd().endsWith('Unsubscribe: https://app.example.org/u/12.abc')).toBe(
      true,
    );
    expect(email.html).toContain('href="https://app.example.org/u/12.abc"');
  });

  it('escapes HTML in the body so contact data cannot inject markup', () => {
    expect(email.html).toContain('Engines &lt;Ltd&gt;');
    expect(email.html).not.toContain('<Ltd>');
    expect(email.html).toContain('<p>Hi Ada,</p>');
    expect(email.html).toContain('Can we talk about Engines &lt;Ltd&gt;?<br />Thanks');
  });

  it('cannot be used to inject headers through the subject or the sender name', () => {
    const hostile = composeEmail({
      ...input,
      step: { subject: 'Hi\r\nBcc: evil@example.org', body: 'x' },
      sender: { ...input.sender, name: 'Evil"\r\nBcc: x <y>' },
    });
    expect(hostile.subject).not.toMatch(/[\r\n]/);
    expect(hostile.email.from).not.toMatch(/[\r\n"]/);
  });

  it('uses fallbacks for missing contact data', () => {
    const result = composeEmail({ ...input, contact: { ...input.contact, firstName: null } });
    expect(result.subject).toBe('Hello there');
  });
});
