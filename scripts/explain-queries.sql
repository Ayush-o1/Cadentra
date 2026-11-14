-- Query plans for the hot paths named in docs/DATABASE_DESIGN.md.
-- Run against a seeded database:  docker exec -i cadentra-mysql mysql -ucadentra -pcadentra cadentra < scripts/explain-queries.sql
-- Replace @ws and @campaign with real ids first.
SET @ws = (SELECT id FROM workspaces ORDER BY id DESC LIMIT 1);
SET @campaign = (SELECT id FROM campaigns WHERE workspace_id = @ws ORDER BY id LIMIT 1);

SELECT 'Q1 claim due messages' AS query;
EXPLAIN SELECT m.id FROM email_messages m FORCE INDEX (idx_messages_status_run_at)
  STRAIGHT_JOIN campaigns c ON c.id = m.campaign_id AND c.status = 'running'
  WHERE m.status = 'scheduled' AND m.run_at <= NOW(3)
  ORDER BY m.run_at, m.id LIMIT 2 FOR UPDATE OF m SKIP LOCKED;

SELECT 'Q3 contacts page (newest first)' AS query;
EXPLAIN SELECT c.id FROM contacts c WHERE c.workspace_id = @ws AND c.id < 1000000 ORDER BY c.id DESC LIMIT 26;

SELECT 'Q4 contact search by email prefix' AS query;
EXPLAIN SELECT c.id FROM contacts c WHERE c.workspace_id = @ws AND c.email LIKE 'ada%' ORDER BY c.id DESC LIMIT 26;

SELECT 'Q5 contacts in a list, with suppression join' AS query;
EXPLAIN SELECT c.id, s.reason FROM contacts c
  LEFT JOIN suppressions s ON s.workspace_id = c.workspace_id AND s.email = c.email
  WHERE c.workspace_id = @ws AND EXISTS (SELECT 1 FROM contact_list_members m WHERE m.list_id = 1 AND m.contact_id = c.id AND m.workspace_id = c.workspace_id)
  ORDER BY c.id DESC LIMIT 26;

SELECT 'Q7 campaign funnel' AS query;
EXPLAIN SELECT status, COUNT(*) FROM email_messages WHERE campaign_id = @campaign GROUP BY status;

SELECT 'Q8 dashboard series (messages accepted per day)' AS query;
EXPLAIN SELECT DATE_FORMAT(accepted_at, '%Y-%m-%d') AS day, COUNT(*) FROM email_messages
  WHERE workspace_id = @ws AND accepted_at >= NOW() - INTERVAL 30 DAY AND accepted_at < NOW() GROUP BY day;

SELECT 'Q9 webhook lookup by provider id' AS query;
EXPLAIN SELECT id FROM email_messages WHERE provider_message_id = 'seed_1_1_1';

SELECT 'Q11 session lookup' AS query;
EXPLAIN SELECT id FROM sessions WHERE token_hash = 'abc';
