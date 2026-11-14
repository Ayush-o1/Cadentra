import type { Db } from '../src/lib/db.js';

let counter = 0;
const next = () => ++counter;

export async function createWorkspace(db: Db, name = `Workspace ${next()}`) {
  return db.workspace.create({ data: { name } });
}

export async function createContact(
  db: Db,
  workspaceId: number,
  overrides: { email?: string; firstName?: string } = {},
) {
  return db.contact.create({
    data: {
      workspaceId,
      email: overrides.email ?? `person${next()}@example.org`,
      firstName: overrides.firstName ?? null,
      consentBasis: 'requested_contact',
      consentedAt: new Date(),
    },
  });
}

export async function createList(db: Db, workspaceId: number, name = `List ${next()}`) {
  return db.contactList.create({ data: { workspaceId, name } });
}

export async function createCampaignWithRecipients(
  db: Db,
  workspaceId: number,
  options: { recipients?: number; status?: 'draft' | 'running' | 'paused'; steps?: number } = {},
) {
  const { recipients = 1, status = 'running', steps = 1 } = options;
  const campaign = await db.campaign.create({
    data: { workspaceId, name: `Campaign ${next()}`, status },
  });
  const stepRows = [];
  for (let position = 1; position <= steps; position++) {
    stepRows.push(
      await db.campaignStep.create({
        data: {
          campaignId: campaign.id,
          position,
          delayDays: position === 1 ? 0 : 2,
          subject: `Step ${position}`,
          body: 'Hello',
        },
      }),
    );
  }
  const recipientRows = [];
  for (let i = 0; i < recipients; i++) {
    const contact = await createContact(db, workspaceId);
    recipientRows.push(
      await db.campaignRecipient.create({
        data: { workspaceId, campaignId: campaign.id, contactId: contact.id },
      }),
    );
  }
  return { campaign, steps: stepRows, recipients: recipientRows };
}

export async function createScheduledMessage(
  db: Db,
  args: {
    workspaceId: number;
    campaignId: number;
    recipientId: number;
    stepId: number;
    toEmail: string;
    runAt: Date;
  },
) {
  return db.emailMessage.create({ data: { ...args, status: 'scheduled' } });
}
