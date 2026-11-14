import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, errorBody, registerAgent, resetDatabase } from '../helpers.js';
import { createCampaignWithRecipients, createScheduledMessage } from '../factories.js';

const { app, db } = buildTestApp();

beforeEach(async () => {
  await resetDatabase(db);
});

afterAll(async () => {
  await db.$disconnect();
});

type ContactBody = {
  id: number;
  email: string;
  suppressionReason: string | null;
  lists: { id: number; name: string }[];
};

const consent = { consentBasis: 'requested_contact', consentSource: 'Booth sign-up sheet' };

async function twoWorkspaces() {
  return { a: await registerAgent(app), b: await registerAgent(app) };
}

describe('creating contacts', () => {
  it('stores consent details and puts the contact on the chosen lists', async () => {
    const { agent } = await registerAgent(app);
    const list = (await agent.post('/api/v1/lists').send({ name: 'Conference leads' })).body as {
      data: { id: number };
    };
    const res = await agent.post('/api/v1/contacts').send({
      email: 'Ada@Example.org',
      firstName: 'Ada',
      lastName: 'Lovelace',
      company: 'Analytical Engines',
      ...consent,
      listIds: [list.data.id],
    });
    expect(res.status).toBe(201);
    const contact = (res.body as { data: ContactBody & { consentBasis: string } }).data;
    expect(contact.email).toBe('ada@example.org');
    expect(contact.consentBasis).toBe('requested_contact');
    expect(contact.lists).toEqual([{ id: list.data.id, name: 'Conference leads' }]);
  });

  it('requires a consent basis', async () => {
    const { agent } = await registerAgent(app);
    const res = await agent.post('/api/v1/contacts').send({ email: 'x@example.org' });
    expect(res.status).toBe(422);
    expect(errorBody(res).details?.map((d) => d.path)).toContain('consentBasis');
  });

  it('rejects consent dated in the future', async () => {
    const { agent } = await registerAgent(app);
    const res = await agent.post('/api/v1/contacts').send({
      email: 'x@example.org',
      ...consent,
      consentedAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(res.status).toBe(422);
  });

  it('prevents duplicates inside a workspace only', async () => {
    const { a, b } = await twoWorkspaces();
    const body = { email: 'same@example.org', ...consent };
    expect((await a.agent.post('/api/v1/contacts').send(body)).status).toBe(201);
    const duplicate = await a.agent.post('/api/v1/contacts').send(body);
    expect(duplicate.status).toBe(409);
    expect(errorBody(duplicate).code).toBe('CONTACT_EXISTS');
    expect((await b.agent.post('/api/v1/contacts').send(body)).status).toBe(201);
  });

  it('refuses lists that belong to another workspace', async () => {
    const { a, b } = await twoWorkspaces();
    const foreignList = (await b.agent.post('/api/v1/lists').send({ name: 'Private' })).body as {
      data: { id: number };
    };
    const res = await a.agent
      .post('/api/v1/contacts')
      .send({ email: 'x@example.org', ...consent, listIds: [foreignList.data.id] });
    expect(res.status).toBe(422);
    expect(await db.contact.count({ where: { email: 'x@example.org' } })).toBe(0);
  });
});

describe('listing, searching and filtering', () => {
  async function seed(agent: request.Agent) {
    const people = [
      {
        email: 'ada@example.org',
        firstName: 'Ada',
        lastName: 'Lovelace',
        company: 'Analytical Engines',
      },
      {
        email: 'alan@example.org',
        firstName: 'Alan',
        lastName: 'Turing',
        company: 'Bletchley Park',
      },
      { email: 'grace@navy.example', firstName: 'Grace', lastName: 'Hopper', company: 'Navy' },
      {
        email: 'linus@kernel.example',
        firstName: 'Linus',
        lastName: 'Torvalds',
        company: '100% Open',
      },
      {
        email: 'margaret@nasa.example',
        firstName: 'Margaret',
        lastName: 'Hamilton',
        company: 'NASA',
      },
    ];
    for (const person of people) {
      await agent.post('/api/v1/contacts').send({ ...person, ...consent });
    }
  }

  it('pages through every contact exactly once with cursors', async () => {
    const { agent } = await registerAgent(app);
    await seed(agent);
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/api/v1/contacts?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await agent.get(url);
      const body = res.body as { data: ContactBody[]; meta: { nextCursor: string | null } };
      seen.push(...body.data.map((c) => c.id));
      cursor = body.meta.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort((x, y) => y - x)).toEqual(seen);
  });

  it('rejects a malformed cursor', async () => {
    const { agent } = await registerAgent(app);
    expect((await agent.get('/api/v1/contacts?cursor=!!!')).status).toBe(400);
  });

  it('searches by email prefix, name and company', async () => {
    const { agent } = await registerAgent(app);
    await seed(agent);
    const search = async (term: string) =>
      (
        (await agent.get(`/api/v1/contacts?search=${encodeURIComponent(term)}`)).body as {
          data: ContactBody[];
        }
      ).data.map((c) => c.email);
    expect(await search('alan')).toEqual(['alan@example.org']);
    expect(await search('mar')).toEqual(['margaret@nasa.example']);
    expect(await search('hopper')).toEqual(['grace@navy.example']);
    expect(await search('ada lovelace')).toEqual(['ada@example.org']);
    expect(await search('Navy')).toEqual(['grace@navy.example']);
  });

  it('treats LIKE wildcards in the search term as plain characters', async () => {
    const { agent } = await registerAgent(app);
    await seed(agent);
    const percent = (await agent.get('/api/v1/contacts?search=%25')).body as {
      data: ContactBody[];
    };
    expect(percent.data.map((c) => c.email)).toEqual(['linus@kernel.example']);
    const underscore = (await agent.get('/api/v1/contacts?search=_')).body as {
      data: ContactBody[];
    };
    expect(underscore.data).toHaveLength(0);
  });

  it('filters by list and by suppression status', async () => {
    const { agent } = await registerAgent(app);
    await seed(agent);
    const list = (await agent.post('/api/v1/lists').send({ name: 'Pioneers' })).body as {
      data: { id: number };
    };
    const all = (await agent.get('/api/v1/contacts')).body as { data: ContactBody[] };
    const [first, second] = all.data;
    await agent
      .post(`/api/v1/lists/${list.data.id}/members`)
      .send({ contactIds: [first!.id, second!.id] });
    await agent.post('/api/v1/suppressions').send({ email: first!.email });

    const inList = (await agent.get(`/api/v1/contacts?listId=${list.data.id}`)).body as {
      data: ContactBody[];
    };
    expect(inList.data).toHaveLength(2);
    const suppressed = (await agent.get('/api/v1/contacts?status=suppressed')).body as {
      data: ContactBody[];
    };
    expect(suppressed.data.map((c) => c.email)).toEqual([first!.email]);
    expect(suppressed.data[0]!.suppressionReason).toBe('manual');
    const active = (await agent.get('/api/v1/contacts?status=active')).body as {
      data: ContactBody[];
    };
    expect(active.data).toHaveLength(4);
  });
});

describe('editing and deleting', () => {
  it('updates fields and reports duplicate emails', async () => {
    const { agent } = await registerAgent(app);
    const one = (
      await agent.post('/api/v1/contacts').send({ email: 'one@example.org', ...consent })
    ).body as { data: ContactBody };
    await agent.post('/api/v1/contacts').send({ email: 'two@example.org', ...consent });

    const ok = await agent
      .patch(`/api/v1/contacts/${one.data.id}`)
      .send({ firstName: 'One', company: null });
    expect(ok.status).toBe(200);
    const clash = await agent
      .patch(`/api/v1/contacts/${one.data.id}`)
      .send({ email: 'two@example.org' });
    expect(clash.status).toBe(409);
  });

  it('erases the contact but keeps its suppression', async () => {
    const { agent } = await registerAgent(app);
    const contact = (
      await agent.post('/api/v1/contacts').send({ email: 'gone@example.org', ...consent })
    ).body as { data: ContactBody };
    await agent.post('/api/v1/suppressions').send({ email: 'gone@example.org' });
    expect((await agent.delete(`/api/v1/contacts/${contact.data.id}`)).status).toBe(204);
    expect((await agent.get(`/api/v1/contacts/${contact.data.id}`)).status).toBe(404);
    const suppressions = (await agent.get('/api/v1/suppressions')).body as {
      data: { email: string }[];
    };
    expect(suppressions.data.map((s) => s.email)).toEqual(['gone@example.org']);
  });
});

describe('tenant isolation', () => {
  it('hides contacts, lists and suppressions from other workspaces', async () => {
    const { a, b } = await twoWorkspaces();
    const contact = (
      await a.agent.post('/api/v1/contacts').send({ email: 'secret@example.org', ...consent })
    ).body as { data: ContactBody };
    const list = (await a.agent.post('/api/v1/lists').send({ name: 'Mine' })).body as {
      data: { id: number };
    };
    await a.agent.post('/api/v1/suppressions').send({ email: 'optout@example.org' });
    const suppression = await db.suppression.findFirstOrThrow();

    expect((await b.agent.get(`/api/v1/contacts/${contact.data.id}`)).status).toBe(404);
    expect(
      (await b.agent.patch(`/api/v1/contacts/${contact.data.id}`).send({ firstName: 'x' })).status,
    ).toBe(404);
    expect((await b.agent.delete(`/api/v1/contacts/${contact.data.id}`)).status).toBe(404);
    expect((await b.agent.get(`/api/v1/lists/${list.data.id}`)).status).toBe(404);
    expect(
      (await b.agent.patch(`/api/v1/lists/${list.data.id}`).send({ name: 'Stolen' })).status,
    ).toBe(404);
    expect((await b.agent.delete(`/api/v1/lists/${list.data.id}`)).status).toBe(404);
    expect((await b.agent.delete(`/api/v1/suppressions/${suppression.id}`)).status).toBe(404);

    expect(((await b.agent.get('/api/v1/contacts')).body as { data: unknown[] }).data).toHaveLength(
      0,
    );
    expect(((await b.agent.get('/api/v1/lists')).body as { data: unknown[] }).data).toHaveLength(0);
    expect(
      ((await b.agent.get('/api/v1/suppressions')).body as { data: unknown[] }).data,
    ).toHaveLength(0);
    expect(await db.contact.count({ where: { id: contact.data.id } })).toBe(1);
  });

  it('refuses to put a foreign contact on a list or import into a foreign list', async () => {
    const { a, b } = await twoWorkspaces();
    const contact = (
      await a.agent.post('/api/v1/contacts').send({ email: 'x@example.org', ...consent })
    ).body as { data: ContactBody };
    const listOfB = (await b.agent.post('/api/v1/lists').send({ name: 'B list' })).body as {
      data: { id: number };
    };

    const add = await b.agent
      .post(`/api/v1/lists/${listOfB.data.id}/members`)
      .send({ contactIds: [contact.data.id] });
    expect(add.status).toBe(422);
    const imported = await a.agent
      .post(`/api/v1/contacts/import?consentBasis=signed_up&listId=${listOfB.data.id}`)
      .set('Content-Type', 'text/csv')
      .send('email\nnew@example.org\n');
    expect(imported.status).toBe(404);
  });
});

describe('lists', () => {
  it('creates, renames, counts members and deletes', async () => {
    const { agent } = await registerAgent(app);
    const list = (await agent.post('/api/v1/lists').send({ name: 'Newsletter' })).body as {
      data: { id: number };
    };
    expect((await agent.post('/api/v1/lists').send({ name: 'newsletter' })).status).toBe(409);

    const contact = (
      await agent.post('/api/v1/contacts').send({ email: 'a@example.org', ...consent })
    ).body as { data: ContactBody };
    const added = await agent
      .post(`/api/v1/lists/${list.data.id}/members`)
      .send({ contactIds: [contact.data.id] });
    expect((added.body as { data: { added: number } }).data.added).toBe(1);
    const again = await agent
      .post(`/api/v1/lists/${list.data.id}/members`)
      .send({ contactIds: [contact.data.id] });
    expect((again.body as { data: { added: number } }).data.added).toBe(0);

    const renamed = await agent
      .patch(`/api/v1/lists/${list.data.id}`)
      .send({ name: 'Product news' });
    expect((renamed.body as { data: { name: string; contactCount: number } }).data).toMatchObject({
      name: 'Product news',
      contactCount: 1,
    });

    expect(
      (await agent.delete(`/api/v1/lists/${list.data.id}/members/${contact.data.id}`)).status,
    ).toBe(204);
    expect((await agent.delete(`/api/v1/lists/${list.data.id}`)).status).toBe(204);
    expect(await db.contact.count()).toBe(1);
  });

  it('refuses to delete a list that a campaign targets', async () => {
    const { agent, identity } = await registerAgent(app);
    const list = (await agent.post('/api/v1/lists').send({ name: 'Used' })).body as {
      data: { id: number };
    };
    await db.campaign.create({
      data: { workspaceId: identity.workspace.id, name: 'C', listId: list.data.id },
    });
    const res = await agent.delete(`/api/v1/lists/${list.data.id}`);
    expect(res.status).toBe(409);
    expect(errorBody(res).code).toBe('LIST_IN_USE');
  });
});

describe('CSV import', () => {
  type Report = {
    totalRows: number;
    created: number;
    duplicates: number;
    invalid: number;
    suppressed: number;
    addedToList: number;
    errors: { row: number; email: string | null; message: string }[];
  };

  const upload = (
    agent: request.Agent,
    csv: string,
    query = 'consentBasis=event_attendee&source=Expo%202026',
  ) => agent.post(`/api/v1/contacts/import?${query}`).set('Content-Type', 'text/csv').send(csv);

  it('reports created, duplicate, invalid and suppressed rows with line numbers', async () => {
    const { agent } = await registerAgent(app);
    await agent.post('/api/v1/contacts').send({ email: 'existing@example.org', ...consent });
    await agent.post('/api/v1/suppressions').send({ email: 'optedout@example.org' });
    const list = (await agent.post('/api/v1/lists').send({ name: 'Expo' })).body as {
      data: { id: number };
    };

    const csv = [
      '﻿Email Address,First Name,Last Name,Company',
      'new1@example.org,Ada,Lovelace,Engines',
      'not-an-email,Bad,Row,',
      'new1@example.org,Dup,InFile,',
      'existing@example.org,Already,Here,',
      'optedout@example.org,Out,Out,',
      '',
      'new2@example.org,,,',
    ].join('\n');

    const res = await upload(
      agent,
      csv,
      `consentBasis=event_attendee&source=Expo%202026&listId=${list.data.id}`,
    );
    expect(res.status).toBe(200);
    const report = (res.body as { data: Report }).data;
    expect(report).toMatchObject({
      totalRows: 6,
      created: 3,
      duplicates: 2,
      invalid: 1,
      suppressed: 1,
      addedToList: 4,
    });
    expect(report.errors.map((e) => e.row)).toEqual([3, 4, 5]);
    expect(report.errors[0]!.message).toMatch(/valid email/i);

    const created = await db.contact.findUniqueOrThrow({
      where: {
        workspaceId_email: {
          workspaceId: (await db.workspace.findFirstOrThrow()).id,
          email: 'new1@example.org',
        },
      },
    });
    expect(created).toMatchObject({
      firstName: 'Ada',
      consentBasis: 'event_attendee',
      consentSource: 'Expo 2026',
    });
  });

  it('requires a consent basis for the whole import', async () => {
    const { agent } = await registerAgent(app);
    const res = await upload(agent, 'email\na@example.org\n', 'source=x');
    expect(res.status).toBe(422);
    expect(await db.contact.count()).toBe(0);
  });

  it('rejects files without an email column, empty files and oversized imports', async () => {
    const { agent } = await registerAgent(app);
    expect((await upload(agent, 'name\nAda\n')).status).toBe(422);
    expect((await upload(agent, 'email\n')).status).toBe(422);
    const huge = ['email', ...Array.from({ length: 5001 }, (_, i) => `u${i}@example.org`)].join(
      '\n',
    );
    const res = await upload(agent, huge);
    expect(res.status).toBe(422);
    expect(errorBody(res).message).toMatch(/5000/);
  });

  it('rejects a body that is not declared as CSV', async () => {
    const { agent } = await registerAgent(app);
    const res = await agent
      .post('/api/v1/contacts/import?consentBasis=signed_up')
      .set('Content-Type', 'text/plain')
      .send('email\na@example.org\n');
    expect(res.status).toBe(415);
  });

  it('imports large files in batches', async () => {
    const { agent } = await registerAgent(app);
    const csv = ['email', ...Array.from({ length: 1200 }, (_, i) => `bulk${i}@example.org`)].join(
      '\n',
    );
    const res = await upload(agent, csv);
    expect((res.body as { data: Report }).data.created).toBe(1200);
    expect(await db.contact.count()).toBe(1200);
  });
});

describe('suppression list', () => {
  it('adds manual entries idempotently and lifts only manual ones', async () => {
    const { agent, identity } = await registerAgent(app);
    const first = await agent.post('/api/v1/suppressions').send({ email: 'Block@Example.org' });
    const second = await agent.post('/api/v1/suppressions').send({ email: 'block@example.org' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await db.suppression.count()).toBe(1);

    await db.suppression.create({
      data: {
        workspaceId: identity.workspace.id,
        email: 'unsub@example.org',
        reason: 'unsubscribed',
      },
    });
    const locked = await db.suppression.findFirstOrThrow({ where: { reason: 'unsubscribed' } });
    const refused = await agent.delete(`/api/v1/suppressions/${locked.id}`);
    expect(refused.status).toBe(409);
    expect(errorBody(refused).code).toBe('SUPPRESSION_LOCKED');

    const manual = await db.suppression.findFirstOrThrow({ where: { reason: 'manual' } });
    expect((await agent.delete(`/api/v1/suppressions/${manual.id}`)).status).toBe(204);
  });

  it('stops pending messages to a newly suppressed contact', async () => {
    const { agent, identity } = await registerAgent(app);
    const { campaign, steps, recipients } = await createCampaignWithRecipients(
      db,
      identity.workspace.id,
      { steps: 2 },
    );
    const recipient = recipients[0]!;
    const contact = await db.contact.findUniqueOrThrow({ where: { id: recipient.contactId } });
    const message = await createScheduledMessage(db, {
      workspaceId: identity.workspace.id,
      campaignId: campaign.id,
      recipientId: recipient.id,
      stepId: steps[0]!.id,
      toEmail: contact.email,
      runAt: new Date(Date.now() + 3_600_000),
    });

    await agent.post('/api/v1/suppressions').send({ email: contact.email });

    const after = await db.emailMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(after.status).toBe('skipped');
    const stopped = await db.campaignRecipient.findUniqueOrThrow({ where: { id: recipient.id } });
    expect(stopped).toMatchObject({ status: 'stopped', stopReason: 'manual' });
  });
});
