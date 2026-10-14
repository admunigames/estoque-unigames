import assert from "node:assert/strict";
import test from "node:test";
import { createD1CompatFromPg } from "../db/d1-compat.ts";

// O adaptador D1 → Postgres cita aliases camelCase, mas nunca o tipo de um
// CAST (CAST(? AS TEXT) citado vira o tipo inexistente "TEXT" no Postgres).
test("d1-compat: cita alias camelCase, não o tipo do CAST; ?N vira $N", async () => {
  const seen = [];
  const fakeSql = { unsafe: async (query, params) => { seen.push({ query, params }); return []; } };
  const db = createD1CompatFromPg(fakeSql);
  await db.prepare("SELECT due_date AS dueDate, id AS id FROM t WHERE CAST(?1 AS TEXT) IS NOT NULL AND x = ?2").bind("2026-10-14", 5).all();
  assert.equal(seen[0].query, 'SELECT due_date AS "dueDate", id AS id FROM t WHERE CAST($1 AS TEXT) IS NOT NULL AND x = $2');
  assert.deepEqual(seen[0].params, ["2026-10-14", 5]);
});
