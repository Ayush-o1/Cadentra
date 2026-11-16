import type request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  advanceCampaigns,
  autoPauseCampaign,
} from '../../src/modules/campaigns/campaigns.actions.js';
import { buildTestApp, errorBody, registerAgent, resetDatabase } from '../helpers.js';

const { app, db } = buildTestApp();

beforeEach(async () => {
  await resetDatabase(db);
});

afterAll(async () => {
  await db.$disconnect();
});

type Agent = request.Agent;
type CampaignBody = {
  id: number;
  status: string;
  version: number;
  pauseReason: string | null;
  counts: Record<string, number>;
  steps: { id: number; position: number; delayDays: number }[];
  launch: { blockers: string[]; eligibleRecipients: number } | null;
};

const body = <T>(res: request.Response) => (res.body as { data: T }).data;

async function readyAgent() {
  const registered = await registerAgent(app);
  await registered.agent.patch('/api/v1/workspace').send({
    senderName: 'Priya at Northwind',
    senderEmail: 'priya@northwind.example',
    postalAddress: '12 Harbour Road, Bristol BS1 4AA, United Kingdom',
    timezone: 'UTC',
    windowStartHour: 0,
    windowEndHour: 24,
    weekdaysOnly: false,
  });
  return registered;
}

async function listWithContacts(agent: Agent, count: number, name = 'Expo leads') {
  const list = body<{ id: number }>(await agent.post('/api/v1/lists').send({ name }));
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const contact = body<{ id: number }>(
      await agent.post('/api/v1/contacts').send({
        email: `${name.replace(/\s/g, '').toLowerCase()}${i}@example.org`,
        firstName: `First${i}`,
        consentBasis: 'event_attendee',
      }),
    );
    ids.push(contact.id);
  }
  await agent.post(`/api/v1/lists/${list.id}/members`).send({ contactIds: ids });
  return { listId: list.id, contactIds: ids };
}

const sequence = [
  {
    subject: 'Nice to meet you, {{first_name|there}}',
    body: 'Hello {{first_name|there}},\n\nThanks for stopping by.',
    delayDays: 0,
  },
  { subject: 'Following up', body: 'Just checking in.', delayDays: 3 },
];

async function draftCampaign(agent: Agent, listId: number | null, steps = sequence) {
  const created = body<CampaignBody>(
    await agent.post('/api/v1/campaigns').send({ name: 'Expo follow-up', listId }),
  );
  const withSteps = await agent
    .put(`/api/v1/campaigns/${created.id}/steps`)
    .send({ version: created.version, steps });
  return body<CampaignBody>(withSteps);
}

describe('drafting a campaign', () => {
  it('inherits the workspace sending window and loads blockers for the builder', async () => {
    const { agent } = await registerAgent(app);
    const created = await agent.post('/api/v1/campaigns').send({ name: 'Draft one' });
    expect(created.status).toBe(201);
    const campaign = body<CampaignBody & { windowStartHour: number; weekdaysOnly: boolean }>(
      created,
    );
    expect(campaign).toMatchObject({ status: 'draft', windowStartHour: 9, weekdaysOnly: true });
    expect(campaign.launch?.blockers).toEqual(
      expect.arrayContaining([
        'Choose a list to send to',
        'Write at least one email',
        'Add a sender name in Settings',
      ]),
    );
  });

  it('replaces the sequence, numbering steps in order and ignoring the first delay', async () => {
    const { agent } = await readyAgent();
    const { listId } = await listWithContacts(agent, 2);
    const campaign = await draftCampaign(agent, listId, [
      { subject: 'One', body: 'First', delayDays: 5 },
      { subject: 'Two', body: 'Second', delayDays: 2 },
    ]);
    expect(campaign.steps.map((s) => [s.position, s.delayDays])).toEqual([
      [1, 0],
      [2, 2],
    ]);
    expect(campaign.launch).toEqual({ blockers: [], eligibleRecipients: 2 });
  });

  it('rejects unknown merge fields so a typo never reaches a recipient', async () => {
    const { agent } = await readyAgent();
    const created = body<CampaignBody>(
      await agent.post('/api/v1/campaigns').send({ name: 'Typos' }),
    );
    const res = await agent.put(`/api/v1/campaigns/${created.id}/steps`).send({
      version: created.version,
      steps: [{ subject: 'Hi {{firstname}}', body: 'Hello', delayDays: 0 }],
    });
    expect(res.status).toBe(422);
    expect(errorBody(res).details?.[0]?.path).toBe('steps.0.subject');
  });

  it('detects edits made from a stale copy', async () => {
    const { agent } = await readyAgent();
    const created = body<CampaignBody>(
      await agent.post('/api/v1/campaigns').send({ name: 'Original' }),
    );
    const first = await agent
      .patch(`/api/v1/campaigns/${created.id}`)
      .send({ version: created.version, name: 'Tab one' });
    expect(first.status).toBe(200);
    const stale = await agent
      .patch(`/api/v1/campaigns/${created.id}`)
      .send({ version: created.version, name: 'Tab two' });
    expect(stale.status).toBe(409);
    expect(errorBody(stale).code).toBe('VERSION_CONFLICT');
    expect((await db.campaign.findUniqueOrThrow({ where: { id: created.id } })).name).toBe(
      'Tab one',
    );
  });

  it('only lets drafts be edited or deleted', async () => {
    const { agent } = await readyAgent();
    const { listId } = await listWithContacts(agent, 1);
    const draft = await draftCampaign(agent, listId);
    const launched = body<CampaignBody>(
      await agent.post(`/api/v1/campaigns/${draft.id}/launch`).send({ version: draft.version }),
    );

    const edit = await agent
      .patch(`/api/v1/campaigns/${draft.id}`)
      .send({ version: launched.version, name: 'Renamed' });
    expect(errorBody(edit).code).toBe('CAMPAIGN_LOCKED');
    const steps = await agent
      .put(`/api/v1/campaigns/${draft.id}/steps`)
      .send({ version: launched.version, steps: sequence });
    expect(errorBody(steps).code).toBe('CAMPAIGN_LOCKED');
    expect(errorBody(await agent.delete(`/api/v1/campaigns/${draft.id}`)).code).toBe(
      'CAMPAIGN_LOCKED',
    );
  });

  it('deletes a draft together with its steps', async () => {
    const { agent } = await readyAgent();
    const draft = await draftCampaign(agent, null);
    expect((await agent.delete(`/api/v1/campaigns/${draft.id}`)).status).toBe(204);
    expect(await db.campaignStep.count()).toBe(0);
  });

  it('previews a step with a real contact or with sample data', async () => {
    const { agent } = await readyAgent();
    const { listId, contactIds } = await listWithContacts(agent, 1);
    const campaign = await draftCampaign(agent, listId);
    const real = body<{ subject: string; usedSampleData: boolean }>(
      await agent
        .post(`/api/v1/campaigns/${campaign.id}/preview`)
        .send({ position: 1, contactId: contactIds[0] }),
    );
    expect(real).toEqual({
      subject: 'Nice to meet you, First0',
      body: expect.stringContaining('Hello First0,') as string,
      usedSampleData: false,
    });
    const sample = body<{ subject: string; usedSampleData: boolean }>(
      await agent.post(`/api/v1/campaigns/${campaign.id}/preview`).send({ position: 1 }),
    );
    expect(sample).toMatchObject({ subject: 'Nice to meet you, Alex', usedSampleData: true });
  });
});

describe('launching', () => {
  it('is blocked until the sender identity, list and emails are in place', async () => {
    const { agent } = await registerAgent(app);
    const created = body<CampaignBody>(
      await agent.post('/api/v1/campaigns').send({ name: 'Too early' }),
    );
    const res = await agent
      .post(`/api/v1/campaigns/${created.id}/launch`)
      .send({ version: created.version });
    expect(res.status).toBe(422);
    expect(errorBody(res).code).toBe('LAUNCH_BLOCKED');
    expect(errorBody(res).details!.length).toBeGreaterThanOrEqual(4);
    expect(await db.campaignRecipient.count()).toBe(0);
  });

  it('is blocked when every contact on the list is suppressed', async () => {
    const { agent } = await readyAgent();
    const { listId } = await listWithContacts(agent, 1);
    await agent.post('/api/v1/suppressions').send({ email: 'expoleads0@example.org' });
    const campaign = await draftCampaign(agent, listId);
    const res = await agent
      .post(`/api/v1/campaigns/${campaign.id}/launch`)
      .send({ version: campaign.version });
    expect(res.status).toBe(422);
    expect(errorBody(res).details?.map((d) => d.message)).toContain(
      'The list has no contacts who can be emailed',
    );
  });

  it('enrols eligible contacts, skips suppressed ones and schedules the first email', async () => {
    const { agent, identity } = await readyAgent();
    const { listId } = await listWithContacts(agent, 5);
    await agent.post('/api/v1/suppressions').send({ email: 'expoleads2@example.org' });
    const campaign = await draftCampaign(agent, listId);

    const res = await agent
      .post(`/api/v1/campaigns/${campaign.id}/launch`)
      .send({ version: campaign.version });
    expect(res.status).toBe(200);
    const launched = body<CampaignBody>(res);
    expect(launched.status).toBe('running');
    expect(launched.counts).toMatchObject({ recipients: 4, scheduled: 4 });

    const messages = await db.emailMessage.findMany({ where: { campaignId: campaign.id } });
    expect(messages).toHaveLength(4);
    expect(
      messages.every((m) => m.stepId === campaign.steps[0]!.id && m.status === 'scheduled'),
    ).toBe(true);
    expect(messages.map((m) => m.toEmail)).not.toContain('expoleads2@example.org');
    expect(
      await db.activityLog.count({
        where: { workspaceId: identity.workspace.id, action: 'campaign.launched' },
      }),
    ).toBe(1);
  });

  it('is scheduled, not running, when the start time is in the future', async () => {
    const { agent } = await readyAgent();
    const { listId } = await listWithContacts(agent, 2);
    const draft = await draftCampaign(agent, listId);
    const startAt = new Date(Date.now() + 2 * 86_400_000);
    const updated = body<CampaignBody>(
      await agent
        .patch(`/api/v1/campaigns/${draft.id}`)
        .send({ version: draft.version, startAt: startAt.toISOString() }),
    );
    const launched = body<CampaignBody>(
      await agent.post(`/api/v1/campaigns/${draft.id}/launch`).send({ version: updated.version }),
    );
    expect(launched.status).toBe('scheduled');
    const messages = await db.emailMessage.findMany({ where: { campaignId: draft.id } });
    expect(messages.every((m) => m.runAt >= startAt)).toBe(true);
  });

  it('places the first send inside the sending window', async () => {
    const { agent } = await readyAgent();
    await agent
      .patch('/api/v1/workspace')
      .send({ windowStartHour: 9, windowEndHour: 10, weekdaysOnly: false });
    const { listId } = await listWithContacts(agent, 1);
    const draft = await draftCampaign(agent, listId);
    await agent
      .patch(`/api/v1/campaigns/${draft.id}`)
      .send({ version: draft.version, windowStartHour: 9, windowEndHour: 10 });
    const current = body<CampaignBody>(await agent.get(`/api/v1/campaigns/${draft.id}`));
    await agent.post(`/api/v1/campaigns/${draft.id}/launch`).send({ version: current.version });
    const message = await db.emailMessage.findFirstOrThrow({ where: { campaignId: draft.id } });
    expect(message.runAt.getUTCHours()).toBe(9);
    expect(message.runAt.getTime()).toBeGreaterThanOrEqual(Date.now() - 1000);
  });

  it('lets exactly one of several simultaneous launches succeed', async () => {
    const { agent } = await readyAgent();
    const { listId } = await listWithContacts(agent, 6);
    const draft = await draftCampaign(agent, listId);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        agent.post(`/api/v1/campaigns/${draft.id}/launch`).send({ version: draft.version }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect(await db.campaignRecipient.count({ where: { campaignId: draft.id } })).toBe(6);
    expect(await db.emailMessage.count({ where: { campaignId: draft.id } })).toBe(6);
  });

  it('refuses a launch based on a stale version', async () => {
    const { agent } = await readyAgent();
    const { listId } = await listWithContacts(agent, 1);
    const draft = await draftCampaign(agent, listId);
    const res = await agent
      .post(`/api/v1/campaigns/${draft.id}/launch`)
      .send({ version: draft.version - 1 });
    expect(errorBody(res).code).toBe('VERSION_CONFLICT');
  });
});

describe('pause, resume and cancel', () => {
  async function runningCampaign() {
    const ctx = await readyAgent();
    const { listId } = await listWithContacts(ctx.agent, 3);
    const draft = await draftCampaign(ctx.agent, listId);
    const launched = body<CampaignBody>(
      await ctx.agent.post(`/api/v1/campaigns/${draft.id}/launch`).send({ version: draft.version }),
    );
    return { ...ctx, campaign: launched };
  }

  it('pauses and resumes a running campaign', async () => {
    const { agent, campaign } = await runningCampaign();
    const paused = body<CampaignBody>(await agent.post(`/api/v1/campaigns/${campaign.id}/pause`));
    expect(paused).toMatchObject({ status: 'paused', pauseReason: 'Paused by you' });
    const resumed = body<CampaignBody>(
      await agent.post(`/api/v1/campaigns/${campaign.id}/resume`).send({}),
    );
    expect(resumed).toMatchObject({ status: 'running', pauseReason: null });
  });

  it('rejects transitions the lifecycle does not allow', async () => {
    const { agent, campaign } = await runningCampaign();
    const resumeRunning = await agent.post(`/api/v1/campaigns/${campaign.id}/resume`).send({});
    expect(errorBody(resumeRunning).code).toBe('INVALID_TRANSITION');
    await agent.post(`/api/v1/campaigns/${campaign.id}/cancel`);
    for (const action of ['pause', 'resume', 'cancel', 'launch']) {
      const res = await agent
        .post(`/api/v1/campaigns/${campaign.id}/${action}`)
        .send({ version: 1 });
      expect(res.status, action).toBe(409);
    }
  });

  it('requires an explicit acknowledgement to resume after an automatic pause', async () => {
    const { agent, campaign } = await runningCampaign();
    expect(await autoPauseCampaign(db, campaign.id, 'bounce rate 5.0% is above the 3% limit')).toBe(
      true,
    );
    const refused = await agent.post(`/api/v1/campaigns/${campaign.id}/resume`).send({});
    expect(errorBody(refused).code).toBe('BOUNCE_RATE_ACK_REQUIRED');
    const accepted = await agent
      .post(`/api/v1/campaigns/${campaign.id}/resume`)
      .send({ acknowledgeBounceRate: true });
    expect(accepted.status).toBe(200);
  });

  it('cancels pending messages and stops the recipients', async () => {
    const { agent, campaign } = await runningCampaign();
    const cancelled = body<CampaignBody>(
      await agent.post(`/api/v1/campaigns/${campaign.id}/cancel`),
    );
    expect(cancelled.status).toBe('cancelled');
    expect(
      await db.emailMessage.count({ where: { campaignId: campaign.id, status: 'cancelled' } }),
    ).toBe(3);
    expect(
      await db.campaignRecipient.count({
        where: { campaignId: campaign.id, status: 'stopped', stopReason: 'campaign_cancelled' },
      }),
    ).toBe(3);
  });

  it('applies a transition once when requested concurrently', async () => {
    const { agent, campaign } = await runningCampaign();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => agent.post(`/api/v1/campaigns/${campaign.id}/pause`)),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
  });
});

describe('campaign housekeeping', () => {
  it('starts scheduled campaigns when their time arrives and completes finished ones', async () => {
    const { agent } = await readyAgent();
    const { listId } = await listWithContacts(agent, 1);
    const draft = await draftCampaign(agent, listId);
    await agent
      .patch(`/api/v1/campaigns/${draft.id}`)
      .send({ version: draft.version, startAt: new Date(Date.now() + 3_600_000).toISOString() });
    const current = body<CampaignBody>(await agent.get(`/api/v1/campaigns/${draft.id}`));
    await agent.post(`/api/v1/campaigns/${draft.id}/launch`).send({ version: current.version });

    await advanceCampaigns(db, new Date());
    expect((await db.campaign.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe(
      'scheduled',
    );

    await advanceCampaigns(db, new Date(Date.now() + 2 * 3_600_000));
    expect((await db.campaign.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe(
      'running',
    );

    await db.campaignRecipient.updateMany({
      where: { campaignId: draft.id },
      data: { status: 'completed' },
    });
    await advanceCampaigns(db, new Date());
    expect((await db.campaign.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe(
      'completed',
    );
  });
});

describe('listing campaigns', () => {
  it('filters by status, searches by name and reports per-campaign counts', async () => {
    const { agent } = await readyAgent();
    const { listId } = await listWithContacts(agent, 2);
    const launchedDraft = await draftCampaign(agent, listId);
    await agent
      .post(`/api/v1/campaigns/${launchedDraft.id}/launch`)
      .send({ version: launchedDraft.version });
    await agent.post('/api/v1/campaigns').send({ name: 'Autumn newsletter' });

    const all = body<
      { name: string; status: string; counts: { recipients: number; scheduled: number } }[]
    >(await agent.get('/api/v1/campaigns'));
    expect(all).toHaveLength(2);
    const running = body<typeof all>(await agent.get('/api/v1/campaigns?status=running'));
    expect(running).toHaveLength(1);
    expect(running[0]!.counts).toMatchObject({ recipients: 2, scheduled: 2 });
    const searched = body<typeof all>(await agent.get('/api/v1/campaigns?search=autumn'));
    expect(searched.map((c) => c.name)).toEqual(['Autumn newsletter']);
  });

  it('lists the messages of a campaign with their step and status', async () => {
    const { agent } = await readyAgent();
    const { listId } = await listWithContacts(agent, 3);
    const draft = await draftCampaign(agent, listId);
    await agent.post(`/api/v1/campaigns/${draft.id}/launch`).send({ version: draft.version });
    const page = await agent.get(`/api/v1/campaigns/${draft.id}/messages?limit=2&status=scheduled`);
    const data = body<{ step: number; status: string }[]>(page);
    expect(data).toHaveLength(2);
    expect(data.every((m) => m.step === 1 && m.status === 'scheduled')).toBe(true);
    expect((page.body as { meta: { nextCursor: string | null } }).meta.nextCursor).not.toBeNull();
  });
});

describe('tenant isolation', () => {
  it('hides campaigns from other workspaces and refuses foreign lists', async () => {
    const a = await readyAgent();
    const b = await readyAgent();
    const { listId } = await listWithContacts(a.agent, 1, 'A list');
    const campaign = await draftCampaign(a.agent, listId);

    for (const call of [
      () => b.agent.get(`/api/v1/campaigns/${campaign.id}`),
      () => b.agent.patch(`/api/v1/campaigns/${campaign.id}`).send({ version: 1, name: 'x' }),
      () =>
        b.agent.put(`/api/v1/campaigns/${campaign.id}/steps`).send({ version: 1, steps: sequence }),
      () => b.agent.delete(`/api/v1/campaigns/${campaign.id}`),
      () => b.agent.post(`/api/v1/campaigns/${campaign.id}/launch`).send({ version: 1 }),
      () => b.agent.post(`/api/v1/campaigns/${campaign.id}/pause`),
      () => b.agent.post(`/api/v1/campaigns/${campaign.id}/resume`).send({}),
      () => b.agent.post(`/api/v1/campaigns/${campaign.id}/cancel`),
      () => b.agent.post(`/api/v1/campaigns/${campaign.id}/preview`).send({ position: 1 }),
      () => b.agent.get(`/api/v1/campaigns/${campaign.id}/messages`),
    ]) {
      expect((await call()).status).toBe(404);
    }
    expect(body<unknown[]>(await b.agent.get('/api/v1/campaigns'))).toHaveLength(0);

    const targetsForeignList = await b.agent
      .post('/api/v1/campaigns')
      .send({ name: 'Sneaky', listId });
    expect(targetsForeignList.status).toBe(422);
  });
});
