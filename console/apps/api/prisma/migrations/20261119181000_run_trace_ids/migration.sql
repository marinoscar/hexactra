-- The OpenTelemetry trace of a run's latest job (E38.4, #585): trace and span id of the root span, and every job's trace id.
-- Ids only; a trace holds no prompt, answer, URL or typed text.
-- AlterTable
ALTER TABLE "runs" ADD COLUMN "trace_id" VARCHAR(32),
ADD COLUMN "span_id" VARCHAR(16),
ADD COLUMN "trace_ids" VARCHAR(32)[] DEFAULT ARRAY[]::VARCHAR(32)[];
