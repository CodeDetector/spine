-- Supplementary migration: adds the visible_employee_ids() function.
-- Safe to run on its own if the main 2026-05-11-three-agents-schema.sql has
-- already been applied. Idempotent (CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION visible_employee_ids(p_employee_id bigint)
RETURNS TABLE (id bigint)
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE downline AS (
    SELECT e.id FROM employees e WHERE e.id = p_employee_id
    UNION
    SELECT e.id
    FROM employees e
    JOIN downline d ON e."managedBy" = d.id
  )
  SELECT id FROM downline;
$$;
