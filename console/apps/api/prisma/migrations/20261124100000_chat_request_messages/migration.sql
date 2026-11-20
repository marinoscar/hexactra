-- E40.1 (#685): a request the agent made during a chat's run stays in the thread.
-- The message holds the masked prompt and `meta.questionId`; the outcome is read
-- from the question. Never a value.
ALTER TYPE "chat_message_kind" ADD VALUE 'request';
