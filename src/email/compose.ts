import { renderTemplate, singleLine } from './template.js';
import type { OutboundEmail } from './provider.js';

type ConsentBasis =
  'requested_contact' | 'existing_customer' | 'signed_up' | 'event_attendee' | 'other_documented';

export type ComposeInput = {
  step: { subject: string; body: string };
  contact: {
    email: string;
    firstName: string | null;
    lastName: string | null;
    company: string | null;
    consentBasis: ConsentBasis;
  };
  sender: {
    name: string;
    email: string;
    replyTo: string | null;
    postalAddress: string;
  };
  unsubscribeUrl: string;
};

const WHY_YOU_ARE_HEARING_FROM_US: Record<ConsentBasis, string> = {
  requested_contact: 'You are receiving this because you asked us to get in touch.',
  existing_customer: 'You are receiving this because you are a customer of ours.',
  signed_up: 'You are receiving this because you signed up with us.',
  event_attendee: 'You are receiving this because we met at an event you attended.',
  other_documented: 'You are receiving this because of an existing relationship with us.',
};

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function displayName(name: string): string {
  return singleLine(name).replace(/["<>\\]/g, '');
}

function bodyToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph.trim()).replace(/\n/g, '<br />')}</p>`)
    .join('\n');
}

/** Builds the exact message sent to the provider, including the compliance footer. */
export function composeEmail({ step, contact, sender, unsubscribeUrl }: ComposeInput): {
  email: OutboundEmail;
  subject: string;
} {
  const values = {
    first_name: contact.firstName,
    last_name: contact.lastName,
    company: contact.company,
    email: contact.email,
  };
  const subject = singleLine(renderTemplate(step.subject, values));
  const body = renderTemplate(step.body, values).replace(/\r\n/g, '\n').trim();
  const reason = WHY_YOU_ARE_HEARING_FROM_US[contact.consentBasis];
  const senderName = displayName(sender.name);
  const address = sender.postalAddress.replace(/\s*\n\s*/g, ', ');

  const text = [body, '', '--', senderName, address, reason, `Unsubscribe: ${unsubscribeUrl}`].join(
    '\n',
  );

  const html = [
    bodyToHtml(body),
    '<hr />',
    `<p style="color:#555;font-size:12px;line-height:1.5">${escapeHtml(senderName)}<br />${escapeHtml(address)}<br />${escapeHtml(reason)}<br /><a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe</a></p>`,
  ].join('\n');

  return {
    subject,
    email: {
      from: `${senderName} <${sender.email}>`,
      to: contact.email,
      replyTo: sender.replyTo ?? undefined,
      subject,
      text,
      html,
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    },
  };
}
