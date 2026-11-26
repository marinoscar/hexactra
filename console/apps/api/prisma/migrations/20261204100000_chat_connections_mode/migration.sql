-- #969: a chat uses the owner's connections at what the owner switched on for each (`all`), unless it is limited (`listed`), as a task does (#967).

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN "connections_mode" VARCHAR(8) NOT NULL DEFAULT 'all';

-- An existing chat keeps a real limit: it stays `listed` when its owner chose `read` or `off` for new chats, or when one of the owner's active
-- connections is not on its list, or is on it read only. A chat that lists every active connection with read and change, or lists none while its
-- owner kept the default, uses all of them from now on.
UPDATE "conversations" c SET "connections_mode" = 'listed'
WHERE COALESCE((SELECT us."value" -> 'connections' ->> 'newChats' FROM "user_settings" us WHERE us."user_id" = c."user_id"), 'read_write') <> 'read_write'
   OR (
     EXISTS (SELECT 1 FROM "conversation_connections" cc WHERE cc."conversation_id" = c."id")
     AND EXISTS (
       SELECT 1 FROM "connections" k
       WHERE k."user_id" = c."user_id" AND k."status" = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM "conversation_connections" cc
           WHERE cc."conversation_id" = c."id" AND cc."connection_id" = k."id" AND cc."access" = 'read_write'
         )
     )
   );
DELETE FROM "conversation_connections" cc USING "conversations" c WHERE cc."conversation_id" = c."id" AND c."connections_mode" = 'all';
