import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// Carrega as rotas reais de /api/assistencia trocando só o getD1() por um
// SQLite em memória (compatível com a API do D1, inclusive batch()). O seed
// da tabela de valores vem do INSERT da própria migration 0078.
const hooks = `
const DB_STUB = "export async function getD1() { return globalThis.__assistTestDb; }";
export async function resolve(specifier, context, next) {
  if (/^(\\.\\.\\/)+db$/.test(specifier) && context.parentURL && context.parentURL.includes("/app/api/assistencia/")) {
    return { url: "data:text/javascript," + encodeURIComponent(DB_STUB), shortCircuit: true };
  }
  if (specifier.startsWith(".") && !/\\.[cm]?[jt]s$/.test(specifier) && context.parentURL?.startsWith("file:")) {
    try {
      return await next(specifier + ".ts", context);
    } catch {
      // segue para a resolução normal
    }
  }
  return next(specifier, context);
}
`;
register("data:text/javascript," + encodeURIComponent(hooks));

const STORE_A = "criomar01";
const STORE_B = "cguarar01";

const migration = await readFile(new URL("../drizzle/0078_assistencia_orcamentos.sql", import.meta.url), "utf8");
const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");

function createFakeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE shared_state (state_key text PRIMARY KEY, value_json text NOT NULL);
    CREATE TABLE assist_defects (
      id text PRIMARY KEY, category text NOT NULL, device text NOT NULL, name text NOT NULL,
      min_cents integer DEFAULT 0 NOT NULL, max_cents integer DEFAULT 0 NOT NULL, quote_only integer DEFAULT 0 NOT NULL,
      active integer DEFAULT 1 NOT NULL, sort_order integer DEFAULT 0 NOT NULL,
      created_by text DEFAULT '' NOT NULL, created_by_name text DEFAULT '' NOT NULL, created_at text DEFAULT '' NOT NULL,
      updated_by text DEFAULT '' NOT NULL, updated_by_name text DEFAULT '' NOT NULL, updated_at text DEFAULT '' NOT NULL
    );
    CREATE UNIQUE INDEX assist_defects_device_name_idx ON assist_defects (device, name);
    CREATE TABLE assist_quotes (
      id text PRIMARY KEY, os_number text NOT NULL, company_id text NOT NULL, company_name text DEFAULT '' NOT NULL,
      entry_date text NOT NULL, client_name text NOT NULL, client_cpf text DEFAULT '' NOT NULL,
      client_phone text DEFAULT '' NOT NULL, client_address text DEFAULT '' NOT NULL, observations text DEFAULT '[]' NOT NULL,
      extra_notes text DEFAULT '' NOT NULL, total_cents integer DEFAULT 0 NOT NULL,
      created_by text DEFAULT '' NOT NULL, created_by_name text DEFAULT '' NOT NULL, created_at text NOT NULL,
      updated_by text DEFAULT '' NOT NULL, updated_by_name text DEFAULT '' NOT NULL, updated_at text NOT NULL
    );
    CREATE UNIQUE INDEX assist_quotes_os_number_idx ON assist_quotes (os_number);
    CREATE TABLE assist_quote_items (
      id text PRIMARY KEY, quote_id text NOT NULL, equipment_index integer DEFAULT 1 NOT NULL,
      category text DEFAULT '' NOT NULL, device text DEFAULT '' NOT NULL, serial_number text DEFAULT '' NOT NULL,
      service text DEFAULT '' NOT NULL, defect_name text DEFAULT '' NOT NULL, description text DEFAULT '' NOT NULL,
      quantity integer DEFAULT 1 NOT NULL, unit_cents integer DEFAULT 0 NOT NULL, sort_order integer DEFAULT 0 NOT NULL
    );
  `);
  // Seed exatamente como está na migration (o INSERT é SQL válido nos dois bancos).
  const seed = migration.split("--> statement-breakpoint").map((part) => part.trim()).filter((part) => part.startsWith("INSERT INTO"));
  assert.equal(seed.length, 1, "a migration tem um INSERT de seed");
  sqlite.exec(seed[0]);
  sqlite
    .prepare("INSERT INTO shared_state (state_key, value_json) VALUES ('companies_list', ?)")
    .run(JSON.stringify([
      { id: STORE_A, name: "RIOMAR", legalName: "Unigames", cnpj: "59.502.647/0001-64", phone: "(81) 3020-3183", address: "Av. República do Líbano, 251" },
      { id: STORE_B, name: "GUARARAPES", legalName: "Unigames", cnpj: "23.189.383/0001-93", phone: "(81) 3080-2343", address: "Av. Barreto de Menezes, 800" },
    ]));

  function statement(text) {
    // node:sqlite antigo (Node 22.13 do CI) não liga parâmetros posicionais
    // a placeholders "?1": converte para "?" na ordem de uso.
    const order = [];
    const sql = text.replace(/\?(\d+)/g, (_match, index) => {
      order.push(Number(index) - 1);
      return "?";
    });
    let params = [];
    const prepared = {
      bind(...values) {
        params = order.length ? order.map((index) => values[index]) : values;
        return prepared;
      },
      execute() {
        return sqlite.prepare(sql).run(...params);
      },
      async run() {
        prepared.execute();
        return { success: true };
      },
      async first() {
        return sqlite.prepare(sql).get(...params) ?? null;
      },
      async all() {
        return { results: sqlite.prepare(sql).all(...params) };
      },
    };
    return prepared;
  }

  return {
    sqlite,
    prepare: statement,
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        for (const item of statements) item.execute();
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
      return statements.map(() => ({ success: true }));
    },
  };
}

const db = createFakeD1();
globalThis.__assistTestDb = db;

const quotesRoute = await import("../app/api/assistencia/quotes/route.ts");
const quoteRoute = await import("../app/api/assistencia/quotes/[id]/route.ts");
const defectsRoute = await import("../app/api/assistencia/defects/route.ts");
const lib = await import("../app/lib/assistencia.ts");

const BASE = "http://127.0.0.1/api/assistencia";

// Login de loja (RIOMAR) com a permissão: cria para OUTRA loja e vê todas.
const STORE_USER = { id: "atendente", companyId: STORE_A, permissions: ["assistencia:manage"] };
const NO_STORE_USER = { id: "tecnico", companyId: "", permissions: ["assistencia:manage"] };
const STORE_LOGIN = { id: "loja-riomar", companyId: STORE_A, permissions: ["outputs:view", "outputs:create", "divergencias:create"] };

function headersFor(user, extra = {}) {
  return {
    "x-unigames-user-id": user.id,
    "x-unigames-display-name": encodeURIComponent(user.name || user.id.toUpperCase()),
    "x-unigames-role": user.role || "user",
    "x-unigames-company-id": user.companyId || "",
    "x-unigames-sector": user.sector || "",
    "x-unigames-permissions": (user.permissions || []).join(","),
    "sec-fetch-site": "same-origin",
    ...extra,
  };
}

async function call(handler, user, { method = "GET", path = "", body, params, headers } = {}) {
  const request = new Request(`${BASE}${path}`, {
    method,
    headers: { ...headersFor(user, headers), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const response = await handler(request, params ? { params: Promise.resolve(params) } : undefined);
  return { status: response.status, body: await response.json() };
}

const getQuotes = (user, query = "") => call(quotesRoute.GET, user, { path: `/quotes${query}` });
const createQuote = (user, body) => call(quotesRoute.POST, user, { method: "POST", path: "/quotes", body });
const getQuote = (user, id) => call(quoteRoute.GET, user, { path: `/quotes/${id}`, params: { id } });
const patchQuote = (user, id, body) => call(quoteRoute.PATCH, user, { method: "PATCH", path: `/quotes/${id}`, params: { id }, body });
const deleteQuote = (user, id) => call(quoteRoute.DELETE, user, { method: "DELETE", path: `/quotes/${id}`, params: { id } });
const getDefects = (user) => call(defectsRoute.GET, user, { path: "/defects" });
const postDefect = (user, body) => call(defectsRoute.POST, user, { method: "POST", path: "/defects", body });
const patchDefect = (user, body) => call(defectsRoute.PATCH, user, { method: "PATCH", path: "/defects", body });

function quote(overrides = {}) {
  return {
    companyId: STORE_B,
    osNumber: "22403",
    entryDate: "2026-10-03",
    clientName: "Maria da Silva",
    clientPhone: "(81) 99999-1234",
    clientCpf: "",
    clientAddress: "Rua A, 10",
    observations: ["garantia"],
    extraNotes: "",
    equipments: [
      {
        category: "CONSOLES",
        device: "PS5 PRO",
        serialNumber: "abc123",
        service: "Troca do SSD",
        lines: [
          { defectName: "SUPERAQUECIMENTO", description: "", quantity: 1, unitCents: 120000 },
          { defectName: "PREVENTIVA", description: "", quantity: 1, unitCents: 40000 },
        ],
      },
      {
        category: "CONTROLES",
        device: "CONTROLE PS5",
        serialNumber: "",
        service: "",
        lines: [
          { defectName: "ANALÓGICO EXTERNO (PAR)", description: "", quantity: 2, unitCents: 8000 },
          { defectName: "", description: "Capa de silicone", quantity: 1, unitCents: 3500 },
        ],
      },
    ],
    // Total enviado pelo navegador é ignorado: o servidor recalcula.
    totalCents: 1,
    ...overrides,
  };
}

const itemCount = (quoteId) => db.sqlite.prepare("SELECT COUNT(*) AS n FROM assist_quote_items WHERE quote_id=?").get(quoteId).n;

test("seed da tabela de valores (migration 0078)", async () => {
  const defects = (await getDefects(NO_STORE_USER)).body.defects;
  assert.equal(defects.length, 233);
  const find = (device, name) => defects.find((defect) => defect.device === device && defect.name === name);
  // PS5 SLIM "NÃO LIGA" = 1000/1500
  assert.deepEqual(
    { min: find("PS5 SLIM", "NÃO LIGA").minCents, max: find("PS5 SLIM", "NÃO LIGA").maxCents, quoteOnly: find("PS5 SLIM", "NÃO LIGA").quoteOnly },
    { min: 100000, max: 150000, quoteOnly: false },
  );
  // "ORÇ" = sob orçamento (quote_only 1, sem valor)
  const orc = find("PS5 PRO", "NÃO LIGA");
  assert.equal(orc.quoteOnly, true);
  assert.equal(orc.minCents, 0);
  assert.equal(db.sqlite.prepare("SELECT quote_only AS q FROM assist_defects WHERE device='PS5 PRO' AND name='SSD'").get().q, 1);
  // Valor único = mínimo e máximo iguais
  assert.deepEqual([find("PS5 PRO", "PREVENTIVA").minCents, find("PS5 PRO", "PREVENTIVA").maxCents], [40000, 40000]);
  // "X" não é cadastrado
  assert.equal(find("NINTENDO SWITCH LITE", "DOCK"), undefined);
  assert.equal(find("NINTENDO SWITCH LITE", "PAREAMENTO"), undefined);
  assert.ok(find("NINTENDO SWITCH OLED", "DOCK"));
  // und/par = dois defeitos
  assert.equal(find("CONTROLE PS4", "ANALÓGICO EXTERNO (UND)").minCents, 3000);
  assert.equal(find("CONTROLE PS4", "ANALÓGICO EXTERNO (PAR)").minCents, 5000);
  // Hall effect do Series S/X: só por unidade
  assert.ok(find("CONTROLE XBOX SERIES S/X", "HALL EFFECT (UND)"));
  assert.equal(find("CONTROLE XBOX SERIES S/X", "HALL EFFECT (PAR)"), undefined);
  // Contagem por aparelho (relatório do seed)
  const counts = Object.fromEntries(
    db.sqlite.prepare("SELECT device, COUNT(*) AS n FROM assist_defects GROUP BY device").all().map((row) => [row.device, row.n]),
  );
  assert.equal(counts["PS3 SLIM"], 8);
  assert.equal(counts["PS4 PRO"], 9);
  assert.equal(counts["PS5 SLIM"], 9);
  assert.equal(counts["NINTENDO SWITCH LITE"], 7);
  assert.equal(counts["JOY-CON"], 12);
  assert.equal(counts["CONTROLE XBOX SERIES S/X"], 11);
  assert.equal(counts["PC GAMER"], 5);
  // Todos em CAIXA ALTA e nas 3 categorias
  for (const defect of defects) {
    assert.equal(defect.name, defect.name.toLocaleUpperCase("pt-BR"));
    assert.ok(lib.ASSIST_CATEGORIES.includes(defect.category));
  }
});

let firstId = "";

test("criar: loja vinculada + permissão cria para OUTRA loja; total recalculado no servidor", async () => {
  const created = await createQuote(STORE_USER, quote());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  firstId = created.body.id;
  // 120000 + 2×8000 + 3500 (a PREVENTIVA de 40000 entra como desconto)
  assert.equal(created.body.totalCents, 139500);
  const row = db.sqlite.prepare("SELECT * FROM assist_quotes WHERE id=?").get(firstId);
  assert.equal(row.total_cents, 139500);
  assert.equal(row.company_id, STORE_B);
  assert.equal(row.company_name, "GUARARAPES");
  assert.equal(row.client_name, "MARIA DA SILVA");
  assert.equal(row.client_phone, "81999991234");
  assert.equal(itemCount(firstId), 4);
  // Observação gravada como cópia (título + texto), não só a chave.
  const observations = JSON.parse(row.observations);
  assert.deepEqual(observations.map((item) => item.title), ["GARANTIA"]);
  assert.match(observations[0].text, /90 dias pelo CDC/);
});

test("OS duplicada → 409 com mensagem clara (também com espaços), inclusive ao editar", async () => {
  const again = await createQuote(NO_STORE_USER, quote({ companyId: STORE_A, osNumber: " 22403 " }));
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "JÁ EXISTE UM ORÇAMENTO COM A OS 22403.");
  const other = await createQuote(NO_STORE_USER, quote({ companyId: STORE_A, osNumber: "22204", entryDate: "2026-09-10", clientName: "João Souza" }));
  assert.equal(other.status, 201);
  const clash = await patchQuote(NO_STORE_USER, other.body.id, quote({ osNumber: "22403" }));
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error, "JÁ EXISTE UM ORÇAMENTO COM A OS 22403.");
  // A mesma OS no próprio orçamento continua valendo.
  const same = await patchQuote(NO_STORE_USER, other.body.id, quote({ companyId: STORE_A, osNumber: "22204", entryDate: "2026-09-10", clientName: "João Souza" }));
  assert.equal(same.status, 200);
});

test("histórico: TODAS as lojas para quem tem loja vinculada, com busca e filtros", async () => {
  const all = await getQuotes(STORE_USER);
  assert.equal(all.status, 200);
  assert.deepEqual(new Set(all.body.quotes.map((item) => item.companyId)), new Set([STORE_A, STORE_B]));
  const first = all.body.quotes.find((item) => item.id === firstId);
  assert.deepEqual(first.devices, ["PS5 PRO", "CONTROLE PS5"]);
  assert.equal(first.totalCents, 139500);
  assert.equal(first.observations, undefined);
  assert.deepEqual((await getQuotes(STORE_USER, "?q=maria")).body.quotes.map((item) => item.osNumber), ["22403"]);
  assert.deepEqual((await getQuotes(STORE_USER, "?q=2220")).body.quotes.map((item) => item.osNumber), ["22204"]);
  assert.deepEqual((await getQuotes(STORE_USER, `?companyId=${STORE_A}`)).body.quotes.map((item) => item.osNumber), ["22204"]);
  assert.deepEqual((await getQuotes(STORE_USER, "?from=2026-10-01&to=2026-10-31")).body.quotes.map((item) => item.osNumber), ["22403"]);
  assert.deepEqual((await getQuotes(STORE_USER, "?q=%25")).body.quotes, []);
});

test("403 sem assistencia:manage (inclusive login de loja) e escrita só da mesma origem", async () => {
  const forbidden = "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR A ASSISTÊNCIA.";
  for (const response of [
    await getQuotes(STORE_LOGIN),
    await createQuote(STORE_LOGIN, quote({ osNumber: "90001" })),
    await getQuote(STORE_LOGIN, firstId),
    await patchQuote(STORE_LOGIN, firstId, quote()),
    await deleteQuote(STORE_LOGIN, firstId),
    await getDefects(STORE_LOGIN),
    await postDefect(STORE_LOGIN, { category: "CONSOLES", device: "PS5 SLIM", name: "TESTE", minCents: 100 }),
    await patchDefect(STORE_LOGIN, { id: "assist-seed-001", name: "X", minCents: 1 }),
  ]) {
    assert.equal(response.status, 403);
    assert.equal(response.body.error, forbidden);
  }
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM assist_quotes WHERE os_number='90001'").get().n, 0);
  const crossSite = await call(quotesRoute.POST, NO_STORE_USER, {
    method: "POST", path: "/quotes", body: quote({ osNumber: "90002" }), headers: { "sec-fetch-site": "cross-site" },
  });
  assert.equal(crossSite.status, 403);
  // Admin sempre pode.
  assert.equal((await getQuotes({ id: "admin", role: "admin", permissions: [] })).status, 200);
});

test("validação: diz o que falta", async () => {
  const cases = [
    [{ companyId: "" }, "ESCOLHA A LOJA."],
    [{ companyId: "cnaoexiste1" }, "LOJA NÃO ENCONTRADA."],
    [{ osNumber: "" }, "INFORME O Nº DA OS."],
    [{ clientPhone: "9999" }, "INFORME O TELEFONE DO CLIENTE COM DDD."],
    [{ clientCpf: "111.111.111-11" }, "CPF DO CLIENTE INVÁLIDO."],
    [{ equipments: [] }, "INCLUA PELO MENOS UM EQUIPAMENTO."],
    [{ equipments: [{ category: "CONSOLES", device: "PS5 PRO", lines: [] }] }, "EQUIPAMENTO 1: INCLUA PELO MENOS UM DEFEITO OU ITEM AVULSO."],
    // "Sob orçamento" sem valor digitado
    [{ equipments: [{ category: "CONSOLES", device: "PS5 PRO", lines: [{ defectName: "NÃO LIGA", quantity: 1, unitCents: null }] }] },
      "EQUIPAMENTO 1 · NÃO LIGA: INFORME O VALOR UNITÁRIO."],
    [{ equipments: [{ category: "CONSOLES", device: "PS5 PRO", lines: [{ defectName: "", description: "", quantity: 1, unitCents: 100 }] }] },
      "EQUIPAMENTO 1 · ITEM 1: DESCREVA O ITEM AVULSO."],
  ];
  for (const [overrides, message] of cases) {
    const response = await createQuote(NO_STORE_USER, quote({ osNumber: "70001", ...overrides }));
    assert.equal(response.status, 400, message);
    assert.equal(response.body.error, message);
  }
  // CPF válido é aceito e gravado só com dígitos.
  const ok = await createQuote(NO_STORE_USER, quote({ osNumber: "70001", clientCpf: "529.982.247-25" }));
  assert.equal(ok.status, 201);
  assert.equal(db.sqlite.prepare("SELECT client_cpf AS cpf FROM assist_quotes WHERE id=?").get(ok.body.id).cpf, "52998224725");
  assert.equal((await deleteQuote(NO_STORE_USER, ok.body.id)).status, 200);
});

test("editar orçamento com vários equipamentos e defeitos (regressão do React #31) e excluir", async () => {
  const detail = await getQuote(STORE_USER, firstId);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.quote.osNumber, "22403");
  assert.equal(detail.body.equipments.length, 2);
  // Tudo que a tela exibe chega como texto/número, nunca objeto.
  for (const equipment of detail.body.equipments) {
    for (const key of ["category", "device", "serialNumber", "service"]) assert.equal(typeof equipment[key], "string");
    for (const line of equipment.lines) {
      assert.equal(typeof line.defectName, "string");
      assert.equal(typeof line.description, "string");
      assert.equal(typeof line.quantity, "number");
      assert.equal(typeof line.unitCents, "number");
    }
  }
  assert.deepEqual(detail.body.equipments[1].lines.map((line) => line.defectName), ["ANALÓGICO EXTERNO (PAR)", ""]);
  assert.equal(detail.body.equipments[1].subtotalCents, 19500);
  assert.equal(detail.body.quote.observations[0].title, "GARANTIA");

  // Reenvia o que veio do GET (mesmo formato), troca loja, adiciona um
  // terceiro equipamento e muda valores.
  const edited = {
    ...detail.body.quote,
    companyId: STORE_A,
    observations: ["preventiva", "novos_defeitos"],
    equipments: [
      ...detail.body.equipments.map((equipment) => ({
        ...equipment,
        lines: equipment.lines.map((line) => ({ ...line, unitCents: line.unitCents + 100 })),
      })),
      {
        category: "CONSOLES", device: "NINTENDO SWITCH LITE", serialNumber: "XKJ", service: "",
        lines: [{ defectName: "DISPLAY", description: "Tela original", quantity: 1, unitCents: 45000 }],
      },
    ],
  };
  const patched = await patchQuote(NO_STORE_USER, firstId, edited);
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  // 120100 (PREVENTIVA 40100 vira desconto) + (2×8100 + 3600) + 45000
  assert.equal(patched.body.totalCents, 184900);
  assert.equal(itemCount(firstId), 5);
  const after = await getQuote(STORE_USER, firstId);
  assert.equal(after.body.quote.companyName, "RIOMAR");
  assert.equal(after.body.quote.totalCents, 184900);
  assert.deepEqual(after.body.quote.observations.map((item) => item.key), ["preventiva", "novos_defeitos"]);
  assert.deepEqual(after.body.equipments.map((equipment) => equipment.device), ["PS5 PRO", "CONTROLE PS5", "NINTENDO SWITCH LITE"]);
  assert.equal(after.body.equipments[2].lines[0].description, "Tela original");
  assert.equal(after.body.quote.updatedByName, "TECNICO");

  // Mudar a tabela de valores NÃO altera o orçamento salvo.
  const seedRow = db.sqlite.prepare("SELECT id FROM assist_defects WHERE device='PS5 PRO' AND name='PREVENTIVA'").get();
  assert.equal((await patchDefect(NO_STORE_USER, { id: seedRow.id, name: "PREVENTIVA COMPLETA", minCents: 50000, maxCents: 60000 })).status, 200);
  const untouched = await getQuote(STORE_USER, firstId);
  assert.equal(untouched.body.equipments[0].lines[1].defectName, "PREVENTIVA");
  assert.equal(untouched.body.equipments[0].lines[1].unitCents, 40100);

  const removed = await deleteQuote(STORE_USER, firstId);
  assert.equal(removed.status, 200);
  assert.equal((await getQuote(STORE_USER, firstId)).status, 404);
  assert.equal(itemCount(firstId), 0);
  // Sem a OS antiga, ela pode ser usada de novo.
  assert.equal((await createQuote(STORE_USER, quote())).status, 201);
});

test("tabela de valores: criar, duplicado, categoria do aparelho, editar e desativar (sem excluir)", async () => {
  const created = await postDefect(NO_STORE_USER, { category: "CONSOLES", device: "ps5 slim", name: "troca de cooler", minCents: 30000, maxCents: "" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const row = db.sqlite.prepare("SELECT * FROM assist_defects WHERE id=?").get(created.body.id);
  assert.equal(row.device, "PS5 SLIM");
  assert.equal(row.name, "TROCA DE COOLER");
  assert.deepEqual([row.min_cents, row.max_cents, row.quote_only, row.active], [30000, 30000, 0, 1]);
  assert.equal(row.sort_order, 234);

  const duplicate = await postDefect(NO_STORE_USER, { category: "CONSOLES", device: "PS5 SLIM", name: "NÃO LIGA", minCents: 1 });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error, "O DEFEITO NÃO LIGA JÁ EXISTE PARA O APARELHO PS5 SLIM.");
  const wrongCategory = await postDefect(NO_STORE_USER, { category: "CONTROLES", device: "PS5 SLIM", name: "OUTRO", minCents: 1 });
  assert.equal(wrongCategory.status, 400);
  assert.equal(wrongCategory.body.error, "O APARELHO PS5 SLIM JÁ ESTÁ NA CATEGORIA CONSOLES.");
  const noValue = await postDefect(NO_STORE_USER, { category: "CONSOLES", device: "PS5 SLIM", name: "OUTRO" });
  assert.equal(noValue.status, 400);
  assert.equal(noValue.body.error, "INFORME O VALOR MÍNIMO (OU MARQUE SOB ORÇAMENTO).");
  const quoteOnly = await postDefect(NO_STORE_USER, { category: "NOTEBOOKS E COMPUTADORES", device: "MACBOOK", name: "TELA", quoteOnly: true });
  assert.equal(quoteOnly.status, 201);

  const inverted = await patchDefect(NO_STORE_USER, { id: created.body.id, name: "TROCA DE COOLER", minCents: 50000, maxCents: 40000 });
  assert.equal(inverted.status, 400);
  assert.equal(inverted.body.error, "O VALOR MÁXIMO NÃO PODE SER MENOR QUE O MÍNIMO.");
  const rename = await patchDefect(NO_STORE_USER, { id: created.body.id, name: "não liga", minCents: 1 });
  assert.equal(rename.status, 409);
  const off = await patchDefect(NO_STORE_USER, { id: created.body.id, name: "Troca de cooler", quoteOnly: true, active: false });
  assert.equal(off.status, 200);
  const defects = (await getDefects(NO_STORE_USER)).body.defects;
  const updated = defects.find((defect) => defect.id === created.body.id);
  assert.deepEqual(
    { name: updated.name, quoteOnly: updated.quoteOnly, active: updated.active, min: updated.minCents },
    { name: "TROCA DE COOLER", quoteOnly: true, active: false, min: 0 },
  );
  assert.equal(defectsRoute.DELETE, undefined);
  assert.equal((await patchDefect(NO_STORE_USER, { id: "nao-existe", name: "X1", minCents: 1 })).status, 404);
});

test("textos padrão das observações iguais no servidor e na tela", () => {
  for (const observation of lib.ASSIST_OBSERVATIONS) {
    assert.ok(
      html.includes(`{key:'${observation.key}', title:'${observation.title}', text:'${observation.text}'}`),
      `observação ${observation.key} igual em public/estoque.html`,
    );
  }
  assert.equal(lib.normalizeOsNumber(" 22 403 "), "22403");
  assert.equal(lib.quoteTotal([{ lines: [{ quantity: 2, unitCents: 150 }, { quantity: 1, unitCents: 1 }] }]), 301);
});

test("preventiva da tabela entra como DESCONTO quando há outro serviço no equipamento", async () => {
  const ps3 = (lines) => quote({
    osNumber: `P${lines.length}${lines[0].defectName.length}`,
    equipments: [{ category: "CONSOLES", device: "PS3 SLIM", serialNumber: "", service: "", lines }],
  });
  const naoLiga = { defectName: "NÃO LIGA", description: "", quantity: 1, unitCents: 45000 };
  const preventiva = { defectName: "PREVENTIVA", description: "", quantity: 1, unitCents: 15000 };
  // NÃO LIGA + PREVENTIVA → só o NÃO LIGA soma.
  const both = await createQuote(NO_STORE_USER, ps3([naoLiga, preventiva]));
  assert.equal(both.status, 201, JSON.stringify(both.body));
  assert.equal(both.body.totalCents, 45000);
  const detail = await getQuote(NO_STORE_USER, both.body.id);
  assert.equal(detail.body.equipments[0].subtotalCents, 45000);
  assert.equal(detail.body.equipments[0].lines[1].unitCents, 15000);
  // Preventiva sozinha é cobrada.
  const alone = await createQuote(NO_STORE_USER, ps3([preventiva]));
  assert.equal(alone.body.totalCents, 15000);
  // "MANUTENÇÃO PREVENTIVA" (computadores) segue a mesma regra; o desconto é por equipamento.
  assert.equal(lib.quoteTotal([
    { lines: [{ defectName: "FORMATAÇÃO", quantity: 1, unitCents: 25000 }, { defectName: "MANUTENÇÃO PREVENTIVA", quantity: 1, unitCents: 25000 }] },
    { lines: [{ defectName: "PREVENTIVA", quantity: 1, unitCents: 15000 }] },
  ]), 40000);
});
