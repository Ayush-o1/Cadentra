import { describe, expect, it } from 'vitest';
import type { CampaignStatus } from '../../src/generated/prisma/client.js';
import {
  canTransition,
  isEditable,
  isTerminal,
  statusForStart,
  type CampaignAction,
} from '../../src/modules/campaigns/campaigns.lifecycle.js';

const statuses: CampaignStatus[] = [
  'draft',
  'scheduled',
  'running',
  'paused',
  'completed',
  'cancelled',
];

const allowed: Record<CampaignAction, CampaignStatus[]> = {
  launch: ['draft'],
  pause: ['scheduled', 'running'],
  resume: ['paused'],
  cancel: ['draft', 'scheduled', 'running', 'paused'],
  complete: ['running'],
};

describe('campaign transitions', () => {
  for (const [action, from] of Object.entries(allowed) as [CampaignAction, CampaignStatus[]][]) {
    it(`${action} is allowed only from ${from.join(', ')}`, () => {
      for (const status of statuses) {
        expect(canTransition(status, action), `${action} from ${status}`).toBe(
          from.includes(status),
        );
      }
    });
  }

  it('never leaves a terminal status', () => {
    for (const action of Object.keys(allowed) as CampaignAction[]) {
      expect(canTransition('completed', action)).toBe(false);
      expect(canTransition('cancelled', action)).toBe(false);
    }
  });

  it('only drafts are editable and only completed or cancelled are terminal', () => {
    expect(statuses.filter(isEditable)).toEqual(['draft']);
    expect(statuses.filter(isTerminal)).toEqual(['completed', 'cancelled']);
  });

  it('schedules for the future and runs immediately otherwise', () => {
    const now = new Date('2026-11-17T10:00:00Z');
    expect(statusForStart(null, now)).toBe('running');
    expect(statusForStart(new Date('2026-11-17T09:00:00Z'), now)).toBe('running');
    expect(statusForStart(new Date('2026-11-18T09:00:00Z'), now)).toBe('scheduled');
  });
});
