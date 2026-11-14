import type { Config } from '../config/env.js';
import type { Db } from '../lib/db.js';
import type { Logger } from '../lib/logger.js';
import { recordProviderEvent } from '../modules/webhooks/events.js';
import { FakeProvider } from './fake.provider.js';
import type { EmailProvider } from './provider.js';
import { ResendProvider } from './resend.provider.js';

export function createEmailProvider(config: Config, db: Db, logger: Logger): EmailProvider {
  if (config.email.provider === 'resend') {
    return new ResendProvider(config.email.resendApiKey!);
  }
  logger.warn('EMAIL_PROVIDER=fake: no email will be sent. Delivery events are simulated.');
  return new FakeProvider({
    onEvent: (event) => {
      recordProviderEvent(db, {
        provider: 'fake',
        eventId: event.eventId,
        type: event.type,
        providerMessageId: event.providerMessageId,
        occurredAt: new Date(),
      }).catch((error: unknown) => logger.error({ err: error }, 'Simulated event failed'));
    },
  });
}
