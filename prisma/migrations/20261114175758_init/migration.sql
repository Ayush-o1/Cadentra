-- CreateTable
CREATE TABLE `users` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `email` VARCHAR(254) NOT NULL,
    `password_hash` VARCHAR(255) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_users_email`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sessions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `user_agent` VARCHAR(255) NULL,
    `ip_address` VARCHAR(45) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_sessions_token_hash`(`token_hash`),
    INDEX `idx_sessions_user`(`user_id`),
    INDEX `idx_sessions_expires_at`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workspaces` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(120) NOT NULL,
    `timezone` VARCHAR(64) NOT NULL DEFAULT 'UTC',
    `sender_name` VARCHAR(120) NULL,
    `sender_email` VARCHAR(254) NULL,
    `reply_to_email` VARCHAR(254) NULL,
    `postal_address` VARCHAR(500) NULL,
    `window_start_hour` TINYINT NOT NULL DEFAULT 9,
    `window_end_hour` TINYINT NOT NULL DEFAULT 17,
    `weekdays_only` BOOLEAN NOT NULL DEFAULT true,
    `daily_send_limit` INTEGER NOT NULL DEFAULT 100,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workspace_members` (
    `workspace_id` INTEGER NOT NULL,
    `user_id` INTEGER NOT NULL,
    `role` ENUM('owner', 'member') NOT NULL DEFAULT 'member',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_members_user`(`user_id`),
    PRIMARY KEY (`workspace_id`, `user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contacts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `workspace_id` INTEGER NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `first_name` VARCHAR(100) NULL,
    `last_name` VARCHAR(100) NULL,
    `company` VARCHAR(160) NULL,
    `consent_basis` ENUM('requested_contact', 'existing_customer', 'signed_up', 'event_attendee', 'other_documented') NOT NULL,
    `consent_source` VARCHAR(255) NULL,
    `consented_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_contacts_ws_email`(`workspace_id`, `email`),
    UNIQUE INDEX `uq_contacts_ws_id`(`workspace_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contact_lists` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `workspace_id` INTEGER NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_lists_ws_name`(`workspace_id`, `name`),
    UNIQUE INDEX `uq_lists_ws_id`(`workspace_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contact_list_members` (
    `workspace_id` INTEGER NOT NULL,
    `list_id` INTEGER NOT NULL,
    `contact_id` INTEGER NOT NULL,
    `added_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_list_members_contact`(`contact_id`),
    INDEX `idx_list_members_workspace`(`workspace_id`),
    PRIMARY KEY (`list_id`, `contact_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `suppressions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `workspace_id` INTEGER NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `reason` ENUM('unsubscribed', 'hard_bounce', 'complaint', 'manual') NOT NULL,
    `source_message_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_suppressions_ws_email`(`workspace_id`, `email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `campaigns` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `workspace_id` INTEGER NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `status` ENUM('draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled') NOT NULL DEFAULT 'draft',
    `list_id` INTEGER NULL,
    `start_at` DATETIME(3) NULL,
    `window_start_hour` TINYINT NOT NULL DEFAULT 9,
    `window_end_hour` TINYINT NOT NULL DEFAULT 17,
    `weekdays_only` BOOLEAN NOT NULL DEFAULT true,
    `pause_reason` VARCHAR(255) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `launched_at` DATETIME(3) NULL,
    `completed_at` DATETIME(3) NULL,
    `created_by` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `idx_campaigns_ws_status`(`workspace_id`, `status`),
    INDEX `idx_campaigns_status_start`(`status`, `start_at`),
    UNIQUE INDEX `uq_campaigns_ws_id`(`workspace_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `campaign_steps` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `campaign_id` INTEGER NOT NULL,
    `position` INTEGER NOT NULL,
    `delay_days` INTEGER NOT NULL DEFAULT 0,
    `subject` VARCHAR(200) NOT NULL,
    `body` TEXT NOT NULL,

    UNIQUE INDEX `uq_steps_campaign_position`(`campaign_id`, `position`),
    UNIQUE INDEX `uq_steps_campaign_id`(`campaign_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `campaign_recipients` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `workspace_id` INTEGER NOT NULL,
    `campaign_id` INTEGER NOT NULL,
    `contact_id` INTEGER NOT NULL,
    `status` ENUM('active', 'completed', 'stopped') NOT NULL DEFAULT 'active',
    `stop_reason` VARCHAR(40) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `idx_recipients_campaign_status`(`campaign_id`, `status`),
    INDEX `idx_recipients_contact`(`contact_id`),
    UNIQUE INDEX `uq_recipients_campaign_contact`(`campaign_id`, `contact_id`),
    UNIQUE INDEX `uq_recipients_campaign_id`(`campaign_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `email_messages` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `workspace_id` INTEGER NOT NULL,
    `campaign_id` INTEGER NOT NULL,
    `recipient_id` INTEGER NOT NULL,
    `step_id` INTEGER NOT NULL,
    `to_email` VARCHAR(254) NOT NULL,
    `status` ENUM('scheduled', 'sending', 'accepted', 'delivered', 'bounced', 'complained', 'failed', 'skipped', 'cancelled') NOT NULL DEFAULT 'scheduled',
    `run_at` DATETIME(3) NOT NULL,
    `attempts` TINYINT NOT NULL DEFAULT 0,
    `locked_by` VARCHAR(64) NULL,
    `locked_until` DATETIME(3) NULL,
    `last_error` VARCHAR(500) NULL,
    `subject_sent` VARCHAR(200) NULL,
    `provider` VARCHAR(20) NULL,
    `provider_message_id` VARCHAR(100) NULL,
    `accepted_at` DATETIME(3) NULL,
    `delivered_at` DATETIME(3) NULL,
    `failed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_messages_provider_id`(`provider_message_id`),
    INDEX `idx_messages_status_run_at`(`status`, `run_at`),
    INDEX `idx_messages_campaign_status`(`campaign_id`, `status`),
    INDEX `idx_messages_ws_status`(`workspace_id`, `status`),
    INDEX `idx_messages_ws_accepted_at`(`workspace_id`, `accepted_at`),
    UNIQUE INDEX `uq_messages_recipient_step`(`recipient_id`, `step_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhook_events` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `provider` VARCHAR(20) NOT NULL,
    `provider_event_id` VARCHAR(100) NOT NULL,
    `event_type` VARCHAR(60) NOT NULL,
    `provider_message_id` VARCHAR(100) NULL,
    `status` ENUM('processed', 'unmatched', 'ignored') NOT NULL,
    `payload` JSON NULL,
    `received_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processed_at` DATETIME(3) NULL,

    INDEX `idx_webhook_events_message_status`(`provider_message_id`, `status`),
    INDEX `idx_webhook_events_received_at`(`received_at`),
    UNIQUE INDEX `uq_webhook_events_provider_event`(`provider`, `provider_event_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `activity_log` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `workspace_id` INTEGER NOT NULL,
    `user_id` INTEGER NULL,
    `action` VARCHAR(60) NOT NULL,
    `entity_type` VARCHAR(40) NULL,
    `entity_id` INTEGER NULL,
    `metadata` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_activity_ws_id`(`workspace_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workspace_members` ADD CONSTRAINT `workspace_members_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workspace_members` ADD CONSTRAINT `workspace_members_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contacts` ADD CONSTRAINT `contacts_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contact_lists` ADD CONSTRAINT `contact_lists_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contact_list_members` ADD CONSTRAINT `contact_list_members_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contact_list_members` ADD CONSTRAINT `contact_list_members_workspace_id_list_id_fkey` FOREIGN KEY (`workspace_id`, `list_id`) REFERENCES `contact_lists`(`workspace_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contact_list_members` ADD CONSTRAINT `contact_list_members_workspace_id_contact_id_fkey` FOREIGN KEY (`workspace_id`, `contact_id`) REFERENCES `contacts`(`workspace_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `suppressions` ADD CONSTRAINT `suppressions_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `campaigns` ADD CONSTRAINT `campaigns_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `campaigns` ADD CONSTRAINT `campaigns_workspace_id_list_id_fkey` FOREIGN KEY (`workspace_id`, `list_id`) REFERENCES `contact_lists`(`workspace_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `campaigns` ADD CONSTRAINT `campaigns_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `campaign_steps` ADD CONSTRAINT `campaign_steps_campaign_id_fkey` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `campaign_recipients` ADD CONSTRAINT `campaign_recipients_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `campaign_recipients` ADD CONSTRAINT `campaign_recipients_workspace_id_campaign_id_fkey` FOREIGN KEY (`workspace_id`, `campaign_id`) REFERENCES `campaigns`(`workspace_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `campaign_recipients` ADD CONSTRAINT `campaign_recipients_workspace_id_contact_id_fkey` FOREIGN KEY (`workspace_id`, `contact_id`) REFERENCES `contacts`(`workspace_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `email_messages` ADD CONSTRAINT `email_messages_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `email_messages` ADD CONSTRAINT `email_messages_workspace_id_campaign_id_fkey` FOREIGN KEY (`workspace_id`, `campaign_id`) REFERENCES `campaigns`(`workspace_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `email_messages` ADD CONSTRAINT `email_messages_campaign_id_recipient_id_fkey` FOREIGN KEY (`campaign_id`, `recipient_id`) REFERENCES `campaign_recipients`(`campaign_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `email_messages` ADD CONSTRAINT `email_messages_campaign_id_step_id_fkey` FOREIGN KEY (`campaign_id`, `step_id`) REFERENCES `campaign_steps`(`campaign_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `activity_log` ADD CONSTRAINT `activity_log_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `activity_log` ADD CONSTRAINT `activity_log_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Integrity rules that Prisma's schema language cannot express.
-- Emails are stored lower-cased; the binary collation makes the comparison case-sensitive.

ALTER TABLE `users`
  ADD CONSTRAINT `chk_users_email` CHECK (`email` COLLATE utf8mb4_bin = LOWER(`email`) AND INSTR(`email`, '@') > 1);

ALTER TABLE `contacts`
  ADD CONSTRAINT `chk_contacts_email` CHECK (`email` COLLATE utf8mb4_bin = LOWER(`email`) AND INSTR(`email`, '@') > 1);

ALTER TABLE `suppressions`
  ADD CONSTRAINT `chk_suppressions_email` CHECK (`email` COLLATE utf8mb4_bin = LOWER(`email`));

ALTER TABLE `email_messages`
  ADD CONSTRAINT `chk_messages_to_email` CHECK (`to_email` COLLATE utf8mb4_bin = LOWER(`to_email`)),
  ADD CONSTRAINT `chk_messages_attempts` CHECK (`attempts` BETWEEN 0 AND 10),
  ADD CONSTRAINT `chk_messages_lease` CHECK (`status` <> 'sending' OR (`locked_by` IS NOT NULL AND `locked_until` IS NOT NULL)),
  ADD CONSTRAINT `chk_messages_provider_id` CHECK (`status` NOT IN ('accepted', 'delivered', 'bounced', 'complained') OR `provider_message_id` IS NOT NULL);

ALTER TABLE `workspaces`
  ADD CONSTRAINT `chk_workspaces_window` CHECK (`window_start_hour` BETWEEN 0 AND 23 AND `window_end_hour` BETWEEN 1 AND 24 AND `window_start_hour` < `window_end_hour`),
  ADD CONSTRAINT `chk_workspaces_daily_limit` CHECK (`daily_send_limit` BETWEEN 1 AND 100000);

ALTER TABLE `campaigns`
  ADD CONSTRAINT `chk_campaigns_window` CHECK (`window_start_hour` BETWEEN 0 AND 23 AND `window_end_hour` BETWEEN 1 AND 24 AND `window_start_hour` < `window_end_hour`),
  ADD CONSTRAINT `chk_campaigns_version` CHECK (`version` >= 1);

ALTER TABLE `campaign_steps`
  ADD CONSTRAINT `chk_steps_position` CHECK (`position` >= 1),
  ADD CONSTRAINT `chk_steps_delay` CHECK (`delay_days` BETWEEN 0 AND 60);

ALTER TABLE `campaign_recipients`
  ADD CONSTRAINT `chk_recipients_stop_reason` CHECK (`status` <> 'stopped' OR `stop_reason` IS NOT NULL);
