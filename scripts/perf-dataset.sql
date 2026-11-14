-- Builds a 50,000-contact, 50,000-message workspace so query plans are meaningful.
--   docker exec -i cadentra-mysql mysql -ucadentra -pcadentra cadentra < scripts/perf-dataset.sql
-- Remove it again with:  DELETE FROM workspaces WHERE name = 'Perf workspace';
INSERT INTO workspaces (name, updated_at) VALUES ('Perf workspace', NOW(3));
SET @ws = LAST_INSERT_ID();
SET SESSION cte_max_recursion_depth = 60000;
INSERT INTO contacts (workspace_id, email, first_name, consent_basis, consented_at, updated_at)
  WITH RECURSIVE n AS (SELECT 1 AS i UNION ALL SELECT i+1 FROM n WHERE i < 50000)
  SELECT @ws, CONCAT('person', i, '@perf', MOD(i, 40), '.example'), CONCAT('First', i), 'signed_up', NOW(3), NOW(3) FROM n;
INSERT INTO campaigns (workspace_id, name, status, updated_at) VALUES (@ws, 'Perf campaign', 'running', NOW(3));
SET @camp = LAST_INSERT_ID();
INSERT INTO campaign_steps (campaign_id, position, delay_days, subject, body) VALUES (@camp, 1, 0, 's', 'b');
SET @step = LAST_INSERT_ID();
INSERT INTO campaign_recipients (workspace_id, campaign_id, contact_id, status, updated_at)
  SELECT @ws, @camp, id, 'active', NOW(3) FROM contacts WHERE workspace_id = @ws;
INSERT INTO email_messages (workspace_id, campaign_id, recipient_id, step_id, to_email, status, run_at, accepted_at, provider_message_id, updated_at)
  SELECT r.workspace_id, r.campaign_id, r.id, @step, c.email,
         ELT(1 + MOD(r.id, 5), 'scheduled', 'accepted', 'delivered', 'delivered', 'bounced'),
         NOW(3) + INTERVAL MOD(r.id, 100000) SECOND,
         IF(MOD(r.id, 5) = 0, NULL, NOW(3) - INTERVAL MOD(r.id, 20) DAY),
         IF(MOD(r.id, 5) = 0, NULL, CONCAT('perf_', r.id)), NOW(3)
  FROM campaign_recipients r JOIN contacts c ON c.id = r.contact_id WHERE r.campaign_id = @camp;
ANALYZE TABLE contacts, email_messages, campaign_recipients;
