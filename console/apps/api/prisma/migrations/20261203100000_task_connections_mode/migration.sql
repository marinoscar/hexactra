-- #967: a task uses the owner's connections at what the owner switched on for each (`all`), unless the owner limits it (`listed`).
-- The browser question leaves the task form: every task opens a browser only when it needs one (`auto`).

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "connections_mode" VARCHAR(8) NOT NULL DEFAULT 'all';

-- An existing task keeps a real limit the owner set: it stays `listed` when one of the owner's active connections is not on its list, or
-- is on it read only. A task that lists none, or lists every active connection with read and change, uses all of them from now on.
UPDATE "tasks" t SET "connections_mode" = 'listed'
WHERE EXISTS (SELECT 1 FROM "task_connections" tc WHERE tc."task_id" = t."id")
  AND EXISTS (
    SELECT 1 FROM "connections" c
    WHERE c."user_id" = t."user_id" AND c."status" = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM "task_connections" tc
        WHERE tc."task_id" = t."id" AND tc."connection_id" = c."id" AND tc."access" = 'read_write'
      )
  );
DELETE FROM "task_connections" tc USING "tasks" t WHERE tc."task_id" = t."id" AND t."connections_mode" = 'all';

UPDATE "tasks" SET "needs_browser" = 'auto' WHERE "needs_browser" <> 'auto';
