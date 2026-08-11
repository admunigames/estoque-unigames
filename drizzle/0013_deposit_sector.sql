UPDATE "app_users"
SET "sector" = 'deposit', "company_id" = ''
WHERE "sector" = ''
  AND (
    lower("username") IN ('deposito', 'cd')
    OR "company_id" IN (
      SELECT (elem->>'id')
      FROM "shared_state", jsonb_array_elements(("value_json")::jsonb) AS elem
      WHERE "state_key" = 'companies_list'
        AND (
          lower(elem->>'name') ILIKE '%dep_sito%'
          OR lower(elem->>'name') = 'cd'
          OR lower(elem->>'name') LIKE 'cd %'
          OR lower(elem->>'name') LIKE '%centro de distribui%'
        )
    )
  );
