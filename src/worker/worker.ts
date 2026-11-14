import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { Config } from '../config/env.js';
import type { EmailProvider } from '../email/provider.js';
import type { Db } from '../lib/db.js';
import type { Logger } from '../lib/logger.js';
import { advanceCampaigns } from '../modules/campaigns/campaigns.actions.js';
import { claimDueMessages } from './claim.js';
import { processMessage, type Outcome } from './processor.js';
import { createSendThrottle } from './rate-limiter.js';

const LEASE_MS = 5 * 60 * 1000;
const MAX_BATCHES_PER_RUN = 50;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const WEBHOOK_PAYLOAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SHUTDOWN_WAIT_MS = 20_000;

export type RunSummary = Record<Outcome | 'claimed', number>;

export type Worker = {
  start(): void;
  /** Stops claiming new messages and waits for the ones in flight. */
  stop(): Promise<void>;
  /** Processes everything that is due now. Also used by the optional /internal/tick endpoint. */
  runOnce(): Promise<RunSummary>;
};

export type WorkerDeps = { db: Db; provider: EmailProvider; config: Config; logger: Logger };

function emptySummary(): RunSummary {
  return {
    claimed: 0,
    accepted: 0,
    skipped: 0,
    rescheduled: 0,
    retrying: 0,
    failed: 0,
    released: 0,
    lease_lost: 0,
  };
}

export function createWorker(deps: WorkerDeps): Worker {
  const { db, config, logger } = deps;
  const workerId = `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
  const throttle = createSendThrottle(config.worker.maxSendsPerSecond);
  const processorDeps = { ...deps, workerId, throttle };

  let running = false;
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<unknown> | undefined;
  let lastCleanup = 0;

  async function cleanup(now: Date): Promise<void> {
    if (now.getTime() - lastCleanup < CLEANUP_INTERVAL_MS) return;
    lastCleanup = now.getTime();
    const sessions = await db.session.deleteMany({ where: { expiresAt: { lt: now } } });
    const payloads = await db.webhookEvent.updateMany({
      where: {
        receivedAt: { lt: new Date(now.getTime() - WEBHOOK_PAYLOAD_RETENTION_MS) },
        payload: { not: undefined },
      },
      data: { payload: undefined },
    });
    logger.debug({ sessions: sessions.count, payloads: payloads.count }, 'Housekeeping done');
  }

  async function runOnce(): Promise<RunSummary> {
    const summary = emptySummary();
    const now = new Date();
    await advanceCampaigns(db, now);
    await cleanup(now);

    for (let batch = 0; batch < MAX_BATCHES_PER_RUN && !stopping; batch++) {
      const claimed = await claimDueMessages(db, {
        now: new Date(),
        limit: config.worker.concurrency,
        workerId,
        leaseMs: LEASE_MS,
      });
      if (claimed.length === 0) break;
      summary.claimed += claimed.length;

      const outcomes = await Promise.all(
        claimed.map((message) =>
          processMessage(processorDeps, message).catch((error: unknown) => {
            logger.error({ err: error, messageId: message.id }, 'Message processing crashed');
            return null;
          }),
        ),
      );
      for (const outcome of outcomes) if (outcome) summary[outcome] += 1;
    }
    return summary;
  }

  function schedule(): void {
    timer = setTimeout(() => {
      timer = undefined;
      inFlight = runOnce()
        .then((summary) => {
          if (summary.claimed > 0) logger.info(summary, 'Worker run finished');
        })
        .catch((error: unknown) => logger.error({ err: error }, 'Worker run failed'))
        .finally(() => {
          inFlight = undefined;
          if (running) schedule();
        });
    }, config.worker.pollMs);
  }

  return {
    runOnce,

    start() {
      if (running) return;
      running = true;
      stopping = false;
      logger.info({ workerId, pollMs: config.worker.pollMs }, 'Worker started');
      schedule();
    },

    async stop() {
      running = false;
      stopping = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (inFlight) {
        await Promise.race([
          inFlight,
          new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS).unref()),
        ]);
      }
      logger.info('Worker stopped');
    },
  };
}
