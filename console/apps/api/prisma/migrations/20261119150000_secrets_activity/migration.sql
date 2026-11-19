-- CreateTable
CREATE TABLE "secrets_activity" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "event" VARCHAR(16) NOT NULL,
    "op_id" UUID NOT NULL,
    "run_id" UUID,
    "provider" VARCHAR(20) NOT NULL,
    "item_id" VARCHAR(100),
    "field" VARCHAR(20),
    "site" VARCHAR(255),
    "purpose" VARCHAR(20),
    "outcome" VARCHAR(32) NOT NULL,
    "matches" INTEGER,
    "released" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "secrets_activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "secrets_activity_user_id_occurred_at_idx" ON "secrets_activity"("user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "secrets_activity_occurred_at_idx" ON "secrets_activity"("occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "secrets_activity_op_id_event_key" ON "secrets_activity"("op_id", "event");

-- AddForeignKey
ALTER TABLE "secrets_activity" ADD CONSTRAINT "secrets_activity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
