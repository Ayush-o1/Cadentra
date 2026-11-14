/**
 * Development seed: one demo workspace with contacts, lists, suppressions and campaigns in every
 * state, so every screen has real rows to show. Safe to run repeatedly. Never runs in production.
 *
 *   npm run db:seed
 *   Sign in as demo@cadentra.example / cadentra-demo-2026
 */
import { createDb } from '../src/lib/db.js';
import { hashPassword } from '../src/lib/crypto.js';
import type { MessageStatus } from '../src/generated/prisma/client.js';

if (process.env['NODE_ENV'] === 'production') {
  console.error('Refusing to seed a production database.');
  process.exit(1);
}

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const DEMO_EMAIL = 'demo@cadentra.example';
const DEMO_PASSWORD = 'cadentra-demo-2026';
const DAY = 86_400_000;

// Deterministic randomness, so the demo data looks the same every time.
let seed = 20261114;
function random(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;

const FIRST = [
  'Amara',
  'Ben',
  'Chloe',
  'Dev',
  'Elena',
  'Farid',
  'Grace',
  'Hiro',
  'Imani',
  'Jonas',
  'Kavya',
  'Liam',
  'Mira',
  'Noah',
  'Olu',
  'Priya',
  'Quinn',
  'Rosa',
  'Sam',
  'Tara',
  'Uma',
  'Viktor',
  'Wen',
  'Xavier',
  'Yara',
  'Zane',
];
const LAST = [
  'Adeyemi',
  'Bianchi',
  'Chen',
  'Dubois',
  'Eriksen',
  'Fofana',
  'Garcia',
  'Haddad',
  'Ito',
  'Jensen',
  'Khan',
  'Lopez',
  'Mbeki',
  'Novak',
  'Okafor',
  'Patel',
  'Quispe',
  'Rossi',
  'Silva',
  'Tanaka',
  'Usman',
  'Varga',
  'Walsh',
  'Yilmaz',
];
const COMPANIES = [
  'Harbour Freight',
  'Lumen Labs',
  'Fernhill Foods',
  'Oakridge Dental',
  'Brightwater Co',
  'Kestrel Analytics',
  'Marlow & Finch',
  'Tidewell Studio',
  'Northgate Logistics',
  'Copperleaf Cafe',
  'Alder Robotics',
  'Sunnyside Schools',
];
const BASES = ['requested_contact', 'event_attendee', 'signed_up', 'existing_customer'] as const;

const db = createDb(databaseUrl);

async function main() {
  const existing = await db.user.findUnique({
    where: { email: DEMO_EMAIL },
    include: { memberships: true },
  });
  if (existing) {
    for (const m of existing.memberships)
      await db.workspace.delete({ where: { id: m.workspaceId } });
    await db.user.delete({ where: { id: existing.id } });
  }

  const user = await db.user.create({
    data: {
      email: DEMO_EMAIL,
      name: 'Priya Raman',
      passwordHash: await hashPassword(DEMO_PASSWORD),
    },
  });
  const workspace = await db.workspace.create({
    data: {
      name: 'Northwind Trading',
      timezone: 'Europe/London',
      senderName: 'Priya at Northwind',
      senderEmail: 'priya@northwind.example',
      replyToEmail: 'hello@northwind.example',
      postalAddress: '12 Harbour Road, Bristol BS1 4AA, United Kingdom',
      dailySendLimit: 500,
    },
  });
  await db.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: user.id, role: 'owner' },
  });
  const workspaceId = workspace.id;

  const lists = {
    expo: await db.contactList.create({ data: { workspaceId, name: 'Spring expo 2026 leads' } }),
    waitlist: await db.contactList.create({ data: { workspaceId, name: 'Product waitlist' } }),
    customers: await db.contactList.create({ data: { workspaceId, name: 'New customers' } }),
    webinar: await db.contactList.create({ data: { workspaceId, name: 'Webinar attendees' } }),
  };

  // Contacts
  const seen = new Set<string>();
  const contacts: { id: number; email: string }[] = [];
  const memberships: { listId: number; contactId: number }[] = [];
  const listFor = [
    lists.expo,
    lists.expo,
    lists.expo,
    lists.waitlist,
    lists.waitlist,
    lists.customers,
    lists.webinar,
  ];
  for (let i = 0; i < 170; i++) {
    const first = pick(FIRST);
    const last = pick(LAST);
    const company = pick(COMPANIES);
    const email =
      `${first}.${last}${i % 7 === 0 ? i : ''}@${company.toLowerCase().replace(/[^a-z]/g, '')}.example`.toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    const basis = pick([...BASES]);
    const list = pick(listFor);
    const contact = await db.contact.create({
      data: {
        workspaceId,
        email,
        firstName: random() < 0.93 ? first : null,
        lastName: last,
        company: random() < 0.85 ? company : null,
        consentBasis: basis,
        consentSource: {
          requested_contact: 'Demo request form',
          event_attendee: 'Spring expo sign-up sheet',
          signed_up: 'Waitlist page',
          existing_customer: 'Customer onboarding',
        }[basis],
        consentedAt: new Date(Date.now() - Math.floor(random() * 90) * DAY),
      },
    });
    contacts.push({ id: contact.id, email });
    memberships.push({ listId: list.id, contactId: contact.id });
    if (random() < 0.18)
      memberships.push({ listId: pick(Object.values(lists)).id, contactId: contact.id });
  }
  const uniqueMembers = new Map(memberships.map((m) => [`${m.listId}:${m.contactId}`, m]));
  await db.contactListMember.createMany({
    data: [...uniqueMembers.values()].map((m) => ({ workspaceId, ...m })),
    skipDuplicates: true,
  });

  // Suppressions: some for existing contacts, one with no contact record.
  const suppressed = contacts.slice(0, 11);
  const reasons = [
    'unsubscribed',
    'unsubscribed',
    'unsubscribed',
    'unsubscribed',
    'unsubscribed',
    'hard_bounce',
    'hard_bounce',
    'hard_bounce',
    'complaint',
    'manual',
    'manual',
  ] as const;
  await db.suppression.createMany({
    data: suppressed.map((c, i) => ({
      workspaceId,
      email: c.email,
      reason: reasons[i]!,
      createdAt: new Date(Date.now() - (i + 1) * 2 * DAY),
    })),
  });
  await db.suppression.create({
    data: { workspaceId, email: 'press@competitor.example', reason: 'manual' },
  });
  const suppressedEmails = new Set(suppressed.map((c) => c.email));

  const eligible = (listId: number) =>
    [...uniqueMembers.values()]
      .filter((m) => m.listId === listId)
      .map((m) => contacts.find((c) => c.id === m.contactId)!)
      .filter((c) => !suppressedEmails.has(c.email));

  const steps = [
    {
      subject: 'Great to meet you, {{first_name|there}}',
      body: 'Hi {{first_name|there}},\n\nThanks for stopping by our stand. As promised, here is the one-page overview of how Northwind can help {{company|your team}}.\n\nIf a quick call would help, just reply to this email.\n\nPriya',
      delayDays: 0,
    },
    {
      subject: 'A short follow-up',
      body: 'Hi {{first_name|there}},\n\nJust checking the overview reached you. Happy to answer anything about pricing or onboarding.\n\nPriya',
      delayDays: 3,
    },
    {
      subject: 'Should I close the loop?',
      body: 'Hi {{first_name|there}},\n\nI will stop here unless this is useful. Reply any time if you would like to talk.\n\nPriya',
      delayDays: 5,
    },
  ];

  async function campaign(
    name: string,
    status: 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'cancelled',
    listId: number | null,
    stepCount: number,
    extra: { startAt?: Date; pauseReason?: string; launchedDaysAgo?: number } = {},
  ) {
    const launchedAt =
      extra.launchedDaysAgo !== undefined
        ? new Date(Date.now() - extra.launchedDaysAgo * DAY)
        : null;
    const created = await db.campaign.create({
      data: {
        workspaceId,
        name,
        status,
        listId,
        startAt: extra.startAt ?? null,
        pauseReason: extra.pauseReason ?? null,
        launchedAt,
        completedAt: status === 'completed' ? new Date(Date.now() - 2 * DAY) : null,
        createdById: user.id,
        createdAt: new Date(Date.now() - ((extra.launchedDaysAgo ?? 0) + 1) * DAY),
      },
    });
    const stepRows = [];
    for (let i = 0; i < stepCount; i++) {
      stepRows.push(
        await db.campaignStep.create({
          data: {
            campaignId: created.id,
            position: i + 1,
            delayDays: steps[i]!.delayDays,
            subject: steps[i]!.subject,
            body: steps[i]!.body,
          },
        }),
      );
    }
    return { campaign: created, stepRows };
  }

  async function enrol(
    campaignId: number,
    stepRows: { id: number }[],
    people: { id: number; email: string }[],
    plan: (
      index: number,
      step: number,
    ) => { status: MessageStatus; daysAgo?: number; daysAhead?: number } | null,
  ) {
    for (const [index, person] of people.entries()) {
      const recipient = await db.campaignRecipient.create({
        data: { workspaceId, campaignId, contactId: person.id, status: 'active' },
      });
      const rows = [];
      for (const [stepIndex, step] of stepRows.entries()) {
        const outcome = plan(index, stepIndex);
        if (!outcome) break;
        const when =
          outcome.daysAgo !== undefined
            ? new Date(Date.now() - outcome.daysAgo * DAY - Math.floor(random() * 6) * 3_600_000)
            : new Date(Date.now() + (outcome.daysAhead ?? 1) * DAY);
        const accepted = ['accepted', 'delivered', 'bounced', 'complained'].includes(
          outcome.status,
        );
        rows.push({
          workspaceId,
          campaignId,
          recipientId: recipient.id,
          stepId: step.id,
          toEmail: person.email,
          status: outcome.status,
          runAt: when,
          attempts: accepted || outcome.status === 'failed' ? 1 : 0,
          provider: accepted ? 'fake' : null,
          providerMessageId: accepted ? `seed_${campaignId}_${recipient.id}_${step.id}` : null,
          acceptedAt: accepted ? when : null,
          deliveredAt:
            outcome.status === 'delivered' || outcome.status === 'complained'
              ? new Date(when.getTime() + 4000)
              : null,
          failedAt:
            outcome.status === 'bounced' ||
            outcome.status === 'complained' ||
            outcome.status === 'failed'
              ? new Date(when.getTime() + 9000)
              : null,
          lastError:
            outcome.status === 'bounced'
              ? 'Bounced: the address does not accept mail'
              : outcome.status === 'failed'
                ? 'Resend responded 422: Invalid `to` field'
                : null,
          subjectSent: accepted
            ? steps[stepIndex]!.subject.replace('{{first_name|there}}', 'there')
            : null,
        });
      }
      await db.emailMessage.createMany({ data: rows });
      const finished =
        rows.length === stepRows.length &&
        rows.every((r) =>
          ['delivered', 'bounced', 'complained', 'accepted', 'failed'].includes(r.status),
        );
      const stopReason = rows.some((r) => r.status === 'bounced')
        ? 'hard_bounce'
        : rows.some((r) => r.status === 'complained')
          ? 'complaint'
          : rows.some((r) => r.status === 'failed')
            ? 'failed'
            : null;
      await db.campaignRecipient.update({
        where: { id: recipient.id },
        data: stopReason
          ? { status: 'stopped', stopReason }
          : { status: finished ? 'completed' : 'active' },
      });
    }
  }

  // 1. Running: step one done, step two waiting.
  const expo = await campaign('Spring expo follow-up', 'running', lists.expo.id, 3, {
    launchedDaysAgo: 6,
  });
  await enrol(expo.campaign.id, expo.stepRows, eligible(lists.expo.id), (i, s) => {
    if (s === 0)
      return {
        status:
          i % 53 === 0
            ? 'bounced'
            : i % 41 === 0
              ? 'complained'
              : i % 9 === 0
                ? 'accepted'
                : 'delivered',
        daysAgo: 5 - (i % 4),
      };
    if (s === 1 && i % 53 !== 0 && i % 41 !== 0)
      return {
        status: i % 5 === 0 ? 'scheduled' : i % 2 === 0 ? 'delivered' : 'accepted',
        ...(i % 5 === 0 ? { daysAhead: 1 + (i % 3) } : { daysAgo: 1 }),
      };
    return null;
  });

  // 2. Completed: three-step sequence, finished.
  const waitlist = await campaign('Waitlist launch sequence', 'completed', lists.waitlist.id, 3, {
    launchedDaysAgo: 24,
  });
  await enrol(waitlist.campaign.id, waitlist.stepRows, eligible(lists.waitlist.id), (i, s) => ({
    status: i % 31 === 0 ? 'bounced' : i % 4 === 0 && s === 2 ? 'accepted' : 'delivered',
    daysAgo: 22 - s * 4 - (i % 3),
  }));

  // 3. Paused automatically after bounces.
  const onboarding = await campaign('Customer onboarding series', 'paused', lists.customers.id, 2, {
    launchedDaysAgo: 3,
    pauseReason: 'Auto-paused: bounce rate 7.7% reached the 3% limit',
  });
  await enrol(onboarding.campaign.id, onboarding.stepRows, eligible(lists.customers.id), (i, s) =>
    s === 0
      ? { status: i % 13 === 0 ? 'bounced' : 'delivered', daysAgo: 2 }
      : { status: 'scheduled', daysAhead: 1 },
  );

  // 4. Scheduled for later.
  const webinar = await campaign(
    'Webinar thank-you and recording',
    'scheduled',
    lists.webinar.id,
    2,
    { launchedDaysAgo: 1, startAt: new Date(Date.now() + 3 * DAY) },
  );
  await enrol(webinar.campaign.id, webinar.stepRows, eligible(lists.webinar.id), (_i, s) =>
    s === 0 ? { status: 'scheduled', daysAhead: 3 } : null,
  );

  // 5. Draft and 6. cancelled.
  await campaign('Q4 product update', 'draft', lists.waitlist.id, 2);
  const cancelled = await campaign('Re-engagement test', 'cancelled', lists.expo.id, 2, {
    launchedDaysAgo: 12,
  });
  await enrol(
    cancelled.campaign.id,
    cancelled.stepRows,
    eligible(lists.expo.id).slice(0, 12),
    (_i, s) =>
      s === 0 ? { status: 'delivered', daysAgo: 11 } : { status: 'cancelled', daysAhead: 1 },
  );

  await db.activityLog.createMany({
    data: [
      {
        workspaceId,
        userId: user.id,
        action: 'contacts.imported',
        metadata: { created: 120, duplicates: 4, invalid: 2 },
        createdAt: new Date(Date.now() - 9 * DAY),
      },
      {
        workspaceId,
        userId: user.id,
        action: 'campaign.launched',
        entityType: 'campaign',
        entityId: expo.campaign.id,
        metadata: { recipients: eligible(lists.expo.id).length },
        createdAt: new Date(Date.now() - 6 * DAY),
      },
      {
        workspaceId,
        userId: user.id,
        action: 'campaign.created',
        entityType: 'campaign',
        metadata: { name: 'Q4 product update' },
        createdAt: new Date(Date.now() - 1 * DAY),
      },
      {
        workspaceId,
        userId: user.id,
        action: 'campaign.paused',
        entityType: 'campaign',
        entityId: onboarding.campaign.id,
        createdAt: new Date(Date.now() - 2 * DAY),
      },
      {
        workspaceId,
        action: 'contact.unsubscribed',
        metadata: { email: suppressed[0]!.email },
        createdAt: new Date(Date.now() - 3 * 3_600_000),
      },
    ],
  });

  const counts = {
    contacts: await db.contact.count({ where: { workspaceId } }),
    messages: await db.emailMessage.count({ where: { workspaceId } }),
    campaigns: 6,
  };
  console.log(
    `Seeded ${counts.contacts} contacts, ${counts.campaigns} campaigns and ${counts.messages} messages.`,
  );
  console.log(`Sign in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
