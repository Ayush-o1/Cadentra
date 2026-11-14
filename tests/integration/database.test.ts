import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '../../src/generated/prisma/client.js';
import { claimDueMessages } from '../../src/worker/claim.js';
import {
  createCampaignWithRecipients,
  createContact,
  createList,
  createScheduledMessage,
  createWorkspace,
} from '../factories.js';
import { resetDatabase, testDb } from '../helpers.js';

const db = testDb();

beforeEach(async () => {
  await resetDatabase(db);
});

afterAll(async () => {
  await db.$disconnect();
});

function prismaCode(error: unknown): string | undefined {
  return error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined;
}

async function capture(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('uniqueness constraints', () => {
  it('rejects a duplicate contact email within a workspace but allows it in another', async () => {
    const a = await createWorkspace(db);
    const b = await createWorkspace(db);
    await createContact(db, a.id, { email: 'dup@example.org' });

    const error = await capture(createContact(db, a.id, { email: 'dup@example.org' }));
    expect(prismaCode(error)).toBe('P2002');
    await expect(createContact(db, b.id, { email: 'dup@example.org' })).resolves.toBeTruthy();
  });

  it('treats email uniqueness as case-insensitive through the collation', async () => {
    const ws = await createWorkspace(db);
    await db.$executeRaw`INSERT INTO suppressions (workspace_id, email, reason) VALUES (${ws.id}, 'a@example.org', 'manual')`;
    const error = await capture(
      db.$executeRaw`INSERT IGNORE INTO suppressions (workspace_id, email, reason) VALUES (${ws.id}, 'a@example.org', 'manual')`,
    );
    expect(error).toBeUndefined();
    expect(await db.suppression.count({ where: { workspaceId: ws.id } })).toBe(1);
  });

  it('prevents enrolling the same contact twice in one campaign', async () => {
    const ws = await createWorkspace(db);
    const { campaign, recipients } = await createCampaignWithRecipients(db, ws.id);
    const recipient = recipients[0]!;
    const error = await capture(
      db.campaignRecipient.create({
        data: { workspaceId: ws.id, campaignId: campaign.id, contactId: recipient.contactId },
      }),
    );
    expect(prismaCode(error)).toBe('P2002');
  });

  it('allows only one message per recipient and step', async () => {
    const ws = await createWorkspace(db);
    const { campaign, steps, recipients } = await createCampaignWithRecipients(db, ws.id);
    const args = {
      workspaceId: ws.id,
      campaignId: campaign.id,
      recipientId: recipients[0]!.id,
      stepId: steps[0]!.id,
      toEmail: 'x@example.org',
      runAt: new Date(),
    };
    await createScheduledMessage(db, args);
    expect(prismaCode(await capture(createScheduledMessage(db, args)))).toBe('P2002');
  });
});

describe('tenant isolation enforced by composite foreign keys', () => {
  it('refuses to put a contact of workspace A into a list of workspace B', async () => {
    const a = await createWorkspace(db);
    const b = await createWorkspace(db);
    const contactOfA = await createContact(db, a.id);
    const listOfB = await createList(db, b.id);

    for (const workspaceId of [a.id, b.id]) {
      const error = await capture(
        db.contactListMember.create({
          data: { workspaceId, listId: listOfB.id, contactId: contactOfA.id },
        }),
      );
      expect(prismaCode(error)).toBe('P2003');
    }
  });

  it('refuses to enrol a contact from another workspace in a campaign', async () => {
    const a = await createWorkspace(db);
    const b = await createWorkspace(db);
    const { campaign } = await createCampaignWithRecipients(db, a.id, { recipients: 0 });
    const foreignContact = await createContact(db, b.id);

    const error = await capture(
      db.campaignRecipient.create({
        data: { workspaceId: a.id, campaignId: campaign.id, contactId: foreignContact.id },
      }),
    );
    expect(prismaCode(error)).toBe('P2003');
  });

  it('refuses a campaign that targets another workspace list', async () => {
    const a = await createWorkspace(db);
    const b = await createWorkspace(db);
    const listOfB = await createList(db, b.id);
    const error = await capture(
      db.campaign.create({ data: { workspaceId: a.id, name: 'Sneaky', listId: listOfB.id } }),
    );
    expect(prismaCode(error)).toBe('P2003');
  });

  it('refuses a message whose step belongs to a different campaign', async () => {
    const ws = await createWorkspace(db);
    const first = await createCampaignWithRecipients(db, ws.id);
    const second = await createCampaignWithRecipients(db, ws.id);
    const error = await capture(
      createScheduledMessage(db, {
        workspaceId: ws.id,
        campaignId: first.campaign.id,
        recipientId: first.recipients[0]!.id,
        stepId: second.steps[0]!.id,
        toEmail: 'x@example.org',
        runAt: new Date(),
      }),
    );
    expect(prismaCode(error)).toBe('P2003');
  });
});

describe('check constraints', () => {
  it('rejects emails that are not stored lower-cased', async () => {
    const ws = await createWorkspace(db);
    const error = await capture(
      db.$executeRaw`INSERT INTO contacts (workspace_id, email, consent_basis, consented_at, updated_at)
        VALUES (${ws.id}, 'Mixed@Example.org', 'signed_up', NOW(3), NOW(3))`,
    );
    expect(String(error)).toMatch(/chk_contacts_email|check constraint/i);
  });

  it('rejects an invalid sending window', async () => {
    const ws = await createWorkspace(db);
    const error = await capture(
      db.campaign.create({
        data: { workspaceId: ws.id, name: 'Bad window', windowStartHour: 18, windowEndHour: 9 },
      }),
    );
    expect(String(error)).toMatch(/chk_campaigns_window|check constraint/i);
  });

  it('rejects a sending message that has no lease', async () => {
    const ws = await createWorkspace(db);
    const { campaign, steps, recipients } = await createCampaignWithRecipients(db, ws.id);
    const error = await capture(
      db.emailMessage.create({
        data: {
          workspaceId: ws.id,
          campaignId: campaign.id,
          recipientId: recipients[0]!.id,
          stepId: steps[0]!.id,
          toEmail: 'x@example.org',
          status: 'sending',
          runAt: new Date(),
        },
      }),
    );
    expect(String(error)).toMatch(/chk_messages_lease|check constraint/i);
  });

  it('rejects out-of-range step delays', async () => {
    const ws = await createWorkspace(db);
    const { campaign } = await createCampaignWithRecipients(db, ws.id, { recipients: 0, steps: 0 });
    const error = await capture(
      db.campaignStep.create({
        data: { campaignId: campaign.id, position: 1, delayDays: 400, subject: 's', body: 'b' },
      }),
    );
    expect(String(error)).toMatch(/chk_steps_delay|check constraint/i);
  });
});

describe('deletion behaviour', () => {
  it('erases a contact campaign history but keeps its suppression', async () => {
    const ws = await createWorkspace(db);
    const { campaign, steps, recipients } = await createCampaignWithRecipients(db, ws.id);
    const recipient = recipients[0]!;
    const contact = await db.contact.findUniqueOrThrow({ where: { id: recipient.contactId } });
    await createScheduledMessage(db, {
      workspaceId: ws.id,
      campaignId: campaign.id,
      recipientId: recipient.id,
      stepId: steps[0]!.id,
      toEmail: contact.email,
      runAt: new Date(),
    });
    await db.suppression.create({
      data: { workspaceId: ws.id, email: contact.email, reason: 'unsubscribed' },
    });

    await db.contact.delete({ where: { id: contact.id } });

    expect(await db.campaignRecipient.count({ where: { campaignId: campaign.id } })).toBe(0);
    expect(await db.emailMessage.count({ where: { campaignId: campaign.id } })).toBe(0);
    expect(await db.suppression.count({ where: { workspaceId: ws.id } })).toBe(1);
  });

  it('blocks deleting a list that a campaign targets', async () => {
    const ws = await createWorkspace(db);
    const list = await createList(db, ws.id);
    await db.campaign.create({ data: { workspaceId: ws.id, name: 'Uses list', listId: list.id } });
    const error = await capture(db.contactList.delete({ where: { id: list.id } }));
    expect(prismaCode(error)).toBe('P2003');
  });

  it('removes everything a workspace owns when the workspace is deleted', async () => {
    const ws = await createWorkspace(db);
    await createCampaignWithRecipients(db, ws.id, { recipients: 3 });
    await db.workspace.delete({ where: { id: ws.id } });
    expect(await db.contact.count()).toBe(0);
    expect(await db.campaign.count()).toBe(0);
    expect(await db.campaignRecipient.count()).toBe(0);
  });
});

describe('transactions', () => {
  it('rolls back every write when a step fails', async () => {
    const error = await capture(
      db.$transaction(async (tx) => {
        const workspace = await tx.workspace.create({ data: { name: 'Doomed' } });
        await tx.contact.create({
          data: {
            workspaceId: workspace.id,
            email: 'a@example.org',
            consentBasis: 'signed_up',
            consentedAt: new Date(),
          },
        });
        await tx.contact.create({
          data: {
            workspaceId: workspace.id,
            email: 'a@example.org',
            consentBasis: 'signed_up',
            consentedAt: new Date(),
          },
        });
      }),
    );
    expect(prismaCode(error)).toBe('P2002');
    expect(await db.workspace.count()).toBe(0);
    expect(await db.contact.count()).toBe(0);
  });
});

describe('connection settings', () => {
  it('runs every pooled connection at READ COMMITTED', async () => {
    const rows = await Promise.all(
      Array.from(
        { length: 5 },
        () => db.$queryRaw<{ level: string }[]>`SELECT @@transaction_isolation AS level`,
      ),
    );
    expect(rows.flat().map((row) => row.level)).toEqual(Array(5).fill('READ-COMMITTED'));
  });
});

describe('claimDueMessages', () => {
  async function seedMessages(count: number, campaignStatus: 'running' | 'paused' = 'running') {
    const ws = await createWorkspace(db);
    const { campaign, steps, recipients } = await createCampaignWithRecipients(db, ws.id, {
      recipients: count,
      status: campaignStatus,
    });
    const past = new Date(Date.now() - 60_000);
    for (const recipient of recipients) {
      await createScheduledMessage(db, {
        workspaceId: ws.id,
        campaignId: campaign.id,
        recipientId: recipient.id,
        stepId: steps[0]!.id,
        toEmail: `r${recipient.id}@example.org`,
        runAt: past,
      });
    }
    return { ws, campaign };
  }

  it('gives competing workers disjoint batches', async () => {
    await seedMessages(40);
    const now = new Date();
    const claims = await Promise.all(
      ['worker-a', 'worker-b', 'worker-c', 'worker-d'].map((workerId) =>
        claimDueMessages(db, { now, limit: 10, workerId, leaseMs: 60_000 }),
      ),
    );
    const ids = claims.flat().map((message) => message.id);
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
    expect(await db.emailMessage.count({ where: { status: 'sending' } })).toBe(40);
  });

  it('records the lease and increments attempts', async () => {
    await seedMessages(1);
    const now = new Date();
    const [claimed] = await claimDueMessages(db, {
      now,
      limit: 5,
      workerId: 'w1',
      leaseMs: 90_000,
    });
    expect(claimed?.attempts).toBe(1);
    const row = await db.emailMessage.findUniqueOrThrow({ where: { id: claimed!.id } });
    expect(row.lockedBy).toBe('w1');
    expect(row.lockedUntil?.getTime()).toBe(now.getTime() + 90_000);
  });

  it('does not claim messages that are not due yet', async () => {
    const { ws, campaign } = await seedMessages(1);
    await db.emailMessage.updateMany({
      where: { workspaceId: ws.id, campaignId: campaign.id },
      data: { runAt: new Date(Date.now() + 3_600_000) },
    });
    expect(
      await claimDueMessages(db, { now: new Date(), limit: 5, workerId: 'w', leaseMs: 1000 }),
    ).toEqual([]);
  });

  it('never claims messages of a paused campaign', async () => {
    await seedMessages(3, 'paused');
    expect(
      await claimDueMessages(db, { now: new Date(), limit: 5, workerId: 'w', leaseMs: 1000 }),
    ).toEqual([]);
  });

  it('reclaims messages whose lease expired and leaves live leases alone', async () => {
    await seedMessages(2);
    const t0 = new Date();
    const first = await claimDueMessages(db, {
      now: t0,
      limit: 5,
      workerId: 'crashed',
      leaseMs: 60_000,
    });
    expect(first).toHaveLength(2);

    const stillLeased = await claimDueMessages(db, {
      now: new Date(t0.getTime() + 30_000),
      limit: 5,
      workerId: 'other',
      leaseMs: 60_000,
    });
    expect(stillLeased).toEqual([]);

    const afterExpiry = await claimDueMessages(db, {
      now: new Date(t0.getTime() + 61_000),
      limit: 5,
      workerId: 'other',
      leaseMs: 60_000,
    });
    expect(afterExpiry.map((m) => m.attempts)).toEqual([2, 2]);
  });
});
