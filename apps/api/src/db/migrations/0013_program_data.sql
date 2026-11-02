-- ============================================================================
-- 0013 - program data: server datasets, case rows and version attachments.
--
-- SurveyCTO's operational moat is not the form. It is the data that moves
-- around the form: a case list attached before the interview, a lookup during
-- it, and an updated case after it. This migration adds that layer without
-- changing the authoring or response spine.
--
-- Three decisions are worth stating:
--
--   * Rows are JSON objects, not one column per dataset. An operator imports a
--     CSV after the instrument is written, and a wide table would require a
--     migration for every new file. `columns` keeps the header order and
--     `row_key` is the unique lookup value.
--
--   * A dataset is attached to a form *version*, not a form. A published
--     version is immutable, and the data it reads must remain knowable. If
--     attachment lived on `form`, uploading a new case list would silently
--     change what an old, already-published instrument reads.
--
--   * The public collector does not get a policy on these tables. It calls
--     `app_collect_datasets`, a narrow SECURITY DEFINER function that returns
--     only the rows attached to the one version its link resolved to. The
--     collector still cannot read another response or another organisation.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A dataset is an organisation resource: a case list, a sample frame, a price
-- list, or any other table an instrument needs before it asks a question.
-- ---------------------------------------------------------------------------
CREATE TABLE server_dataset (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  code         citext NOT NULL,
  name         text NOT NULL,
  kind         text NOT NULL DEFAULT 'data'
               CHECK (kind IN ('data','cases')),
  -- The column whose value is the stable key for a row. `id` is the CSV
  -- convention and the case-list convention; a sample frame may use `hhid`.
  unique_field text NOT NULL DEFAULT 'id'
               CHECK (unique_field ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  -- An ordered array of column names, preserved from the imported header so
  -- the console and an export can render a stable table.
  columns      jsonb NOT NULL DEFAULT '[]'::jsonb
               CHECK (jsonb_typeof(columns) = 'array'),
  created_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  UNIQUE (org_id, code)
);
CREATE TRIGGER server_dataset_touch BEFORE UPDATE ON server_dataset
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE INDEX server_dataset_org_idx ON server_dataset (org_id, archived_at);

-- ---------------------------------------------------------------------------
-- One row per lookup key. The JSON object is the row the instrument reads.
-- `row_key` is duplicated out of the object because a unique index on a JSON
-- expression is harder to reason about and slower to scan than a text column.
-- ---------------------------------------------------------------------------
CREATE TABLE server_dataset_row (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  dataset_id uuid NOT NULL REFERENCES server_dataset(id) ON DELETE CASCADE,
  row_key    text NOT NULL CHECK (length(row_key) BETWEEN 1 AND 500),
  data       jsonb NOT NULL DEFAULT '{}'::jsonb
             CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, row_key)
);
CREATE TRIGGER server_dataset_row_touch BEFORE UPDATE ON server_dataset_row
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE INDEX server_dataset_row_dataset_idx ON server_dataset_row (dataset_id, row_key);
CREATE INDEX server_dataset_row_org_idx ON server_dataset_row (org_id, dataset_id);

-- ---------------------------------------------------------------------------
-- A version attachment. `mapping` is `{ dataset column: question name }`, and
-- `key_question` is the question whose answer identifies the row to update.
-- `publish` turns the attachment into a write-back rule: when the response is
-- submitted, the mapped answers update the case row in the same transaction.
-- ---------------------------------------------------------------------------
CREATE TABLE form_dataset (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  form_id         uuid NOT NULL REFERENCES form(id) ON DELETE CASCADE,
  form_version_id uuid NOT NULL REFERENCES form_version(id) ON DELETE CASCADE,
  dataset_id      uuid NOT NULL REFERENCES server_dataset(id) ON DELETE CASCADE,
  key_question    text,
  mapping         jsonb NOT NULL DEFAULT '{}'::jsonb
                  CHECK (jsonb_typeof(mapping) = 'object'),
  publish         boolean NOT NULL DEFAULT false,
  created_by      uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (form_version_id, dataset_id)
);
CREATE INDEX form_dataset_version_idx ON form_dataset (form_version_id);
CREATE INDEX form_dataset_dataset_idx ON form_dataset (dataset_id);
CREATE INDEX form_dataset_org_idx ON form_dataset (org_id);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
ALTER TABLE server_dataset     ENABLE ROW LEVEL SECURITY;
ALTER TABLE server_dataset     FORCE  ROW LEVEL SECURITY;
ALTER TABLE server_dataset_row ENABLE ROW LEVEL SECURITY;
ALTER TABLE server_dataset_row FORCE  ROW LEVEL SECURITY;
ALTER TABLE form_dataset       ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_dataset       FORCE  ROW LEVEL SECURITY;

CREATE POLICY server_dataset_read ON server_dataset FOR SELECT
  USING (app_is_member(org_id));
CREATE POLICY server_dataset_write ON server_dataset FOR ALL
  USING (app_has_org_role(org_id, ARRAY['owner','admin','member']))
  WITH CHECK (app_has_org_role(org_id, ARRAY['owner','admin','member']));

CREATE POLICY server_dataset_row_read ON server_dataset_row FOR SELECT
  USING (app_is_member(org_id));
CREATE POLICY server_dataset_row_write ON server_dataset_row FOR ALL
  USING (app_has_org_role(org_id, ARRAY['owner','admin','member']))
  WITH CHECK (app_has_org_role(org_id, ARRAY['owner','admin','member']));

CREATE POLICY form_dataset_read ON form_dataset FOR SELECT
  USING (app_is_member(org_id));
CREATE POLICY form_dataset_write ON form_dataset FOR ALL
  USING (app_has_org_role(org_id, ARRAY['owner','admin','member']))
  WITH CHECK (app_has_org_role(org_id, ARRAY['owner','admin','member']));

-- ---------------------------------------------------------------------------
-- The collector's only door.
--
-- The caller has already resolved a distribution token to a published version.
-- This function re-checks the collector flag and the current organisation, then
-- returns the attached datasets and up to 5,000 rows per dataset as one JSON
-- value. No tenant table is exposed to the collector role directly.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_collect_datasets(p_version uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT app_is_collector() THEN
    RAISE EXCEPTION 'collector context required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM form_version fv
     WHERE fv.id = p_version
       AND fv.org_id = app_current_org()
       AND fv.status = 'published'
  ) THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT coalesce(jsonb_agg(
           jsonb_build_object(
             'datasetId',  d.id,
             'code',       d.code,
             'name',       d.name,
             'kind',       d.kind,
             'uniqueField', d.unique_field,
             'columns',    d.columns,
             'rows',       coalesce(r.rows, '[]'::jsonb)
           )
           ORDER BY d.code
         ), '[]'::jsonb)
    INTO v_result
    FROM form_dataset fd
    JOIN server_dataset d ON d.id = fd.dataset_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(x.data ORDER BY x.row_key) AS rows
        FROM (
          SELECT data, row_key
            FROM server_dataset_row
           WHERE dataset_id = d.id
           ORDER BY row_key
           LIMIT 5000
        ) x
    ) r ON true
   WHERE fd.form_version_id = p_version
     AND fd.org_id = app_current_org()
     AND d.org_id = fd.org_id
     AND d.archived_at IS NULL;

  RETURN coalesce(v_result, '[]'::jsonb);
END $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  server_dataset, server_dataset_row, form_dataset
  TO app_role;

GRANT EXECUTE ON FUNCTION app_collect_datasets(uuid) TO app_role;
