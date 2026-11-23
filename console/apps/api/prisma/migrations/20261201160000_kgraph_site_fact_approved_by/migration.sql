-- E46.36 (#892): how an active site fact was approved. `owner` (the owner approved, typed or restored it) or `auto` (the owner's opt-in
-- `kgraph.autoApproveFacts` made a fact derived from server records active). Every fact stored before this was approved, if at all, by the
-- owner: the default. kg_ tables only.

-- AlterTable
ALTER TABLE "kg_site_facts" ADD COLUMN "approved_by" VARCHAR(8) NOT NULL DEFAULT 'owner';
