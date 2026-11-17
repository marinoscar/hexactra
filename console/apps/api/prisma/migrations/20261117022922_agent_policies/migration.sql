-- CreateEnum
CREATE TYPE "policy_source" AS ENUM ('run', 'schedule', 'task', 'user_default', 'system_default');

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "policy_ref" VARCHAR(64),
ADD COLUMN     "policy_snapshot" JSONB,
ADD COLUMN     "policy_source" "policy_source",
ADD COLUMN     "policy_version" INTEGER;

-- AlterTable
ALTER TABLE "task_schedules" ADD COLUMN     "policy_ref" VARCHAR(64);

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "policy_ref" VARCHAR(64);

-- CreateTable
CREATE TABLE "agent_policies" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "spec" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "agent_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_policies_user_id_name_key" ON "agent_policies"("user_id", "name");

-- AddForeignKey
ALTER TABLE "agent_policies" ADD CONSTRAINT "agent_policies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DataMigration: legacy task limits become personal agent policies (#401).
--
-- A task whose max_steps / max_minutes differ from the task defaults (100 / 30,
-- src/tasks/task-defaults.ts) or that pins a model gets a policy named
-- "Task: <task name>", derived from the Balanced built-in: maxActions =
-- max_steps, maxActiveMinutes = max_minutes. A pinned model becomes
-- models.pins.standard and caps maxTier at standard, so the task keeps exactly
-- the model it had. Identical specs of one user share one policy.
--
-- Idempotent: it only touches tasks whose policy_ref is null, so re-running it
-- changes nothing once they are converted; on an empty database it inserts
-- nothing. SQL, not a TypeScript step: it runs exactly once with the schema
-- change, in one transaction, and its values are frozen here instead of
-- following the built-in policies as they evolve.
-- BEGIN agent_policies_legacy_task_fields
DROP TABLE IF EXISTS _legacy_task_policy;
CREATE TEMP TABLE _legacy_task_policy AS
SELECT
  t.id AS task_id,
  t.user_id,
  left('Task: ' || t.name, 100) AS base_name,
  jsonb_build_object(
    'schemaVersion', 1,
    'models', jsonb_build_object(
      'startTier', 'standard',
      'maxTier', CASE WHEN t.model IS NULL THEN 'frontier' ELSE 'standard' END,
      'allowProviderFallback', true
    ) || CASE WHEN t.model IS NULL THEN '{}'::jsonb
              ELSE jsonb_build_object('pins', jsonb_build_object('standard', t.model)) END,
    'budget', jsonb_build_object(
      'maxActions', t.max_steps,
      'maxModelCalls', 120,
      'maxActiveMinutes', t.max_minutes,
      'maxInputTokens', NULL,
      'maxOutputTokens', NULL,
      'maxCostUsd', 2,
      'warnAtPercent', 80
    ),
    'stall', jsonb_build_object(
      'maxConsecutiveFailures', 4,
      'maxRepeatedAction', 3,
      'noProgressActions', 10,
      'onStall', 'nudge_then_escalate',
      'maxEscalations', 2
    ),
    'context', jsonb_build_object(
      'screenshotsKept', 2,
      'pruneBatch', 10,
      'callsPerChunk', 10,
      'observationChars', 6000
    )
  ) AS spec
FROM tasks t
WHERE t.policy_ref IS NULL
  AND (t.max_steps <> 100 OR t.max_minutes <> 30 OR t.model IS NOT NULL);

-- One new policy per distinct (user, spec) that no "Task: ..." policy of the user already holds.
INSERT INTO agent_policies (id, user_id, name, description, version, spec, created_at, updated_at)
SELECT
  gen_random_uuid(),
  d.user_id,
  CASE
    WHEN d.rn > 1 OR EXISTS (SELECT 1 FROM agent_policies p WHERE p.user_id = d.user_id AND p.name = d.base_name)
      THEN left(d.base_name, 91) || ' (' || left(md5(d.spec::text), 6) || ')'
    ELSE d.base_name
  END,
  'Derived from the task''s earlier step, time and model limits.',
  1,
  d.spec,
  now(),
  now()
FROM (
  SELECT
    x.user_id, x.base_name, x.spec,
    row_number() OVER (PARTITION BY x.user_id, x.base_name ORDER BY md5(x.spec::text)) AS rn
  FROM (
    SELECT DISTINCT ON (l.user_id, l.spec) l.user_id, l.base_name, l.spec
    FROM _legacy_task_policy l
    ORDER BY l.user_id, l.spec, l.base_name
  ) x
) d
WHERE NOT EXISTS (
  SELECT 1 FROM agent_policies p
  WHERE p.user_id = d.user_id AND p.spec = d.spec AND p.name LIKE 'Task: %'
);

UPDATE tasks t
SET policy_ref = (
  SELECT p.id::text FROM agent_policies p
  WHERE p.user_id = l.user_id AND p.spec = l.spec AND p.name LIKE 'Task: %'
  ORDER BY p.created_at, p.name LIMIT 1
)
FROM _legacy_task_policy l
WHERE t.id = l.task_id;

DROP TABLE _legacy_task_policy;
-- END agent_policies_legacy_task_fields
