-- The application user owns the dev database; the test database and Prisma's
-- shadow database (used by `prisma migrate dev`) are created here as well.
CREATE DATABASE IF NOT EXISTS cadentra_test CHARACTER SET utf8mb4;
CREATE DATABASE IF NOT EXISTS cadentra_shadow CHARACTER SET utf8mb4;
GRANT ALL PRIVILEGES ON cadentra_test.* TO 'cadentra'@'%';
GRANT ALL PRIVILEGES ON cadentra_shadow.* TO 'cadentra'@'%';
