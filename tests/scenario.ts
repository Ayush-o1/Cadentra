import type { Express } from 'express';
import type request from 'supertest';
import { FakeProvider } from '../src/email/fake.provider.js';
import type { EmailProvider } from '../src/email/provider.js';
import { createWorker, type Worker } from '../src/worker/worker.js';
import { registerAgent, testLogger, type TestApp } from './helpers.js';

export type StepInput = { subject: string; body: string; delayDays: number };

export const TWO_STEP_SEQUENCE: StepInput[] = [
  {
    subject: 'Nice to meet you, {{first_name|there}}',
    body: 'Hello {{first_name|there}},\n\nThanks for stopping by.',
    delayDays: 0,
  },
  { subject: 'Following up', body: 'Just checking in.', delayDays: 3 },
];

let scenarioCounter = 0;

export type Scenario = {
  agent: request.Agent;
  workspaceId: number;
  campaignId: number;
  emails: string[];
};

const data = <T>(res: request.Response) => (res.body as { data: T }).data;

/**
 * Registers a workspace that is ready to send (sender identity set, all-day UTC window), imports
 * contacts through the API, and launches a campaign to them.
 */
export async function launchScenario(
  app: Express,
  options: { contacts?: number; steps?: StepInput[]; emailPrefix?: string } = {},
): Promise<Scenario> {
  const { contacts = 3, steps = TWO_STEP_SEQUENCE } = options;
  scenarioCounter += 1;
  const prefix = options.emailPrefix ?? `lead${scenarioCounter}-`;

  const { agent, identity } = await registerAgent(app);
  await agent.patch('/api/v1/workspace').send({
    senderName: 'Priya at Northwind',
    senderEmail: 'priya@northwind.example',
    postalAddress: '12 Harbour Road, Bristol BS1 4AA, United Kingdom',
    timezone: 'UTC',
    windowStartHour: 0,
    windowEndHour: 24,
    weekdaysOnly: false,
    dailySendLimit: 1000,
  });

  const emails = Array.from({ length: contacts }, (_, i) => `${prefix}${i}@example.org`);
  const list = data<{ id: number }>(await agent.post('/api/v1/lists').send({ name: 'Expo leads' }));
  const csv = ['email,first_name', ...emails.map((email, i) => `${email},Person${i}`)].join('\n');
  await agent
    .post(`/api/v1/contacts/import?consentBasis=event_attendee&listId=${list.id}`)
    .set('Content-Type', 'text/csv')
    .send(csv);

  const campaign = data<{ id: number; version: number }>(
    await agent.post('/api/v1/campaigns').send({ name: 'Expo follow-up', listId: list.id }),
  );
  const withSteps = data<{ version: number }>(
    await agent
      .put(`/api/v1/campaigns/${campaign.id}/steps`)
      .send({ version: campaign.version, steps }),
  );
  await agent.patch(`/api/v1/campaigns/${campaign.id}`).send({
    version: withSteps.version,
    windowStartHour: 0,
    windowEndHour: 24,
    weekdaysOnly: false,
  });
  const current = data<{ version: number }>(await agent.get(`/api/v1/campaigns/${campaign.id}`));
  const launched = await agent
    .post(`/api/v1/campaigns/${campaign.id}/launch`)
    .send({ version: current.version });
  if (launched.status !== 200) throw new Error(`Launch failed: ${JSON.stringify(launched.body)}`);

  return { agent, workspaceId: identity.workspace.id, campaignId: campaign.id, emails };
}

export function workerFor(ctx: TestApp, provider: EmailProvider = new FakeProvider()): Worker {
  return createWorker({ db: ctx.db, provider, config: ctx.config, logger: testLogger() });
}

/** Makes every waiting message due now, as if its scheduled time had passed. */
export async function makeAllDue(ctx: TestApp, campaignId: number): Promise<void> {
  await ctx.db.emailMessage.updateMany({
    where: { campaignId, status: 'scheduled' },
    data: { runAt: new Date(Date.now() - 1000) },
  });
}
