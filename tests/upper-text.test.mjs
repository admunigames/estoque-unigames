import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// CAIXA ALTA no que o usuário grava (18/10/2026): withUpperText no getD1()
// converte só as colunas de texto livre de UPPER_TEXT_COLUMNS; login, senha,
// e-mail, PIX, ids, status e nomes de arquivo ficam intactos.

const db = await setupRouteDb(["shared_state", "finance_accounts"]);
const lib = await import("../app/lib/upper-text.ts");
const accounts = await import("../app/api/finance/accounts/route.ts");
const sharedState = await import("../app/api/shared-state/route.ts");
const ADMIN = { id: "admin", role: "admin" };

test("upperText mantém acentos e ignora o que não é texto", () => {
  assert.equal(lib.upperText("ação, pão e café ç"), "AÇÃO, PÃO E CAFÉ Ç");
  assert.equal(lib.upperText(12), 12);
  assert.equal(lib.upperText(null), null);
});

test("mapeia parâmetros só das colunas de texto livre", () => {
  const indexes = (sql) => [...(lib.upperParamIndexes(sql) ?? [])].sort();
  // INSERT com ?N, literais e coluna fora da lista (status, file_name).
  assert.deepEqual(
    indexes("INSERT INTO os_notes (id, company_name, requester_name, status, file_name) VALUES (?1, ?2, ?3, 'pending', ?4)"),
    [1, 2],
  );
  // "?" sequencial, função no meio e várias tuplas.
  assert.deepEqual(
    indexes("INSERT INTO supply_products (id, name, notes) VALUES (?, COALESCE(?, ''), ?), (?, ?, ?)"),
    [2, 4, 5],
  );
  // UPDATE: atribuição direta conta, expressão e WHERE não.
  assert.deepEqual(
    indexes("UPDATE hr_employees SET full_name=?1, status=?2, notes=COALESCE(?3, notes), pix_key=?4 WHERE full_name=?5"),
    [0],
  );
  // Upsert.
  assert.deepEqual(
    indexes("INSERT INTO finance_items (id, name) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET name=?3"),
    [1, 2],
  );
  // Tabela/coluna fora da lista: nada muda.
  assert.equal(lib.upperParamIndexes("INSERT INTO app_users (id, username, email) VALUES (?1, ?2, ?3)"), null);
  assert.equal(lib.upperParamIndexes("UPDATE documents SET file_name=?1, category=?2 WHERE id=?3"), null);
  assert.equal(lib.upperParamIndexes("SELECT id FROM supply_categories WHERE name=?1"), null);
});

test("lista não tem colunas proibidas (login, senha, e-mail, PIX, ids, status, arquivos)", () => {
  const forbidden = /(^|_)(id|username|email|password|pix_key|status|kind|type|key|url|link|file_name|r2_key|json|date|at|cents)$/;
  for (const [table, columns] of Object.entries(lib.UPPER_TEXT_COLUMNS)) {
    for (const column of columns) assert.doesNotMatch(column, forbidden, `${table}.${column}`);
  }
});

test("rota grava texto livre em maiúsculas e preserva PIX, tipo e ids", async () => {
  const create = (body) =>
    callRoute(accounts.POST, ADMIN, "POST", "/api/finance/accounts", { companyId: "criomar01", companyName: "Riomar", ...body });
  const response = await create({
    name: "conta caixa ção", type: "cash", holderName: "joão da silva", notes: "observação",
    pixKeyType: "email", pixKey: "Fin@Unigames.com.br",
  });
  assert.equal(response.status, 201);
  const row = db.sqlite.prepare("SELECT * FROM finance_accounts").get();
  assert.equal(row.name, "CONTA CAIXA ÇÃO");
  assert.equal(row.company_name, "RIOMAR");
  assert.equal(row.holder_name, "JOÃO DA SILVA");
  assert.equal(row.notes, "OBSERVAÇÃO");
  assert.equal(row.company_id, "criomar01");
  assert.equal(row.type, "cash");
  assert.equal(row.pix_key, "Fin@Unigames.com.br");
  assert.equal(row.pix_key_type, "email");

  // Duplicidade não depende de como foi digitado.
  assert.equal((await create({ name: "Conta Caixa Ção", type: "cash" })).status, 409);
});

test("shared_state: lojas e tarefas em maiúsculas, ids/e-mail/status intactos", async () => {
  const put = (key, value) =>
    callRoute(sharedState.PUT, ADMIN, "PUT", "/api/shared-state", { key, value: JSON.stringify(value) });
  await put("companies_list", [{ id: "criomar01", name: "Riomar", legalName: "uni games ltda", email: "loja@x.com", cnpj: "11.222.333/0001-81" }]);
  const [company] = JSON.parse(db.sqlite.prepare("SELECT value_json FROM shared_state WHERE state_key='companies_list'").get().value_json);
  assert.deepEqual(company, { id: "criomar01", name: "RIOMAR", legalName: "UNI GAMES LTDA", email: "loja@x.com", cnpj: "11.222.333/0001-81" });

  await put("tarefas:2026-10-18", { tasks: [{ id: "t1", text: "ligar pro fornecedor", priority: "high" }] });
  const tasks = JSON.parse(db.sqlite.prepare("SELECT value_json FROM shared_state WHERE state_key LIKE 'tarefas:%'").get().value_json);
  assert.deepEqual(tasks.tasks[0], { id: "t1", text: "LIGAR PRO FORNECEDOR", priority: "high" });

  // Outras chaves (estoque, relatórios importados) não mudam.
  await put("products_catalog", [{ code: "abc", name: "Controle" }]);
  assert.match(db.sqlite.prepare("SELECT value_json FROM shared_state WHERE state_key='products_catalog'").get().value_json, /Controle/);
});

test("HTML: caixa alta global na tela/PDF, canvas e .txt; exceções de login/e-mail/PIX", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.match(html, /font-size:15px;\s*text-transform:uppercase;/, "body em caixa alta");
  assert.match(html, /input, textarea, input::placeholder, textarea::placeholder\{ text-transform:uppercase; \}/);
  assert.match(html, /input\[type=password\][^{]*input\[id\*=pix i\][^{]*\{ text-transform:none; \}/);
  // Só a exceção acima pode desligar a caixa alta.
  assert.equal(html.match(/text-transform:\s*none/g).length, 1);
  assert.match(html, /\['fillText','strokeText','measureText'\]/, "texto do canvas em maiúsculas");
  assert.match(html, /window\.Blob = class extends NativeBlob/, ".txt baixado em maiúsculas");
  assert.match(html, /const text = aopWhatsText\(\)\.toLocaleUpperCase\('pt-BR'\);/, "texto do WhatsApp em maiúsculas");
});
