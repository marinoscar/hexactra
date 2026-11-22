-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "record_video" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "record_video" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "run_recordings" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'recording',
    "fabric_id" VARCHAR(64),
    "object_key" VARCHAR(500),
    "part_count" INTEGER NOT NULL DEFAULT 0,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "mime" VARCHAR(64) NOT NULL DEFAULT 'video/webm',
    "dropped_frames" INTEGER NOT NULL DEFAULT 0,
    "note" VARCHAR(64),
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "run_recordings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "run_recordings_run_id_key" ON "run_recordings"("run_id");

-- CreateIndex
CREATE INDEX "run_recordings_status_created_at_idx" ON "run_recordings"("status", "created_at");

-- CreateIndex
CREATE INDEX "run_recordings_user_id_created_at_idx" ON "run_recordings"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "run_recordings" ADD CONSTRAINT "run_recordings_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_recordings" ADD CONSTRAINT "run_recordings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
