-- ============================================================================
-- 0014 - the collector's dataset write-back.
--
-- 0013 deliberately gave the collector no direct policy on `form_dataset`,
-- `server_dataset` or `server_dataset_row`. That is the right boundary: a public
-- link must not be able to enumerate every case list in the organisation.
--
-- The write-back still has to happen in the response's transaction, so it is a
-- narrow SECURITY DEFINER function rather than a policy. It accepts one published
-- version, the answers the server just accepted, and the response's case id. It
-- can only write rows whose dataset is attached to that version in the current
-- organisation.
-- ============================================================================

CREATE OR REPLACE FUNCTION app_apply_dataset_publish(
  p_version uuid,
  p_values  jsonb,
  p_caseid  text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r       record;
  v_key   text;
  v_data  jsonb;
  v_count integer := 0;
BEGIN
  IF NOT app_is_collector() THEN
    RAISE EXCEPTION 'collector context required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM form_version
     WHERE id = p_version AND org_id = app_current_org() AND status = 'published'
  ) THEN
    RETURN 0;
  END IF;

  FOR r IN
    SELECT fd.dataset_id, fd.key_question, fd.mapping, d.columns
      FROM form_dataset fd
      JOIN server_dataset d ON d.id = fd.dataset_id
     WHERE fd.form_version_id = p_version
       AND fd.org_id = app_current_org()
       AND d.org_id = fd.org_id
       AND fd.publish = true
       AND d.archived_at IS NULL
  LOOP
    v_key := NULLIF(btrim(coalesce(
      CASE WHEN r.key_question IS NULL THEN NULL ELSE p_values->>r.key_question END,
      p_caseid
    )), '');

    IF v_key IS NULL THEN
      CONTINUE;
    END IF;

    IF r.mapping IS NULL OR r.mapping = '{}'::jsonb THEN
      SELECT coalesce(jsonb_object_agg(c, p_values->c), '{}'::jsonb)
        INTO v_data
        FROM jsonb_array_elements_text(r.columns) AS c
       WHERE p_values ? c
         AND nullif(btrim(p_values->>c), '') IS NOT NULL;
    ELSE
      SELECT coalesce(jsonb_object_agg(m.key, p_values->m.value), '{}'::jsonb)
        INTO v_data
        FROM jsonb_each_text(r.mapping) AS m
       WHERE p_values ? m.value
         AND nullif(btrim(p_values->>m.value), '') IS NOT NULL;
    END IF;

    IF v_data IS NULL OR v_data = '{}'::jsonb THEN
      CONTINUE;
    END IF;

    INSERT INTO server_dataset_row (org_id, dataset_id, row_key, data)
    VALUES (app_current_org(), r.dataset_id, v_key, v_data)
    ON CONFLICT (dataset_id, row_key)
    DO UPDATE SET data = server_dataset_row.data || EXCLUDED.data,
                  updated_at = now();

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION app_apply_dataset_publish(uuid, jsonb, text) TO app_role;
