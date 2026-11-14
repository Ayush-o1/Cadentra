import type { CampaignStatus } from '../../generated/prisma/client.js';

export type CampaignAction = 'launch' | 'pause' | 'resume' | 'cancel' | 'complete';

const TRANSITIONS: Record<CampaignAction, { from: CampaignStatus[]; to: CampaignStatus | null }> = {
  launch: { from: ['draft'], to: null },
  pause: { from: ['scheduled', 'running'], to: 'paused' },
  resume: { from: ['paused'], to: null },
  cancel: { from: ['draft', 'scheduled', 'running', 'paused'], to: 'cancelled' },
  complete: { from: ['running'], to: 'completed' },
};

export function allowedFrom(action: CampaignAction): CampaignStatus[] {
  return TRANSITIONS[action].from;
}

export function canTransition(status: CampaignStatus, action: CampaignAction): boolean {
  return TRANSITIONS[action].from.includes(status);
}

/** Launching or resuming lands in `scheduled` when the start time is still ahead, otherwise `running`. */
export function statusForStart(startAt: Date | null, now: Date): CampaignStatus {
  return startAt && startAt.getTime() > now.getTime() ? 'scheduled' : 'running';
}

export function isTerminal(status: CampaignStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

export function isEditable(status: CampaignStatus): boolean {
  return status === 'draft';
}

export const MAX_STEPS = 10;

export const AUTO_PAUSE_PREFIX = 'Auto-paused';
