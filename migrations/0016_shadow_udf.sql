-- 0016_shadow_udf — user-defined fields as a structured column of the mirror.
--
-- Autotask returns UDFs as an unordered list, [{ "name": "Nexus-Status", "value": "2" }, …],
-- and the mirror kept that list as-is inside data. Comparing or filtering on it meant
-- scanning the list. Now every mirrored row also has
--   udf  jsonb  { "Nexus-Status": "2", "Region": "North", … }
-- (only UDFs with a value; null / "" are "no value"), computed by Postgres from data itself
-- (a STORED generated column), so every sync write keeps it right and nothing can scatter it.
-- Indexed for lookups: the mirror can answer UDF filters (Autotask's { udf: true } filters)
-- and group by a UDF, at no Autotask cost. data keeps Autotask's own shape for callers.
--
-- Adding a stored generated column rewrites shadow_record once (a few minutes on a large
-- mirror); reads keep working from Autotask meanwhile.

CREATE OR REPLACE FUNCTION shadow_udf_map(d jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(d -> 'userDefinedFields') = 'array' THEN
    COALESCE((
      SELECT jsonb_object_agg(e ->> 'name', e -> 'value')
      FROM jsonb_array_elements(d -> 'userDefinedFields') AS e
      WHERE jsonb_typeof(e) = 'object'
        AND coalesce(e ->> 'name', '') <> ''
        AND e -> 'value' IS NOT NULL AND jsonb_typeof(e -> 'value') <> 'null'
        AND coalesce(e ->> 'value', '') <> ''
    ), '{}'::jsonb)
  END
$$;

ALTER TABLE shadow_record ADD COLUMN IF NOT EXISTS udf jsonb GENERATED ALWAYS AS (shadow_udf_map(data)) STORED;

CREATE INDEX IF NOT EXISTS shadow_record_udf ON shadow_record USING gin (udf jsonb_path_ops) WHERE udf IS NOT NULL;
