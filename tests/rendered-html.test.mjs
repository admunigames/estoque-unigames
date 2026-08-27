import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const env = {
  APP_LOGIN_USER: "unigames",
  APP_LOGIN_PASSWORD: "senha-de-teste-forte",
  APP_SESSION_SECRET: "segredo-de-teste-com-mais-de-32-caracteres",
  ASSETS: {
    fetch: async () => new Response("Not found", { status: 404 }),
  },
};

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
};

async function worker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  return (await import(workerUrl.href)).default;
}

function extractNamedFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `função ${name} não encontrada`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}") depth--;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`função ${name} incompleta`);
}

test("redireciona visitantes sem sessão para o login", async () => {
  const response = await (await worker()).fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    env,
    ctx,
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "http://localhost/login?next=%2F");
});

test("renderiza a tela de login sem expor a senha", async () => {
  const response = await (await worker()).fetch(
    new Request("http://localhost/login"),
    env,
    ctx,
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Entrar · Unigames/);
  assert.match(html, /name="username"/);
  assert.match(html, /name="password"/);
  assert.match(html, /class="login-shell"/);
  assert.match(html, /class="tech-core"/);
  assert.match(html, /class="unigames-emblem"/);
  assert.match(html, /src="\/unigames-logo\.png"/);
  assert.match(html, /Canal seguro ativo/);
  assert.match(html, /prefers-reduced-motion:reduce/);
  assert.doesNotMatch(html, /UNIGAMES \/\/ CORE/);
  assert.doesNotMatch(html, /Central de Operações/);
  assert.doesNotMatch(html, /Núcleo operacional conectado/);
  assert.doesNotMatch(html, /Controle tudo\./);
  assert.doesNotMatch(html, /Em um só lugar\./);
  assert.doesNotMatch(html, /senha-de-teste-forte/);
});

test("mantém a recuperação de senha alinhada à identidade tecnológica", async () => {
  const response = await (await worker()).fetch(
    new Request("http://localhost/recuperar-senha"),
    env,
    ctx,
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Recuperar senha · Central Unigames/);
  assert.match(html, /UNIGAMES \/\/ ACCESS/);
  assert.match(html, /class="recovery-orbit"/);
  assert.match(html, /name="username"/);
  assert.match(html, /Solicitação protegida/);
});

test("serve a logo Unigames na tela pública de acesso", async () => {
  let requestedPath = "";
  const logoEnv = {
    ...env,
    ASSETS: {
      fetch: async (request) => {
        requestedPath = new URL(request.url).pathname;
        return new Response("logo", { status: 200 });
      },
    },
  };
  const response = await (await worker()).fetch(
    new Request("http://localhost/unigames-logo.png"),
    logoEnv,
    ctx,
  );
  assert.equal(response.status, 200);
  assert.equal(requestedPath, "/unigames-logo.png");
});

test("recusa credenciais inválidas", async () => {
  const response = await (await worker()).fetch(
    new Request("http://localhost/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "unigames", password: "errada" }),
    }),
    env,
    ctx,
  );
  assert.equal(response.status, 401);
  assert.match(await response.text(), /Usuário ou senha inválidos/);
});

test("cria uma sessão assinada com credenciais válidas", async () => {
  const runtime = await worker();
  const login = await runtime.fetch(
    new Request("http://localhost/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: "unigames",
        password: "senha-de-teste-forte",
        next: "/",
      }),
    }),
    env,
    ctx,
  );
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("location"), "/inicio?entrada=1");
  const setCookie = login.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /^unigames_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);

  const cookie = setCookie.split(";")[0];
  const protectedResponse = await runtime.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html", cookie },
    }),
    env,
    ctx,
  );
  assert.notEqual(protectedResponse.headers.get("location"), "http://localhost/login?next=%2F");
});

test("bloqueia alterações enviadas por outra origem", async () => {
  const runtime = await worker();
  const login = await runtime.fetch(
    new Request("http://localhost/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: "unigames",
        password: "senha-de-teste-forte",
      }),
    }),
    env,
    ctx,
  );
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  const apiResponse = await runtime.fetch(
    new Request("http://localhost/api/preferences", {
      method: "PUT",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: "https://site-malicioso.example",
      },
      body: JSON.stringify({ theme: "light" }),
    }),
    env,
    ctx,
  );
  assert.equal(apiResponse.status, 403);
  assert.match(await apiResponse.text(), /ORIGEM DA SOLICITAÇÃO NÃO PERMITIDA/);

  const logoutResponse = await runtime.fetch(
    new Request("http://localhost/logout", {
      method: "POST",
      headers: { cookie, "sec-fetch-site": "cross-site" },
    }),
    env,
    ctx,
  );
  assert.equal(logoutResponse.status, 403);
});

test("aceita o login same-origin quando a hospedagem usa um endereço interno", async () => {
  const runtime = await worker();
  const response = await runtime.fetch(
    new Request("https://worker-interno.example/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://estoque-unigames-compras.admunigames.chatgpt.site",
        "sec-fetch-site": "same-origin",
        "x-forwarded-host": "estoque-unigames-compras.admunigames.chatgpt.site",
        "x-forwarded-proto": "https",
      },
      body: new URLSearchParams({
        username: "unigames",
        password: "senha-de-teste-forte",
      }),
    }),
    env,
    ctx,
  );

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/inicio?entrada=1");
  assert.match(response.headers.get("set-cookie") ?? "", /unigames_session=/);
});

test("serve as rotas dos módulos sem alterar o endereço do navegador", async () => {
  const requestedAssets = [];
  const routeEnv = {
    ...env,
    ASSETS: {
      fetch: async (request) => {
        requestedAssets.push(new URL(request.url).pathname);
        return new Response("<!doctype html><title>ESTOQUE</title>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    },
  };
  const runtime = await worker();
  const login = await runtime.fetch(
    new Request("http://localhost/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: "unigames",
        password: "senha-de-teste-forte",
        next: "/cadastros/lojas",
      }),
    }),
    routeEnv,
    ctx,
  );
  assert.equal(login.headers.get("location"), "/inicio?entrada=1");
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const response = await runtime.fetch(
    new Request("http://localhost/cadastros/lojas", {
      headers: { accept: "text/html", cookie },
    }),
    routeEnv,
    ctx,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(requestedAssets, ["/estoque.html"]);
  assert.match(await response.text(), /ESTOQUE/);
});

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return Buffer.from(binary, "binary").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signSession(secret, sub, ver) {
  const payload = toBase64Url(
    Buffer.from(JSON.stringify({ sub, ver, exp: Date.now() + 12 * 60 * 60 * 1000 }), "utf8"),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(secret, "utf8"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, Buffer.from(payload, "utf8"));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

// D1 falso mínimo: guarda um único usuário em memória e responde só às
// consultas que worker/index.ts realmente executa (ensureAppUsersTable,
// readUserByUsername, readUserById). `failReads: true` simula uma falha de
// infraestrutura (ex.: pool do Postgres/Hyperdrive saturado) na consulta que
// authenticatedUser() faz a cada requisição para revalidar a sessão.
function createFakeD1(user, { failReads = false } = {}) {
  return {
    prepare(sql) {
      const statement = {
        _args: [],
        bind(...args) {
          statement._args = args;
          return statement;
        },
        async first() {
          if (sql.includes("FROM app_users WHERE id =")) {
            if (failReads) throw new Error("conexão com o banco de dados falhou");
            return statement._args[0] === user.id ? user : null;
          }
          if (sql.includes("FROM app_users WHERE lower(username)")) {
            const username = String(statement._args[0]).toLowerCase();
            return user.username.toLowerCase() === username ? user : null;
          }
          return null;
        },
        async all() {
          if (sql.includes("PRAGMA table_info")) {
            return { results: ["company_id", "hierarchy", "sector"].map((name) => ({ name })) };
          }
          return { results: [] };
        },
        async run() {
          return {};
        },
      };
      return statement;
    },
    async batch(statements) {
      return statements.map(() => ({}));
    },
  };
}

test("não trata falha de infraestrutura no banco como sessão inválida (evita loop de reload)", async () => {
  const user = {
    id: "user-real-1",
    username: "renato",
    displayName: "Renato",
    email: "",
    passwordHash: "x",
    passwordSalt: "x",
    role: "user",
    accessGroup: "custom",
    permissionsJson: "[]",
    companyId: "",
    hierarchy: "administrative",
    sector: "",
    active: 1,
    sessionVersion: 1,
    createdAt: "",
    updatedAt: "",
  };
  const cookie = `unigames_session=${await signSession(env.APP_SESSION_SECRET, user.id, user.sessionVersion)}`;

  const workingEnv = { ...env, DB: createFakeD1(user) };
  const runtime = await worker();
  const okResponse = await runtime.fetch(
    new Request("http://localhost/api/session", { headers: { accept: "application/json", cookie } }),
    workingEnv,
    ctx,
  );
  assert.equal(okResponse.status, 200);

  const brokenEnv = { ...env, DB: createFakeD1(user, { failReads: true }) };
  const brokenRuntime = await worker();
  const failingResponse = await brokenRuntime.fetch(
    new Request("http://localhost/api/session", { headers: { accept: "application/json", cookie } }),
    brokenEnv,
    ctx,
  );
  // Uma falha transitória no banco precisa virar 503 (tente de novo), nunca
  // 401 — um 401 aqui faria o cliente redirecionar para /login mesmo com a
  // sessão válida, e como GET /login manda de volta quando a sessão é válida,
  // isso gera o loop de recarregamento reportado pelo usuário.
  assert.equal(failingResponse.status, 503);
  assert.notEqual(failingResponse.status, 401);

  const failingPageResponse = await brokenRuntime.fetch(
    new Request("http://localhost/inicio", { headers: { accept: "text/html", cookie } }),
    brokenEnv,
    ctx,
  );
  assert.equal(failingPageResponse.status, 503);
  assert.equal(failingPageResponse.headers.get("location"), null);
});

test("mantém a interface sem referências quebradas ou identificadores duplicados", async () => {
  const [html, layout, workerSource, envExample] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicates)], []);

  const knownIds = new Set(ids);
  const referencedIds = [
    ...html.matchAll(/\bel\('([^']+)'\)/g),
  ].map((match) => match[1]);
  for (const id of referencedIds) {
    assert.ok(knownIds.has(id), `Referência a elemento inexistente: ${id}`);
  }

  assert.match(html, /<title>UNIGAMES<\/title>/);
  assert.match(html, /<span class="brand-copy"><strong>UNIGAMES<\/strong><\/span>/);
  assert.doesNotMatch(html, /<small>RECONCILIAÇÃO DE ESTOQUE<\/small>/);
  assert.doesNotMatch(layout, /\/og\.png/);
  assert.doesNotMatch(workerSource, /"\/og\.png"/);
  assert.match(workerSource, /mutatingApiRequest[\s\S]*sameOrigin\(request, url\)/);
  assert.match(html, /safeExternalUrl\(file\.url\)/);
  assert.match(html, /safeExternalUrl\(item\.url\)/);
  assert.match(envExample, /VAPID_PUBLIC_KEY=/);
  assert.match(envExample, /VAPID_PRIVATE_KEY=/);
  assert.match(envExample, /VAPID_SUBJECT=/);
});

test("configura o banco geral e conecta a interface à API compartilhada", async () => {
  const [hosting, html, migration] = await Promise.all([
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../drizzle-sqlite-legacy/0000_wild_magik.sql", import.meta.url), "utf8"),
  ]);

  assert.equal(JSON.parse(hosting).d1, "DB");
  assert.match(migration, /CREATE TABLE `shared_state`/);
  assert.match(html, /\/api\/shared-state/);
  assert.match(html, /BANCO GERAL ATIVO/);
  assert.match(html, /ifAbsent:true/);
});

test("gera um TXT comparativo por loja nas puxadas", async () => {
  const html = await readFile(
    new URL("../public/estoque.html", import.meta.url),
    "utf8",
  );

  assert.match(html, /<details class="purchase-division">/);
  assert.match(html, /ARQUIVOS TXT POR LOJA/);
  assert.match(html, /TXT REPOSIÇÃO/);
  assert.match(html, /TXT PUXADA/);
  assert.match(html, /const PULL_MINIMUM_STOCK = 3/);
  assert.match(html, /row\.stock < PULL_MINIMUM_STOCK/);
  assert.match(html, /allocateIntegerTargets\(storeRows, totalStock, totalSales\)/);
  assert.doesNotMatch(html, /protectedOriginCapacity/);
  assert.doesNotMatch(html, /Math\.floor\(stock \/ 3\)/);
  assert.doesNotMatch(html, /Equilibre o estoque entre as lojas usando as vendas do período/);
  assert.doesNotMatch(html, /ETAPA 01/);
  assert.doesNotMatch(html, /class="pull-flow"/);
  assert.match(html, /function pullCompanyRole\(company\)/);
  assert.match(html, /return 'assistance'/);
  assert.match(html, /return 'depot'/);
  assert.match(html, /const readyStores = pullStoreCompanies\(\)/);
  assert.match(html, /const readyDepots = pullDepotCompanies\(\)/);
  assert.match(html, /const reportType = pullTxtReportType\(storeRows\)/);
  assert.match(html, /\.\.\.storeRows\.filter\(row => row\.isDepot\)/);
  assert.match(html, /Math\.floor\(row\.sales\)/);
  assert.match(html, /DEPÓSITO.*somente com estoque físico/i);
  assert.match(html, /SOMENTE ESTOQUE/);

  const makeTxt = new Function(
    `${extractNamedFunction(html, "pullBaseLabel")}
     ${extractNamedFunction(html, "pullTxtContent")}
     return pullTxtContent;`,
  )();
  const makeFileName = new Function(
    `${extractNamedFunction(html, "pullTxtFileName")}
     return pullTxtFileName;`,
  )();
  const classifyTxt = new Function(
    `${extractNamedFunction(html, "pullTxtReportType")}
     return pullTxtReportType;`,
  )();
  const stores = [
    "UNIGAMES GUARARAPES",
    "UNIGAMES-NORTH WAY",
    "UNIGAMES-RIOMAR",
    "UNIGAMES-TACARUNA",
  ];
  const depot = "DEPÓSITO UNIGAMES";
  assert.equal(classifyTxt([{ isDepot: true, stock: 9 }]), "replenishment");
  assert.equal(classifyTxt([{ isDepot: true, stock: 0 }]), "pull");
  const comparisonCompanies = [...stores, depot];
  const product = (name, owner, stock) => ({
    nome: name,
    stocks: [owner, ...comparisonCompanies.filter((store) => store !== owner)].map((store) => ({
      store,
      group: "standard",
      stock: stock[store],
    })),
  });
  const guararapesReposicaoTxt = makeTxt({
    store: stores[0],
    type: "replenishment",
    items: [
      product("Cartas Pokemon", stores[0], {
        [stores[0]]: 0,
        [stores[1]]: 4,
        [stores[2]]: 1,
        [stores[3]]: 12,
        [depot]: 9,
      }),
    ],
  });
  const guararapesPuxadaTxt = makeTxt({
    store: stores[0],
    type: "pull",
    items: [
      product("Mouse Pad Simples", stores[0], {
        [stores[0]]: 0,
        [stores[1]]: 7,
        [stores[2]]: 2,
        [stores[3]]: 5,
        [depot]: 0,
      }),
    ],
  });
  const riomarTxt = makeTxt({
    store: stores[2],
    items: [
      product("Cartas Pokemon", stores[2], {
        [stores[0]]: 0,
        [stores[1]]: 4,
        [stores[2]]: 1,
        [stores[3]]: 12,
        [depot]: 9,
      }),
    ],
  });

  assert.equal(
    guararapesReposicaoTxt,
    "CARTAS POKEMON\r\n\r\n" +
      "Empresa: UNIGAMES GUARARAPES\r\nLocal: PADRÃO - 0\r\n\r\n" +
      "Empresa: UNIGAMES-NORTH WAY\r\nLocal: PADRÃO - 4\r\n\r\n" +
      "Empresa: UNIGAMES-RIOMAR\r\nLocal: PADRÃO - 1\r\n\r\n" +
      "Empresa: UNIGAMES-TACARUNA\r\nLocal: PADRÃO - 12\r\n\r\n" +
      "Empresa: DEPÓSITO UNIGAMES\r\nLocal: PADRÃO - 9\r\n",
  );
  assert.equal(
    guararapesPuxadaTxt,
    "MOUSE PAD SIMPLES\r\n\r\n" +
      "Empresa: UNIGAMES GUARARAPES\r\nLocal: PADRÃO - 0\r\n\r\n" +
      "Empresa: UNIGAMES-NORTH WAY\r\nLocal: PADRÃO - 7\r\n\r\n" +
      "Empresa: UNIGAMES-RIOMAR\r\nLocal: PADRÃO - 2\r\n\r\n" +
      "Empresa: UNIGAMES-TACARUNA\r\nLocal: PADRÃO - 5\r\n\r\n" +
      "Empresa: DEPÓSITO UNIGAMES\r\nLocal: PADRÃO - 0\r\n",
  );
  assert.match(
    riomarTxt,
    /^CARTAS POKEMON\r\n\r\nEmpresa: UNIGAMES-RIOMAR\r\nLocal: PADRÃO - 1\r\n\r\nEmpresa: UNIGAMES GUARARAPES/,
  );
  assert.match(riomarTxt, /Empresa: DEPÓSITO UNIGAMES\r\nLocal: PADRÃO - 9/);
  assert.equal(makeFileName({ store: stores[0], type: "pull" }), "PUXADA_UNIGAMES_GUARARAPES.txt");
  assert.equal(
    makeFileName({ store: stores[0], type: "replenishment" }),
    "REPOSICAO_UNIGAMES_GUARARAPES.txt",
  );
});

test("oferece estoque fiscal consolidado e PDF em tema claro", async () => {
  const html = await readFile(
    new URL("../public/estoque.html", import.meta.url),
    "utf8",
  );

  assert.match(
    html,
    /page-heading page-heading-dashboard[\s\S]*data-home[\s\S]*<h2 class="page-title">Estoque Fiscal<\/h2>/,
  );
  assert.match(html, /ESTOQUE FISCAL GERAL — UNIGAMES/);
  assert.match(html, /ESTOQUE FISCAL GERAL — P\.A/);
  assert.match(html, /Promise\.allSettled\(groupCompanies\.map/);
  assert.match(html, /addFiscalQuantities\(entradaMap, data\.entrada\)/);
  assert.match(html, /addFiscalQuantities\(saidaMap, data\.saida\)/);
  assert.match(html, /--bg:#fff/);
  assert.match(html, /#inventoryTable tbody tr\.neg td\{background:#fff1f0 !important/);
});

test("exporta PDF e Excel de acordo com a visão, busca e filtros atuais", async () => {
  const html = await readFile(
    new URL("../public/estoque.html", import.meta.url),
    "utf8",
  );

  assert.match(html, /<h1 id="printReportTitle">RELATÓRIO DE ESTOQUE<\/h1>/);
  assert.match(html, /function currentViewLabel\(\)/);
  assert.match(html, /function currentFilterLabels\(\)/);
  assert.match(html, /const rows = getExportRows\(\);[\s\S]*preparePrintReport\(rows\);[\s\S]*window\.print\(\);/);
  assert.match(html, /btnExcel[\s\S]*const rows = getExportRows\(\);[\s\S]*XLSX\.writeFile\(wb, exportFileBase\(\) \+ '\.xlsx'\)/);
  assert.match(html, /#inventoryTable th\.code-col,#inventoryTable td\.codigo\{display:none !important;\}/);
  assert.match(html, /#inventoryTable \.tag-zerado,#inventoryTable \.tag-alerta\{display:none !important;\}/);
  assert.match(html, /body\.pdf-export \.summary/);
});

test("filtra somente produtos com saldo negativo no dashboard e nas exportações", async () => {
  const html = await readFile(
    new URL("../public/estoque.html", import.meta.url),
    "utf8",
  );

  assert.match(html, /id="filtroNegativos"> Negativos/);
  assert.match(html, /const showNegatives = el\('filtroNegativos'\)\.checked/);
  assert.match(html, /if\(showNegatives && r\.saldo >= 0\) continue/);
  assert.match(html, /if\(el\('filtroNegativos'\)\.checked\) labels\.push\('NEGATIVOS'\)/);
  assert.match(html, /\['filtroNegativos','filtroZeroEntrada','filtroZeroSaida'\]/);
  assert.doesNotMatch(html, /id="filtroDivergencias"/);
  assert.doesNotMatch(html, /SÓ DIVERGÊNCIAS/);
  assert.match(html, /btnCsv[\s\S]*const rows = getExportRows\(\)/);
});

test("alinha os titulos à direita e mantém os cabeçalhos dentro do iPhone", async () => {
  const html = await readFile(
    new URL("../public/estoque.html", import.meta.url),
    "utf8",
  );

  assert.match(html, /\.page-title\{[\s\S]*margin:0 0 0 auto;[\s\S]*text-align:right/);
  assert.match(html, /\.page-logo\{[\s\S]*width:clamp\(46px,4\.3vw,56px\)/);
  assert.match(html, /\.page-logo \.brand-logo\{width:100%; height:100%/);
  assert.match(html, /@media \(max-width:520px\)[\s\S]*\.page-title\{[\s\S]*font-size:clamp\(14px,4\.6vw,19px\)[\s\S]*overflow-wrap:normal/);
  assert.match(html, /@media \(max-width:520px\)[\s\S]*\.page-heading\{[\s\S]*grid-template-columns:44px minmax\(0,1fr\)[\s\S]*padding-left:52px/);
  assert.match(html, /@media \(max-width:520px\)[\s\S]*\.page-logo\{[\s\S]*width:44px; height:44px/);
  assert.doesNotMatch(html, /class="page-logo"[\s\S]{0,220}<span>ESTOQUE<\/span>/);
  for (const title of ["Controle de Compras", "Puxadas", "Base de Dados", "Cadastro de Lojas"]) {
    assert.match(html, new RegExp(`<h2 class="page-title">${title}</h2>`));
  }
});

test("oferece compras em cards responsivos e filtro combinado por status", async () => {
  const [html, route] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../app/api/compras/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="purchaseStatusFilter"[\s\S]*name="purchaseStatus" value="Não iniciado"/);
  assert.match(html, /name="purchaseStatus" value="Em andamento"/);
  assert.match(html, /name="purchaseStatus" value="Concluído"/);
  assert.match(html, /function selectedPurchaseStatuses\(\)/);
  assert.match(html, /statuses\.forEach\(status => params\.append\('status', status\)\)/);
  assert.match(html, /id="purchaseCardGrid"/);
  assert.match(html, /class="purchase-card(?:\s|")/);
  assert.match(html, /class="purchase-card-dates"/);
  assert.match(html, /class="purchase-card-actions"/);
  assert.match(html, /grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,390px\),1fr\)\)/);
  assert.match(html, /el\('purchaseCardGrid'\)\.addEventListener/);
  assert.doesNotMatch(html, /class="table-panel purchase-table"/);
  assert.match(route, /searchParams[\s\S]*\.getAll\("status"\)/);
  assert.match(route, /statuses\.length > 1/);
  assert.match(route, /or: statuses\.map/);
});

test("separa compras e lembretes no Início e oferece tema por usuário", async () => {
  const [html, serviceWorker] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../public/service-worker.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /class="home-operations"/);
  assert.match(html, /id="homePurchaseProgress"/);
  assert.match(html, /id="homePurchaseNotStarted"/);
  assert.match(html, /id="homePurchaseOverdue"/);
  assert.match(html, /params\.append\('status', 'Não iniciado'\)/);
  assert.match(html, /params\.append\('status', 'Em andamento'\)/);
  assert.match(html, /id="homeReminderNext"/);
  assert.match(html, /Notification\.requestPermission\(\)/);
  assert.match(html, /setInterval\(checkTaskReminders, 30000\)/);
  assert.match(html, /id="themeToggle"/);
  assert.match(html, /body\.home-active \.theme-toggle\{display:none;\}/);
  assert.match(html, /estoque_theme:/);
  assert.match(html, /\.theme-toggle\{[\s\S]*position:fixed;[\s\S]*width:60px; height:32px/);
  assert.match(html, /CONTRASTE E LEGIBILIDADE DO TEMA CLARO/);
  assert.match(html, /html\[data-theme="light"\] input:not\(\[type="checkbox"\]\)/);
  assert.match(html, /html\[data-theme="light"\] thead th\{[\s\S]*background:#dce7f0/);
  assert.match(serviceWorker, /notificationclick/);
  assert.match(serviceWorker, /openWindow\(targetUrl\)/);
});

test("envia documentos de compras em partes e trata respostas não JSON", async () => {
  const [html, route, hosting] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../app/api/compras/files/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
  ]);

  assert.match(html, /PURCHASE_FILE_CHUNK_SIZE = 512 \* 1024/);
  assert.match(html, /PURCHASE_FILE_MAX_SIZE = 100 \* 1024 \* 1024/);
  assert.match(html, /function purchaseApiResponse\(response, fallbackMessage\)/);
  assert.match(html, /response\.status === 413/);
  assert.match(html, /file\.slice\(start, Math\.min\(start \+ PURCHASE_FILE_CHUNK_SIZE/);
  assert.match(html, /action:'create'/);
  assert.match(html, /action:'complete'/);
  assert.match(html, /action:'cancel'/);
  assert.match(html, /X-Purchase-Upload-Id/);
  assert.match(html, /ENVIANDO DOCUMENTO/);
  assert.match(route, /TRANSPORT_CHUNK_SIZE = 512 \* 1024/);
  assert.match(route, /const bucket = \(env as \{ UPLOADS\?: R2Bucket \}\)\.UPLOADS/);
  assert.match(route, /bucket\.put\(partKey\(sessionId, partNumber\), bytes/);
  assert.match(route, /createNotionUpload\(metadata, "single_part"\)/);
  assert.match(route, /createNotionUpload\([\s\S]*"multi_part"/);
  assert.match(route, /payload\.number_of_parts = numberOfParts/);
  assert.match(route, /notionForm\.append\("part_number", String\(partNumber\)\)/);
  assert.match(route, /file_uploads\/\$\{encodeURIComponent\(uploadId\)\}\/complete/);
  assert.match(route, /O ARQUIVO DEVE TER NO MÁXIMO 100 MB/);
  assert.equal(JSON.parse(hosting).r2, "UPLOADS");
});

test("isola tarefas por usuário e oferece prioridade, recorrência e lembretes push", async () => {
  const [html, sharedState, workerSource, pushRoute, serviceWorker, viteConfig] =
    await Promise.all([
      readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
      readFile(new URL("../app/api/shared-state/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/push/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../public/service-worker.js", import.meta.url), "utf8"),
      readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    ]);

  assert.match(sharedState, /return `tarefas:\$\{userId\}:\$\{taskMatch\[1\]\}`/);
  assert.match(sharedState, /const prefix = `tarefas:\$\{userId\}:`/);
  const liveEvents = await readFile(
    new URL("../worker/live-events.ts", import.meta.url),
    "utf8",
  );
  assert.match(html, /tarefas:'tasks'/);
  assert.match(html, /if\(livePageName === 'tarefas'\) await Promise\.all\(\[loadTasks\(\),loadTaskAgenda\(\)\]\)/);
  assert.match(liveEvents, /module: "tasks", audience: \{ kind: "user", userId: actor\.id \}/);
  assert.match(html, /id="taskInputPriority"/);
  assert.match(html, /value="urgent">URGENTE/);
  assert.match(html, /id="taskInputRecurrence"/);
  assert.match(html, /value="daily">DIÁRIA/);
  assert.match(html, /value="weekly">SEMANAL/);
  assert.match(html, /value="monthly">MENSAL/);
  assert.match(html, /syncTaskRecurrence/);
  assert.match(html, /const TASK_RECURRENCE_HORIZON_DAYS/);
  assert.match(html, /function recurrenceDateKeys\(dateKey, recurrence/);
  assert.match(html, /task\.carriedFrom/);
  assert.match(html, /pushManager\.subscribe/);
  assert.match(html, /function restorePushSubscription\(\)/);
  assert.match(html, /function savePushSubscription\(subscription\)/);
  assert.match(html, /notificationInstallRequired\(\)/);
  assert.match(pushRoute, /INSERT INTO push_subscriptions/);
  assert.match(pushRoute, /payload\.action === "test"/);
  assert.match(pushRoute, /Notificações Unigames ativadas/);
  assert.match(workerSource, /dispatchDueTaskNotifications/);
  assert.match(workerSource, /webPush\.sendNotification/);
  assert.match(viteConfig, /crons: \["\* \* \* \* \*"\]/);
  assert.match(serviceWorker, /addEventListener\("push"/);
});

test("inclui grupos, recuperação, entregas, preferências, PWA e backup automático", async () => {
  const [html, workerSource, schema, migration, manifest, serviceWorker] =
    await Promise.all([
      readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
      readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
      readFile(new URL("../drizzle-sqlite-legacy/0002_square_sandman.sql", import.meta.url), "utf8"),
      readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
      readFile(new URL("../public/service-worker.js", import.meta.url), "utf8"),
    ]);

  assert.match(workerSource, /ACCESS_GROUP_PERMISSIONS/);
  assert.match(html, /id="userHierarchy"/);
  assert.match(workerSource, /normalizeHierarchy/);
  assert.match(workerSource, /ALTER TABLE app_users ADD COLUMN IF NOT EXISTS hierarchy/);
  assert.match(workerSource, /if \(env\.DB\) await ensureAppUsersTable\(env\.DB\)/);
  assert.match(schema, /hierarchy: text\("hierarchy"\)/);
  assert.match(workerSource, /\/recuperar-senha/);
  assert.match(workerSource, /DELETE FROM app_users WHERE id = \?1/);
  assert.match(workerSource, /automatic-backups\/\$\{date\}\.json\.aes/);
  assert.match(workerSource, /AES-GCM/);
  assert.match(html, /id="partialDeliveryDialog"/);
  assert.match(html, /\/api\/compras\/deliveries/);
  assert.match(html, /id="appearanceDialog"/);
  assert.match(html, /\/api\/preferences/);
  assert.match(html, /beforeinstallprompt/);
  assert.match(html, /estoque_offline_queue:/);
  assert.match(html, /id="homeTaskChartDone"/);
  assert.match(html, /data-quick-action="task"/);
  assert.match(html, /\/api\/health/);
  assert.match(schema, /purchaseDeliveryRecords/);
  assert.match(schema, /userPreferences/);
  assert.match(migration, /CREATE TABLE `password_reset_requests`/);
  assert.equal(JSON.parse(manifest).display, "standalone");
  assert.match(serviceWorker, /CACHE_NAME = "estoque-unigames-v59"/);
});

test("oferece missões gerais e por loja com status dos destinatários e lembretes protegidos", async () => {
  const [html, workerSource, route, schema, migration, statusMigration, manifest, serviceWorker] =
    await Promise.all([
      readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
      readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/missions/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
      readFile(new URL("../drizzle-sqlite-legacy/0005_free_exodus.sql", import.meta.url), "utf8"),
      readFile(new URL("../drizzle-sqlite-legacy/0007_striped_magdalene.sql", import.meta.url), "utf8"),
      readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
      readFile(new URL("../public/service-worker.js", import.meta.url), "utf8"),
    ]);

  assert.match(html, /id="navMissoes" data-page="missoes" data-permission="missions" data-home-desc=/);
  assert.match(html, /id="pageMissoes" class="page wrap"/);
  assert.match(html, /id="homeMissionList"/);
  assert.match(html, /id="missionScope"/);
  assert.match(html, /value="general">MISSÃO GERAL/);
  assert.match(html, /id="missionCompany"/);
  assert.match(html, /id="missionFrequency"/);
  assert.match(html, /value="daily">DIÁRIA/);
  assert.match(html, /value="weekly">SEMANAL/);
  assert.match(html, /id="missionDeadlineMode"/);
  assert.match(html, /id="missionDueTime"/);
  assert.match(html, /id="missionNotificationStatus"/);
  assert.match(html, /id="missionMonth"/);
  assert.match(html, /id="missionMonthCalendar"/);
  assert.match(html, /btnDownloadMissionMonthPdf/);
  assert.match(html, /function loadMissionMonthAgenda\(\)/);
  assert.match(html, /id="btnTestMissionNotifications"/);
  assert.match(html, /Aparelho inscrito\. Os lembretes de 2 horas e 1 hora estão ativos/);
  assert.match(html, /data-mission-status/);
  assert.match(html, /data-home-mission-status/);
  assert.match(html, /value="todo"/);
  assert.match(html, /value="in_progress"/);
  assert.match(html, /value="completed"/);
  assert.match(html, /A FAZER · AINDA NÃO FOI VISTO/);
  assert.match(html, /EM ANDAMENTO · FINALIZAR DEPOIS/);
  assert.match(html, /CONCLUÍDO · FOI FEITO/);
  assert.match(html, /Missão concluída\. O administrador responsável foi avisado/);
  assert.match(html, /missoes:'\/missoes'/);
  assert.match(html, /value="missions:view"> Visualizar missões/);
  assert.match(html, /value="missions:create"> Cadastrar missões/);
  assert.match(html, /value="missions:notify"> Receber notificações \(como administrador\)/);

  assert.match(workerSource, /"missions:view" \| "missions:create" \| "missions:delete" \| "missions:notify"/);
  assert.match(workerSource, /"\/missoes"/);
  assert.match(workerSource, /path === "\/missoes" \|\| path\.startsWith\("\/api\/missions"\)/);
  assert.match(workerSource, /dispatchDueMissionNotifications/);
  assert.match(workerSource, /\[120, 60\]/);
  assert.match(workerSource, /Missão termina em 2 horas/);
  assert.match(workerSource, /Missão termina em 1 hora/);
  assert.match(workerSource, /completion\?\.status === "completed"/);
  assert.match(workerSource, /dispatchDueTaskNotifications\(env\),[\s\S]*dispatchDueMissionNotifications\(env\)/);

  assert.match(route, /!can\(actor, "missions:create"\)/);
  assert.match(route, /!can\(actor, "missions:delete"\)/);
  assert.match(route, /O ADMINISTRADOR NÃO PODE ALTERAR O STATUS DAS MISSÕES/);
  assert.match(route, /mission\.companyId !== actor\.companyId/);
  assert.match(route, /weekday >= 1 && weekday <= 5/);
  assert.match(route, /function missionRangeResponse\(/);
  assert.match(route, /occurrence_date BETWEEN \?1 AND \?2/);
  assert.match(route, /"todo",[\s\S]*"in_progress",[\s\S]*"completed"/);
  assert.match(route, /INSERT INTO missions/);
  assert.match(route, /INSERT INTO mission_completions/);
  assert.match(route, /ON CONFLICT\(mission_id, occurrence_date, company_id\) DO UPDATE/);
  assert.match(route, /status === "completed" && existing\?\.status !== "completed"/);
  assert.match(route, /notifyMissionCreator/);
  assert.match(route, /Missão concluída — \$\{completedByStore\}/);

  // Regressão: a conclusão já foi gravada em mission_completions ANTES de
  // notifyMissionCreator rodar. Se a busca das inscrições de notificação (ou
  // o envio do push) falhar de forma transitória e essa chamada não estiver
  // isolada com .catch, o erro sobe pro catch geral do PATCH e o handler
  // responde 500 mesmo com o status já salvo — o front-end trata esse erro
  // revertendo o <select> pro valor anterior (ver listener de "change" de
  // #missionList/#homeMissionList em estoque.html), fazendo a missão parecer
  // que "desmarcou sozinha" mesmo já concluída no banco.
  assert.match(
    route,
    /await notifyMissionCreator\(database, mission, storeName\)\.catch\(/,
  );
  assert.match(schema, /export const missions = pgTable/);
  assert.match(schema, /export const missionCompletions = pgTable/);
  assert.match(migration, /CREATE TABLE `missions`/);
  assert.match(migration, /CREATE TABLE `mission_completions`/);
  assert.match(migration, /mission_completions_occurrence_unique/);
  assert.match(statusMigration, /ADD `status` text DEFAULT 'completed' NOT NULL/);
  assert.match(statusMigration, /ADD `updated_at` text DEFAULT '' NOT NULL/);
  assert.match(manifest, /"url": "\/missoes"/);
  assert.match(serviceWorker, /CACHE_NAME = "estoque-unigames-v59"/);
});

test("implementa a captação por loja 100% via permissões granulares, sem fluxo especial de assistência", async () => {
  const [html, workerSource, route, captureShared, schema, migration, sectorMigration, manifest, serviceWorker] =
    await Promise.all([
      readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
      readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/captures/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/captures/shared.ts", import.meta.url), "utf8"),
      readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
      readFile(new URL("../drizzle-sqlite-legacy/0008_luxuriant_killer_shrike.sql", import.meta.url), "utf8"),
      readFile(new URL("../drizzle/0010_cultured_fabian_cortez.sql", import.meta.url), "utf8"),
      readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
      readFile(new URL("../public/service-worker.js", import.meta.url), "utf8"),
    ]);
  const liveEvents = await readFile(
    new URL("../worker/live-events.ts", import.meta.url),
    "utf8",
  );

  assert.match(html, /id="navCaptacao" data-page="captacao" data-permission="captures"/);
  assert.match(html, /id="pageCaptacao" class="page wrap"/);
  assert.match(html, /id="captureForm"/);
  assert.match(html, /id="captureCategory"/);
  assert.match(html, /id="captureProductName"/);
  assert.match(html, /id="captureSerialNumber"/);
  assert.match(html, /id="captureDefects"/);
  assert.match(html, /id="captureColor"/);
  assert.match(html, /id="captureOriginCompany"/);
  assert.match(html, /canActAcrossStores\('captures:create'\) \? el\('captureOriginCompany'\)\.value : ''/);
  assert.match(html, /AGUARDANDO ASSISTÊNCIA/);
  assert.match(html, /RECEBIDO PELA ASSISTÊNCIA/);
  assert.match(html, /DISPONÍVEL PARA SEPARAÇÃO/);
  assert.match(html, /data-capture-action="receive"/);
  assert.match(html, /data-capture-action="ready"/);
  assert.match(html, /data-capture-action="assign"/);
  assert.match(html, /function canReceiveCaptures\(\)\{/);
  assert.match(html, /value="assistance">ASSISTÊNCIA — FLUXO DE CAPTAÇÃO/);
  assert.match(html, /value="captures:view"> Visualizar/);
  assert.match(html, /captacao:'\/captacao'/);
  assert.match(html, /captacao:'captures'/);
  assert.match(html, /if\(livePageName === 'captacao'\) await loadCaptures\(\)/);
  assert.doesNotMatch(html, /isAssistanceSession/);
  assert.doesNotMatch(html, /username\.includes\('assistencia'\)/);
  assert.doesNotMatch(html, /displayName\.includes\('assistencia'\)/);

  assert.match(workerSource, /"captures"/);
  assert.match(workerSource, /assistance: \["captures:view", "captures:create", "captures:receive", "captures:delete"\]/);
  assert.match(workerSource, /const sector: UserSector = accessGroup === "assistance" \? "assistance" : requestedSector/);
  assert.match(workerSource, /const companyId = sector \? "" : requestedCompanyId/);
  assert.match(workerSource, /path === "\/captacao" \|\| path\.startsWith\("\/api\/captures"\)/);
  assert.match(workerSource, /authenticatedHeaders\.set\(ACCESS_GROUP_HEADER, user\.accessGroup\)/);
  assert.match(workerSource, /env\.DB\.prepare\("SELECT \* FROM captured_products"\)\.all\(\)/);
  assert.match(workerSource, /capturedProducts: capturedProducts\.results \?\? \[\]/);
  assert.match(workerSource, /headers\.delete\("x-unigames-live-company-id"\)/);
  // resolveAccessGroup (que forçava accessGroup="assistance" só por causa do
  // username "assistencia", ignorando permissões custom concedidas) foi
  // removido — accessGroup agora é sempre normalizeAccessGroup(valor salvo).
  assert.doesNotMatch(workerSource, /normalized === "assistencia"/);
  assert.doesNotMatch(workerSource, /function resolveAccessGroup/);
  assert.match(workerSource, /const accessGroup = role === "admin"\s*\? "administrator"\s*: normalizeAccessGroup\(row\.accessGroup\)/);
  assert.match(workerSource, /const accessGroup = normalizeAccessGroup\(body\.accessGroup\)/);
  // Canal de aviso em tempo real de captação passa a ser calculado pela
  // permissão captures:receive, não mais por setor/grupo/nome de usuário.
  assert.match(workerSource, /if \(hasPermission\(user, "captures:receive"\)\) groups\.push\("assistance"\);/);
  assert.doesNotMatch(workerSource, /user\.username\.toLowerCase\(\)\.includes\("assistencia"\)/);
  assert.match(liveEvents, /module: "captures"/);
  assert.match(liveEvents, /category === "jogo" \? \[\] : \["assistance"\]/);

  assert.doesNotMatch(captureShared, /isAssistanceActor/);
  assert.match(route, /const allStores =\s*canSeeAllStores\(actor, "captures:view"\) \|\|\s*canSeeAllStores\(actor, "captures:receive"\) \|\|\s*canSeeAllStores\(actor, "captures:assign"\)/);
  assert.match(route, /const canChooseCompany = canSeeAllStores\(actor, "captures:create"\)/);
  assert.match(route, /ESCOLHA A LOJA DE ORIGEM/);
  assert.match(route, /actor\.role !== "admin" && actor\.permissions\.includes\("captures:receive"\)/);
  assert.match(route, /VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR ESTA ETAPA/);
  assert.match(route, /VOCÊ NÃO TEM PERMISSÃO PARA DEFINIR O DESTINO/);
  assert.match(route, /existing\.status !== "submitted"/);
  assert.doesNotMatch(route, /isAssistanceActor/);
  assert.doesNotMatch(route, /A ASSISTÊNCIA NÃO PODE CADASTRAR PRODUTOS CAPTADOS/);
  assert.match(html, /id="userSector"/);
  assert.match(schema, /sector: text\("sector"\)/);
  assert.match(sectorMigration, /SET "sector" = 'assistance', "company_id" = ''/);
  assert.match(route, /existing\.status !== "received"/);
  assert.match(route, /existing\.status !== "ready"/);
  assert.match(route, /origin_company_id=\?1/);
  assert.match(route, /destination_company_id=\?1/);
  assert.match(route, /function liveCaptureResponse/);
  assert.match(schema, /export const capturedProducts = pgTable/);
  assert.match(migration, /CREATE TABLE `captured_products`/);
  assert.match(migration, /captured_products_status_updated_idx/);
  assert.match(migration, /captured_products_origin_created_idx/);
  assert.match(manifest, /"url": "\/captacao"/);
  assert.match(serviceWorker, /CACHE_NAME = "estoque-unigames-v59"/);
});

test("cadastra jogos direto para separação e os remove da fila da assistência", async () => {
  const [html, route, captureShared, schema, postgresMigration, sqliteMigration] =
    await Promise.all([
      readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
      readFile(new URL("../app/api/captures/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/captures/shared.ts", import.meta.url), "utf8"),
      readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
      readFile(new URL("../drizzle/0011_low_turbo.sql", import.meta.url), "utf8"),
      readFile(
        new URL("../drizzle-sqlite-legacy/0011_capture_games.sql", import.meta.url),
        "utf8",
      ),
    ]);

  assert.match(captureShared, /CaptureCategory = "console" \| "controller" \| "other" \| "jogo"/);
  assert.match(captureShared, /"PS4",\s+"PS3",\s+"PS5",\s+"Nintendo Switch",\s+"Xbox One\/Series"/);
  assert.match(captureShared, /GAME_CONDITIONS = new Set<GameCondition>\(\["Novo", "Semi Novo"\]\)/);
  assert.match(captureShared, /game_name AS gameName/);
  assert.match(captureShared, /actor\.companyId === row\.originCompanyId \|\|\s*canSeeAllStores\(actor, "captures:view"\)/);

  assert.match(html, /<option value="jogo">JOGOS<\/option>/);
  assert.match(html, /id="captureGameName"/);
  assert.match(html, /id="captureGameConsole"[\s\S]*value="PS4"[\s\S]*value="PS3"[\s\S]*value="PS5"[\s\S]*value="Nintendo Switch"[\s\S]*value="Xbox One\/Series"/);
  assert.match(html, /id="captureGameCondition"[\s\S]*value="Novo"[\s\S]*value="Semi Novo"/);
  assert.match(html, /el\('captureValue'\)\.required = isGame/);
  assert.match(html, /gameName:el\('captureGameName'\)\.value/);
  assert.match(html, /canReceiveCaptures\(\) && row\.category === 'jogo'/);

  assert.match(route, /body\.category === "jogo"/);
  assert.match(route, /WHERE category <> 'jogo'/);
  assert.match(route, /CASE WHEN \?2 = 'jogo' THEN 'ready' ELSE 'submitted' END/);
  assert.match(route, /existing\.category === "jogo"/);
  assert.match(route, /GAME_CONSOLES\.has\(gameConsole\)/);
  assert.match(route, /GAME_CONDITIONS\.has\(gameCondition\)/);
  assert.match(route, /capturedValue <= 0/);

  for (const source of [schema, postgresMigration, sqliteMigration]) {
    assert.match(source, /game_name/);
    assert.match(source, /game_console/);
    assert.match(source, /game_condition/);
  }
});

test("simplifica o cadastro de Jogos (sem produto/modelo, serial, cor ou defeitos) e remove o envio de fotos", async () => {
  const [html, route] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../app/api/captures/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="captureProductNameField"/);
  assert.match(html, /id="captureSerialNumberField"/);
  assert.match(html, /id="captureColorField"/);
  assert.match(html, /id="captureDefectsField"/);
  assert.match(
    html,
    /\['captureProductNameField','captureSerialNumberField','captureColorField','captureDefectsField'\]\.forEach\(id => \{\s*el\(id\)\.hidden = isGame;/,
  );
  assert.match(html, /el\('captureProductName'\)\.required = !isGame/);
  assert.match(html, /el\('captureSerialNumber'\)\.required = !isGame/);
  assert.match(html, /el\('captureColor'\)\.required = !isGame/);
  assert.match(html, /el\('captureDefects'\)\.required = !isGame/);

  assert.doesNotMatch(html, /id="capturePhoto"/);
  assert.doesNotMatch(html, /hasPhoto/);
  assert.doesNotMatch(html, /capture-photo/);
  assert.doesNotMatch(html, /captureUploadRequest/);
  assert.doesNotMatch(html, /uploadCapturePhoto/);

  assert.match(route, /category === "jogo" \? "" : safeText\(body\.productName, 160\)/);
  assert.match(route, /category === "jogo" \? "" : safeText\(body\.serialNumber, 160\)/);
  assert.match(route, /category === "jogo" \? "" : safeText\(body\.defects, 1200\)/);
  assert.match(route, /category === "jogo" \? "" : safeText\(body\.color, 120\)/);
  assert.match(route, /if \(category !== "jogo"\) \{/);
});

test("permite excluir uma captação a quem tem a permissão captures:delete", async () => {
  const [html, route] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../app/api/captures/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(html, /data-capture-action="delete"/);
  assert.match(html, /EXCLUIR CAPTAÇÃO/);
  assert.match(html, /canAccess\('captures:delete'\)/);
  assert.match(html, /window\.confirm\('Excluir definitivamente a captação/);
  assert.match(html, /method:action === 'delete' \? 'DELETE' : 'PATCH'/);
  // Regressão: o clique tinha um "if(currentSession.role !== 'admin') return"
  // hardcoded no handler de exclusão, que bloqueava silenciosamente quem
  // tinha captures:delete via grupo/permissão granular (ex.: assistência)
  // mas não era role==='admin'. O gate de clique precisa usar a mesma
  // permissão granular que já decide se o botão aparece.
  assert.match(
    html,
    /if\(action === 'delete'\)\{\s*if\(!canAccess\('captures:delete'\)\) return;/,
  );
  assert.doesNotMatch(
    html,
    /if\(action === 'delete'\)\{\s*if\(currentSession\.role !== 'admin'\) return;/,
  );

  assert.match(route, /export async function DELETE\(request: Request\)/);
  assert.match(route, /!can\(actor, "captures:delete"\)/);
  assert.match(route, /VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR CAPTAÇÕES/);
  assert.match(route, /DELETE FROM captured_products WHERE id=\?1/);
  assert.match(route, /await bucket\.delete\(existing\.photoKey\)/);
});

test("registra Saídas Gerais Solicitadas por loja e preserva o histórico do administrador", async () => {
  const [html, workerSource, route, schema, migration, addResponsibleMigration, manifest, serviceWorker] =
    await Promise.all([
      readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
      readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/outputs/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
      readFile(new URL("../drizzle-sqlite-legacy/0009_hard_young_avengers.sql", import.meta.url), "utf8"),
      readFile(new URL("../drizzle/0017_swift_warbird.sql", import.meta.url), "utf8"),
      readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
      readFile(new URL("../public/service-worker.js", import.meta.url), "utf8"),
    ]);

  assert.match(html, /id="navSaidas" data-page="saidas" data-permission="outputs" data-home-desc=/);
  assert.match(html, /id="pageSaidas" class="page wrap"/);
  assert.match(html, /Saídas Gerais Solicitadas/);
  assert.doesNotMatch(html, /produtos com defeito/);
  assert.match(html, /id="outputForm"/);
  assert.match(html, /id="outputQuantity" type="number" min="1" max="9999"/);
  assert.match(html, /id="outputProductName"/);
  assert.match(html, /id="outputResponsible" maxlength="120" required/);
  assert.match(html, /for="outputResponsible">RESPONSÁVEL PELA SAÍDA</);
  assert.match(html, /id="outputDefect"/);
  assert.match(html, /for="outputDefect">DEFEITOS \/ OBSERVAÇÕES</);
  assert.match(html, /RESPONSÁVEL PELA SAÍDA<\/span><strong>/);
  assert.match(html, /DEFEITOS \/ OBSERVAÇÕES<\/span><strong>/);
  assert.match(html, /responsibleName:el\('outputResponsible'\)\.value/);
  assert.match(html, /id="outputCompany"/);
  assert.match(html, /data-output-view="requested"/);
  assert.match(html, /data-output-view="completed"/);
  assert.match(html, /data-output-complete/);
  assert.match(html, /timeZone:'America\/Recife'/);
  assert.match(html, /value="outputs:view"> Visualizar/);
  assert.match(html, /value="outputs:create"> Cadastrar saídas/);
  assert.match(html, /value="outputs:complete"> Concluir saídas/);
  assert.match(html, /canAccess\('outputs:complete'\)/);
  assert.match(html, /saidas:'\/saidas'/);

  assert.match(workerSource, /"outputs"/);
  assert.match(workerSource, /path === "\/saidas" \|\| path\.startsWith\("\/api\/outputs"\)/);
  assert.match(workerSource, /env\.DB\.prepare\("SELECT \* FROM defective_outputs"\)\.all\(\)/);
  assert.match(workerSource, /defectiveOutputs: defectiveOutputs\.results \?\? \[\]/);

  assert.match(route, /const canChooseCompany = canSeeAllStores\(actor, "outputs:create"\) \|\| isAdministrativeActor\(actor\)/);
  assert.match(route, /responsible_name AS responsibleName/);
  assert.match(route, /const responsibleName = safeText\(body\.responsibleName, 120\)/);
  assert.match(route, /INFORME O RESPONSÁVEL PELA SAÍDA/);
  assert.match(route, /INFORME OS DEFEITOS\/OBSERVAÇÕES DA SAÍDA/);
  assert.match(route, /WHERE company_id=\?1/);
  assert.match(route, /!can\(actor, "outputs:complete"\)/);
  assert.match(route, /VOCÊ NÃO TEM PERMISSÃO PARA CONCLUIR UMA SAÍDA/);
  assert.match(route, /existing\.status !== "requested"/);
  assert.match(route, /SET status='completed'/);
  assert.match(route, /completed_at=CURRENT_TIMESTAMP/);
  assert.match(schema, /export const defectiveOutputs = pgTable/);
  assert.match(schema, /responsibleName: text\("responsible_name"\)\.notNull\(\)\.default\(""\)/);
  assert.match(migration, /CREATE TABLE `defective_outputs`/);
  assert.match(migration, /defective_outputs_status_created_idx/);
  assert.match(migration, /defective_outputs_company_created_idx/);
  assert.match(migration, /PRAGMA optimize/);
  assert.match(
    addResponsibleMigration,
    /ALTER TABLE "defective_outputs" ADD COLUMN "responsible_name" text DEFAULT '' NOT NULL/,
  );
  assert.match(manifest, /"url": "\/saidas"/);
  assert.match(serviceWorker, /CACHE_NAME = "estoque-unigames-v59"/);
});

test("usuário sem loja do setor Administrativo vê, altera status e exclui saídas de todas as lojas", async () => {
  const [html, route, workerSource] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../app/api/outputs/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
  ]);

  assert.match(route, /function isAdministrativeActor\(actor: Identity\) \{\s*return actor\.sector === "administrative";/);
  assert.match(route, /const result = allStores/);
  assert.match(route, /!can\(actor, "outputs:delete"\)/);
  assert.match(route, /VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR SAÍDAS/);
  assert.match(route, /DELETE FROM defective_outputs WHERE id=\?1/);
  assert.match(route, /sector: safeText\(request\.headers\.get\("x-unigames-sector"\), 40\)/);

  assert.match(workerSource, /"outputs:view" \| "outputs:create" \| "outputs:complete" \| "outputs:delete"/);
  assert.match(
    workerSource,
    /outputs: \["outputs:view", "outputs:create", "outputs:complete", "outputs:delete"\]/,
  );

  assert.match(html, /value="outputs:delete"> Excluir saídas/);
  assert.match(html, /data-output-delete/);
  assert.match(html, /'outputs:delete':'Saídas: excluir'/);
});

test("Saídas: loja vê só a própria, conta sem loja com permissões completas vê todas, resumo só pra quem conclui e loja aparece na listagem", async () => {
  const [html, route] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../app/api/outputs/route.ts", import.meta.url), "utf8"),
  ]);

  // Item 3: usuário de loja só vê as próprias solicitações — filtro por company_id.
  assert.match(route, /WHERE company_id=\?1/);
  assert.match(route, /\.bind\(actor\.companyId\)/);

  // Item 4 (generalizado): sem loja vinculada + a permissão granular daquela
  // ação também vê/age em todas as lojas — via o helper único
  // canSeeAllStores() em app/lib/access-scope.ts, reaproveitado por todos os
  // módulos (não mais uma checagem redundante por módulo).
  assert.match(route, /import \{ canSeeAllStores, hasCompany, NO_COMPANY_ERROR \} from "\.\.\/\.\.\/lib\/access-scope"/);
  assert.match(
    route,
    /const allStores = canSeeAllStores\(actor, "outputs:view"\) \|\| isAdministrativeActor\(actor\);/,
  );
  assert.doesNotMatch(route, /hasFullOutputsAccess/);

  // Item 1: contadores/resumo só aparecem pra quem tem permissão de concluir.
  assert.match(html, /<section class="output-summary" id="outputSummary"/);
  assert.match(html, /el\('outputSummary'\)\.hidden = !canAccess\('outputs:complete'\)/);

  // Item 2: a loja solicitante aparece claramente em cada card da listagem.
  assert.match(html, /const companyLabel = row\.companyName \|\| 'Loja não identificada'/);
  assert.match(html, /class="output-company-badge"/);
  assert.match(html, /SOLICITADA POR '\+escapeHtml\(row\.createdByName \|\| 'LOJA'\)\+\s*' · '\+escapeHtml\(companyLabel\)/);
});

test("Saídas — Regra 1 (usuário com loja só cadastra/visualiza/histórico da própria) e Regra 2 (sem loja + outputs:view vê todas)", async () => {
  const [route, accessScope, html] = await Promise.all([
    readFile(new URL("../app/api/outputs/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/access-scope.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
  ]);

  // Regra 1 — quem tem loja fica preso a ela mesmo com a permissão do
  // módulo: canSeeAllStores() nega allStores antes de olhar permissões.
  assert.match(
    accessScope,
    /if \(hasCompany\(actor\.companyId\)\) return false;/,
  );
  // GET (visualizar/histórico): filtra por company_id quando não é allStores.
  assert.match(
    route,
    /const allStores = canSeeAllStores\(actor, "outputs:view"\) \|\| isAdministrativeActor\(actor\);/,
  );
  assert.match(route, /WHERE company_id=\?1/);
  assert.match(route, /\.bind\(actor\.companyId\)/);
  // POST (cadastrar): usuário com loja nunca escolhe outra empresa.
  assert.match(
    route,
    /const canChooseCompany = canSeeAllStores\(actor, "outputs:create"\) \|\| isAdministrativeActor\(actor\);/,
  );
  assert.match(route, /const companyId = canChooseCompany \? requestedCompanyId : actor\.companyId;/);
  // Concluir é restrito só pela permissão granular outputs:complete, nunca
  // liberado automaticamente pra quem tem loja — regra já existente mantida.
  assert.match(route, /!can\(actor, "outputs:complete"\)/);
  assert.match(route, /VOCÊ NÃO TEM PERMISSÃO PARA CONCLUIR UMA SAÍDA/);

  // Regra 2 — sem loja vinculada + a permissão específica da ação (aqui,
  // outputs:view) enxerga todas as lojas, igual a um administrador.
  assert.match(
    accessScope,
    /return actor\.permissions\.includes\(requiredPermission\);/,
  );

  // Front-end: botão de concluir só aparece com a permissão específica,
  // não por ter ou não loja vinculada.
  assert.match(html, /canAccess\('outputs:complete'\) && !completed/);
  assert.match(html, /MARCAR COMO FEITO<\/button>/);
});

test("Saídas: usuário sem loja e sem ser admin (ex.: Assistência com outputs:create) escolhe a loja e a saída é registrada com ela", async () => {
  // Bug relatado: um usuário sem companyId mas que também não é
  // role==="admin" (ex.: a Assistência, com outputs:create concedido
  // manualmente) não devia depender de ser admin pra ver o seletor de loja
  // no cadastro de saída — só da permissão outputs:create.
  const [route, html] = await Promise.all([
    readFile(new URL("../app/api/outputs/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
  ]);

  // Back-end: quem escolhe a loja é decidido por canSeeAllStores(), que
  // (via app/lib/access-scope.ts) já libera qualquer actor sem companyId
  // que tenha a permissão outputs:create — não checa actor.role==="admin"
  // isoladamente em nenhum ponto desta decisão.
  assert.match(
    route,
    /const canChooseCompany = canSeeAllStores\(actor, "outputs:create"\) \|\| isAdministrativeActor\(actor\);/,
  );
  assert.doesNotMatch(route, /actor\.role === "admin" \? requestedCompanyId/);
  // A loja escolhida (requestedCompanyId) é a que efetivamente é gravada.
  assert.match(
    route,
    /const companyId = canChooseCompany \? requestedCompanyId : actor\.companyId;/,
  );
  assert.match(route, /\.prepare\(\s*`INSERT INTO defective_outputs/);
  assert.match(route, /company_id, company_name,/);

  // Front-end: o campo LOJA aparece pra quem pode escolher — decidido por
  // canActAcrossStores('outputs:create') (admin OU sem loja + permissão),
  // nunca por currentSession.role==='admin' isolado.
  assert.match(html, /const canChooseCompany = canActAcrossStores\('outputs:create'\);/);
  assert.match(html, /el\('outputCompanyField'\)\.hidden = !canChooseCompany;/);
  assert.match(html, /el\('outputCompany'\)\.required = canChooseCompany;/);
  assert.doesNotMatch(
    html,
    /el\('outputCompanyField'\)\.hidden = !isAdmin;/,
  );
  // A loja escolhida no <select> é o que vai no corpo da requisição.
  assert.match(
    html,
    /companyId:canActAcrossStores\('outputs:create'\) \? el\('outputCompany'\)\.value : ''/,
  );
});

test("Saídas: a lista de lojas do seletor é carregada e liberada pro usuário sem loja com outputs:create (causa raiz real do 'campo vazio')", async () => {
  // Causa raiz de verdade do bug repetido ("a Assistência não consegue
  // escolher loja"): o campo de seleção SEMPRE apareceu corretamente pra
  // ela (canActAcrossStores('outputs:create') já era true), mas o
  // <select> ficava sem nenhuma opção porque:
  // (1) o front-end só chamava loadCompanies() se o usuário tivesse
  //     database/stock/pulls/report41 — nenhuma dessas é usada por quem
  //     só tem permissões de Saídas/Captação/Insumos/Missões;
  // (2) mesmo chamando, o worker bloqueava a LEITURA de "companies_list"
  //     em /api/shared-state atrás desse mesmo grupo de permissões,
  //     não relacionado a Saídas.
  const [html, workerSource] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
  ]);

  // Front-end: loadCompanies() roda pra qualquer módulo que deixa um
  // usuário sem loja escolher a loja de destino, não só database/stock/
  // pulls/report41.
  assert.match(
    html,
    /const needsCompanies = canAccess\('database'\) \|\| canAccess\('stock'\) \|\| canAccess\('pulls'\) \|\| canAccess\('report41'\) \|\| canAccess\('finance'\) \|\|\s*canActAcrossStores\('outputs:create'\) \|\| canActAcrossStores\('captures:create'\) \|\|\s*canActAcrossStores\('supplies:request'\) \|\| canActAcrossStores\('missions:view'\) \|\|\s*canActAcrossStores\('inputs:create'\);/,
  );

  // Back-end: leitura de companies_list liberada pra qualquer autenticado
  // (não é dado sensível — é só a referência usada pelos seletores de
  // loja de vários módulos); a escrita (Cadastros > Lojas) segue restrita
  // pelo branch padrão de sharedStatePermission().
  assert.match(
    workerSource,
    /if \(key === "companies_list" && \(request\.method === "GET" \|\| request\.method === "HEAD"\)\) \{\s*return true;\s*\}/,
  );
  // A checagem vem ANTES do cálculo de `required` (senão a exceção não
  // bypassaria o gate de stock\/database\/pulls\/report41).
  const bypassIndex = workerSource.indexOf('key === "companies_list"');
  const requiredIndex = workerSource.indexOf("const required = sharedStatePermission(");
  assert.ok(bypassIndex > -1 && requiredIndex > -1 && bypassIndex < requiredIndex);
});

test("registra Entradas Gerais Solicitadas por loja e preserva o histórico do administrador (espelho de Saídas)", async () => {
  const [html, workerSource, route, schema, migration] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/inputs/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0023_modulo_entrada.sql", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="navEntradas" data-page="entradas" data-permission="inputs" data-home-desc=/);
  assert.match(html, /id="pageEntradas" class="page wrap"/);
  assert.match(html, /Entradas Gerais Solicitadas/);
  assert.match(html, /id="inputForm"/);
  assert.match(html, /id="inputQuantity" type="number" min="1" max="9999"/);
  assert.match(html, /id="inputProductName"/);
  assert.match(html, /id="inputResponsible" maxlength="120" required/);
  assert.match(html, /for="inputResponsible">RESPONSÁVEL PELA ENTRADA</);
  assert.match(html, /id="inputReason"/);
  assert.match(html, /for="inputReason">MOTIVO DA ENTRADA</);
  assert.match(html, /RESPONSÁVEL PELA ENTRADA<\/span><strong>/);
  assert.match(html, /MOTIVO DA ENTRADA<\/span><strong>/);
  assert.match(html, /responsibleName:el\('inputResponsible'\)\.value/);
  assert.match(html, /reason:el\('inputReason'\)\.value/);
  assert.match(html, /id="inputCompany"/);
  assert.match(html, /data-input-view="requested"/);
  assert.match(html, /data-input-view="completed"/);
  assert.match(html, /data-input-complete/);
  assert.match(html, /value="inputs:view"> Visualizar/);
  assert.match(html, /value="inputs:create"> Cadastrar entradas/);
  assert.match(html, /value="inputs:complete"> Concluir entradas/);
  assert.match(html, /value="inputs:delete"> Excluir entradas/);
  assert.match(html, /canAccess\('inputs:complete'\)/);
  assert.match(html, /entradas:'\/entradas'/);
  assert.match(html, /'inputs:delete':'Entrada: excluir'/);

  assert.match(workerSource, /"inputs:view" \| "inputs:create" \| "inputs:complete" \| "inputs:delete"/);
  assert.match(workerSource, /path === "\/entradas" \|\| path\.startsWith\("\/api\/inputs"\)/);
  assert.match(
    workerSource,
    /inputs: \["inputs:view", "inputs:create", "inputs:complete", "inputs:delete"\]/,
  );
  assert.match(workerSource, /"\/entradas",/);
  // Permissões de Entrada não entram nos grupos de acesso pré-definidos
  // (purchases/fiscal/operator, inalterados) — são um módulo independente
  // de Saídas, concedido só manualmente ou via grupo Administrador.
  assert.match(
    workerSource,
    /fiscal: \[\s*"missions:view",\s*"outputs:view", "outputs:create",\s*"supplies:view", "supplies:request", "supplies:receive", "supplies:stock_out",\s*"stock:view",\s*"database:view", "database:manage",\s*"pulls:view",\s*"report41:view",\s*\]/,
  );
  assert.match(
    workerSource,
    /purchases: \[\s*"tasks:view", "tasks:manage",\s*"missions:view", "missions:notify",\s*"captures:view", "captures:create",\s*"outputs:view", "outputs:create",\s*"supplies:view", "supplies:request", "supplies:receive", "supplies:stock_out",\s*"purchases:view", "purchases:create", "purchases:edit", "purchases:delete",\s*\]/,
  );

  assert.match(route, /const canChooseCompany = canSeeAllStores\(actor, "inputs:create"\) \|\| isAdministrativeActor\(actor\)/);
  assert.match(route, /const allStores = canSeeAllStores\(actor, "inputs:view"\) \|\| isAdministrativeActor\(actor\)/);
  assert.match(route, /responsible_name AS responsibleName, reason/);
  assert.match(route, /const responsibleName = safeText\(body\.responsibleName, 120\)/);
  assert.match(route, /const reason = safeText\(body\.reason, 1200\)/);
  assert.match(route, /INFORME O RESPONSÁVEL PELA ENTRADA/);
  assert.match(route, /INFORME O MOTIVO DA ENTRADA/);
  assert.match(route, /WHERE company_id=\?1/);
  assert.match(route, /!can\(actor, "inputs:complete"\)/);
  assert.match(route, /!can\(actor, "inputs:delete"\)/);
  assert.match(route, /existing\.status !== "requested"/);
  assert.match(route, /SET status='completed'/);
  assert.match(route, /INSERT INTO requested_inputs/);
  assert.match(route, /DELETE FROM requested_inputs WHERE id=\?1/);

  assert.match(schema, /export const requestedInputs = pgTable\(\s*"requested_inputs"/);
  assert.match(schema, /reason: text\("reason"\)\.notNull\(\)/);
  assert.match(schema, /responsibleName: text\("responsible_name"\)\.notNull\(\)\.default\(""\)/);
  assert.match(migration, /CREATE TABLE "requested_inputs"/);
  assert.match(migration, /requested_inputs_status_created_idx/);
  assert.match(migration, /requested_inputs_company_created_idx/);
  assert.match(migration, /ALTER TABLE "requested_inputs" ENABLE ROW LEVEL SECURITY/);
});

test("Entrada: loja vê só a própria, conta sem loja com permissões completas vê todas, resumo só pra quem conclui", async () => {
  const [html, route] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../app/api/inputs/route.ts", import.meta.url), "utf8"),
  ]);

  // Regra 1: usuário com loja vinculada fica sempre restrito à própria loja
  // (canSeeAllStores nega antes de checar permissão), mesmo com inputs:view.
  assert.match(
    route,
    /const allStores = canSeeAllStores\(actor, "inputs:view"\) \|\| isAdministrativeActor\(actor\);/,
  );
  // Regra 2: sem loja + permissão granular específica da ação vê/age em
  // todas as lojas, igual a um administrador.
  assert.match(
    route,
    /const canChooseCompany = canSeeAllStores\(actor, "inputs:create"\) \|\| isAdministrativeActor\(actor\);/,
  );
  // Concluir é restrito só pela permissão granular inputs:complete.
  assert.match(route, /!can\(actor, "inputs:complete"\)/);
  // Resumo (contadores) só aparece pra quem pode concluir.
  assert.match(html, /el\('inputSummary'\)\.hidden = !canAccess\('inputs:complete'\)/);
  assert.match(html, /canAccess\('inputs:complete'\) && !completed/);
  // Front-end: mesma regra de canActAcrossStores espelhando o back-end.
  assert.match(html, /const canChooseCompany = canActAcrossStores\('inputs:create'\);/);
  assert.match(
    html,
    /companyId:canActAcrossStores\('inputs:create'\) \? el\('inputCompany'\)\.value : ''/,
  );
});

test("Entrada: a lista de lojas do seletor é carregada pro usuário sem loja com inputs:create (mesma correção aplicada em Saídas)", async () => {
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.match(
    html,
    /const needsCompanies = canAccess\('database'\) \|\| canAccess\('stock'\) \|\| canAccess\('pulls'\) \|\| canAccess\('report41'\) \|\| canAccess\('finance'\) \|\|\s*canActAcrossStores\('outputs:create'\) \|\| canActAcrossStores\('captures:create'\) \|\|\s*canActAcrossStores\('supplies:request'\) \|\| canActAcrossStores\('missions:view'\) \|\|\s*canActAcrossStores\('inputs:create'\);/,
  );
});

test("separa insumos por loja, registra pedidos recorrentes e preserva recebimentos", async () => {
  const [html, workerSource, route, schema, migration, manifest, serviceWorker] =
    await Promise.all([
      readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
      readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/supplies/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
      readFile(new URL("../drizzle-sqlite-legacy/0010_flowery_la_nuit.sql", import.meta.url), "utf8"),
      readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
      readFile(new URL("../public/service-worker.js", import.meta.url), "utf8"),
    ]);
  const liveEvents = await readFile(
    new URL("../worker/live-events.ts", import.meta.url),
    "utf8",
  );

  assert.match(html, /id="navInsumos" data-page="insumos" data-permission="supplies" data-home-desc=/);
  assert.match(html, /id="homeSuppliesAlert" data-permission="supplies" hidden/);
  assert.match(html, /LEMBRETE DE SEGUNDA-FEIRA/);
  assert.match(html, /id="pageInsumos" class="page wrap"/);
  assert.match(html, /id="supplyMissingGroups"/);
  assert.match(html, /data-missing-product=/);
  assert.match(html, /id="supplyCompany"/);
  assert.match(html, /id="supplyRequestPanel" hidden/);
  assert.match(html, /data-request-check=/);
  assert.match(html, /id="supplyAdminSeparacao" hidden/);
  assert.match(html, /data-separation-confirm=/);
  assert.match(html, /data-receive-item=/);
  assert.match(html, /currentSession\.role === 'admin'/);
  assert.match(html, /method:'DELETE'/);
  assert.match(html, /SEPARAÇÃO<\/button>/);
  assert.match(html, /insumos:'\/insumos'/);
  assert.match(html, /insumos:'supplies'/);
  assert.match(html, /if\(livePageName === 'insumos'\)/);
  assert.match(html, /loadSupplySeparationQueue\(\)/);
  assert.match(html, /value="supplies:view"> Visualizar/);

  assert.match(workerSource, /"supplies"/);
  assert.match(workerSource, /"supplies_in"/);
  assert.match(workerSource, /"supplies_out"/);
  assert.match(workerSource, /"supplies_delete"/);
  assert.match(workerSource, /path === "\/insumos" \|\| path\.startsWith\("\/api\/supplies"\)/);
  assert.match(workerSource, /env\.DB\.prepare\("SELECT \* FROM supply_items"\)\.all\(\)/);
  assert.match(workerSource, /env\.DB\.prepare\("SELECT \* FROM supply_request_events"\)\.all\(\)/);
  assert.match(workerSource, /supplyItems: supplyItems\.results \?\? \[\]/);
  assert.match(workerSource, /supplyRequestEvents: supplyRequestEvents\.results \?\? \[\]/);
  assert.match(liveEvents, /path === "\/api\/supplies" \|\| path\.startsWith\("\/api\/supplies\/"\)/);
  assert.match(liveEvents, /module: "supplies"/);

  assert.match(route, /const canChooseCompany = canSeeAllStores\(actor, "supplies:request"\)/);
  assert.match(route, /!canSeeAllStores\(actor, "supplies:receive"\) && existing\.companyId !== actor\.companyId/);
  assert.match(route, /INSERT INTO supply_request_events/);
  assert.match(route, /ON CONFLICT \(supply_item_id, request_date\) DO NOTHING/);
  assert.match(route, /request_date/);
  assert.match(route, /SET status='received'/);
  assert.match(route, /received_at=CURRENT_TIMESTAMP/);
  assert.match(route, /REGISTRE O PEDIDO DESTE INSUMO ANTES DO RECEBIMENTO/);
  assert.match(route, /export async function DELETE/);
  assert.match(route, /!can\(actor, "supplies:delete"\)/);
  assert.match(route, /VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR UMA SOLICITAÇÃO DE INSUMO/);
  assert.match(route, /DELETE FROM supply_request_events WHERE supply_item_id=\?1/);
  assert.match(route, /DELETE FROM supply_items WHERE id=\?1/);
  assert.match(route, /timeZone: "America\/Recife"/);
  assert.match(schema, /export const supplyItems = pgTable/);
  assert.match(schema, /export const supplyRequestEvents = pgTable/);
  assert.match(migration, /CREATE TABLE `supply_items`/);
  assert.match(migration, /CREATE TABLE `supply_request_events`/);
  assert.match(migration, /supply_items_company_status_created_idx/);
  assert.match(migration, /supply_request_events_item_date_unique/);
  assert.match(migration, /PRAGMA optimize/);
  assert.match(manifest, /"url": "\/insumos"/);
  assert.match(serviceWorker, /CACHE_NAME = "estoque-unigames-v59"/);
});

test("publica instruções para todas as lojas e preserva o histórico automático", async () => {
  const [html, workerSource, route, schema, migration, manifest, serviceWorker] =
    await Promise.all([
      readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
      readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/instructions/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
      readFile(new URL("../drizzle-sqlite-legacy/0006_omniscient_spectrum.sql", import.meta.url), "utf8"),
      readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
      readFile(new URL("../public/service-worker.js", import.meta.url), "utf8"),
    ]);

  assert.match(html, /id="navInstrucoes" data-page="instrucoes"/);
  assert.doesNotMatch(html, /id="navInstrucoes"[^>]*data-permission/);
  assert.match(html, /data-home-target="instrucoes"/);
  assert.match(html, /id="homeInstructionList"/);
  assert.match(html, /id="pageInstrucoes" class="page wrap"/);
  assert.match(html, /id="instructionForm"/);
  assert.match(html, /id="instructionDueDate" type="date" required/);
  assert.match(html, /PUBLICAR PARA TODAS AS LOJAS/);
  assert.match(html, /data-instruction-view="active"/);
  assert.match(html, /data-instruction-view="history"/);
  assert.match(html, /Após o prazo, a instrução sai da lista vigente e permanece no histórico/);
  assert.match(html, /instrucoes:'\/instrucoes'/);
  assert.match(html, /loadHomeInstructions/);

  assert.match(workerSource, /"\/instrucoes"/);
  assert.match(workerSource, /path === "\/instrucoes" \|\| \(path\.startsWith\("\/api\/instructions"\)/);
  assert.match(workerSource, /env\.DB\.prepare\("SELECT \* FROM instructions"\)\.all\(\)/);
  assert.match(workerSource, /instructions: instructions\.results \?\? \[\]/);
  assert.match(route, /!canManageInstructions\(actor\)/);
  assert.match(route, /VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR INSTRUÇÕES/);
  assert.match(html, /data-permission="instructions:manage"/);
  assert.match(html, /canAccess\('instructions:manage'\)/);
  assert.match(route, /due_date < \?1/);
  assert.match(route, /due_date >= \?1/);
  assert.match(route, /America\/Recife/);
  assert.match(route, /INSERT INTO instructions/);
  assert.match(schema, /export const instructions = pgTable/);
  assert.match(migration, /CREATE TABLE `instructions`/);
  assert.match(migration, /instructions_due_date_created_idx/);
  assert.match(manifest, /"url": "\/instrucoes"/);
  assert.match(serviceWorker, /CACHE_NAME = "estoque-unigames-v59"/);
});

test("registra e controla solicitações de Alterações PDV com permissões granulares", async () => {
  const [html, workerSource, route, schema, migration] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/pdv-requests/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0015_little_ronan.sql", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="navSolicitacoes"/);
  assert.match(html, /id="navAlteracoesPdv" data-page="alteracoesPdv" data-permission="pdv_requests"/);
  assert.match(html, /id="pageAlteracoesPdv" class="page wrap"/);
  assert.match(html, /id="pdvRequestForm"/);
  assert.match(html, /data-pdv-type-fields="observation"/);
  assert.match(html, /data-pdv-type-fields="payment"/);
  assert.match(html, /data-pdv-type-fields="seller"/);
  assert.match(html, /data-pdv-type-fields="customer"/);
  assert.match(html, /data-pdv-type-fields="product"/);
  assert.match(html, /data-pdv-type-fields="markup"/);
  assert.match(html, /data-pdv-type-fields="cancellation"/);
  assert.match(html, /data-pdv-mode="search"/);
  assert.match(html, /id="pdvSearchSaleId"/);
  assert.match(html, /data-pdv-status="open"/);
  assert.match(html, /data-pdv-status="done"/);
  assert.match(html, /data-pdv-status="not_done"/);
  assert.match(html, /data-pdv-status="doubt"/);
  assert.match(html, /value="pdv_requests:view"> Visualização/);
  assert.match(html, /value="pdv_requests:create"> Cadastro/);
  assert.match(html, /value="pdv_requests:delete"> Exclusão/);
  assert.match(html, /value="pdv_requests:status"> Alteração de status/);
  assert.match(
    html,
    /id="navAlteracoesPdv" data-page="alteracoesPdv" data-permission="pdv_requests" data-home-desc="[^"]+"/,
  );
  assert.match(html, /alteracoesPdv:'\/solicitacoes\/alteracoes-pdv'/);

  assert.match(
    workerSource,
    /"pdv_requests:view" \| "pdv_requests:create" \| "pdv_requests:delete" \| "pdv_requests:status"/,
  );
  assert.match(workerSource, /"\/solicitacoes\/alteracoes-pdv"/);
  assert.match(
    workerSource,
    /path === "\/solicitacoes\/alteracoes-pdv" \|\| path\.startsWith\("\/api\/pdv-requests"\)/,
  );

  assert.match(route, /!can\(actor, "pdv_requests:create"\)/);
  assert.match(route, /!can\(actor, "pdv_requests:status"\)/);
  assert.match(route, /!can\(actor, "pdv_requests:delete"\)/);
  assert.match(route, /VALUES \(\?1, \?2, \?3, \?4, \?5, 'open'/);
  assert.match(route, /INSERT INTO pdv_change_requests/);
  assert.match(route, /DELETE FROM pdv_change_requests WHERE id=\?1/);
  assert.match(route, /REQUIRED_DETAIL_FIELDS/);

  assert.match(schema, /export const pdvChangeRequests = pgTable/);
  assert.match(migration, /CREATE TABLE "pdv_change_requests"/);
  assert.match(migration, /pdv_change_requests_sale_idx/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
});

test("registra, anexa e expira automaticamente o PDF das Notas de O.S. com permissões granulares por loja", async () => {
  const [html, workerSource, route, attachmentRoute, fileRoute, shared, schema, migration] =
    await Promise.all([
      readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
      readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/os-notes/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/os-notes/attachment/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/os-notes/file/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/documents/shared.ts", import.meta.url), "utf8"),
      readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
      readFile(new URL("../drizzle/0024_tired_exiles.sql", import.meta.url), "utf8"),
    ]);

  assert.match(html, /id="navNotasOs" data-page="notasOs" data-permission="os_notes"/);
  assert.match(html, /id="pageNotasOs" class="page wrap"/);
  assert.match(html, /id="osNoteForm"/);
  assert.match(html, /id="osNoteCompanyField" hidden/);
  assert.match(html, /id="osNoteAttachInput"/);
  assert.match(html, /data-os-note-status="pending"/);
  assert.match(html, /data-os-note-status="attached"/);
  assert.match(html, /value="os_notes:view"> Visualização/);
  assert.match(html, /value="os_notes:create"> Cadastro/);
  assert.match(html, /value="os_notes:attach"> Anexar nota \(PDF\)/);
  assert.match(html, /value="os_notes:delete"> Exclusão/);
  assert.match(html, /notasOs:'\/solicitacoes\/notas-os'/);
  assert.match(html, /data-any-permission="pdv_requests,os_notes"/);

  assert.match(
    workerSource,
    /"os_notes:view" \| "os_notes:create" \| "os_notes:attach" \| "os_notes:delete"/,
  );
  assert.match(workerSource, /"\/solicitacoes\/notas-os"/);
  assert.match(
    workerSource,
    /path === "\/solicitacoes\/notas-os" \|\| path\.startsWith\("\/api\/os-notes"\)/,
  );
  assert.match(workerSource, /async function purgeOldOsNotes\(env: Env\)/);
  assert.match(workerSource, /purgeOldOsNotes\(env\)/);
  assert.match(workerSource, /cutoff\.setUTCDate\(cutoff\.getUTCDate\(\) - 30\)/);

  assert.match(route, /!can\(actor, "os_notes:create"\)/);
  assert.match(route, /!can\(actor, "os_notes:delete"\)/);
  assert.match(route, /canSeeAllOsNoteStores/);
  assert.match(route, /INSERT INTO os_notes/);
  assert.match(route, /'pending'/);

  assert.match(attachmentRoute, /!can\(actor, "os_notes:attach"\)/);
  assert.match(attachmentRoute, /looksLikePdf/);
  assert.match(attachmentRoute, /status='attached'/);
  assert.match(attachmentRoute, /file_removed_at=''/);

  assert.match(fileRoute, /row\.companyId !== actor\.companyId/);
  assert.match(fileRoute, /O ANEXO DESTA SOLICITAÇÃO JÁ FOI REMOVIDO/);

  assert.match(shared, /export function looksLikePdf/);
  assert.match(shared, /export function safeR2FileName/);

  assert.match(schema, /export const osNotes = pgTable/);
  assert.match(migration, /CREATE TABLE "os_notes"/);
  assert.match(migration, /os_notes_os_id_idx/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
});

test("cadastra aparelhos de empréstimo, controla solicitações das lojas e o selo de dias em atraso com permissões granulares", async () => {
  const [html, workerSource, devicesRoute, requestsRoute, commentsRoute, schema, migration, returnMigration, accessoriesMigration, liveUpdates, liveEvents] =
    await Promise.all([
      readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
      readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/loans/devices/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/loans/requests/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/loans/requests/comments/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
      readFile(new URL("../drizzle/0025_gigantic_diamondback.sql", import.meta.url), "utf8"),
      readFile(new URL("../drizzle/0026_purple_meggan.sql", import.meta.url), "utf8"),
      readFile(new URL("../drizzle/0027_rich_black_widow.sql", import.meta.url), "utf8"),
      readFile(new URL("../worker/live-updates.ts", import.meta.url), "utf8"),
      readFile(new URL("../worker/live-events.ts", import.meta.url), "utf8"),
    ]);

  assert.match(
    html,
    /id="navAparelhosEmprestimo" data-page="aparelhosEmprestimo" data-permission="loans"/,
  );
  assert.match(html, /id="pageAparelhosEmprestimo" class="page wrap"/);
  assert.match(html, /aparelhosEmprestimo:'\/aparelhos-emprestimo'/);
  assert.match(html, /aparelhosEmprestimo:'loans'/);
  assert.match(html, /value="loans:view"> Visualizar/);
  assert.match(html, /value="loans:create"> Cadastrar aparelho/);
  assert.match(html, /value="loans:edit"> Editar aparelho/);
  assert.match(html, /value="loans:delete"> Excluir aparelho/);
  assert.match(html, /value="loans:request"> Solicitar aparelho \(loja\)/);
  assert.match(html, /value="loans:manage_requests"> Gerenciar solicitações/);
  assert.match(html, /id="loanDeviceForm"/);
  assert.match(html, /id="loanAvailableBody"/);
  assert.match(html, /id="loanStoreRequestsBody"/);
  assert.match(html, /id="loanDevicesBody"/);
  assert.match(html, /id="loanRequestsBody"/);
  assert.match(html, /id="loanRequestDetailsDialog"/);
  assert.match(html, /id="btnMarkLoanLoaned" type="button" data-permission="loans:manage_requests"/);
  assert.match(html, /id="btnMarkLoanReturned" type="button" data-permission="loans:manage_requests"/);
  assert.match(html, /id="btnDeleteLoanRequest" type="button" data-permission="loans:manage_requests"/);
  assert.match(html, /returned:'DEVOLVIDO'/);
  assert.match(html, /DATA DO RETORNO/);
  assert.match(html, /id="loanRequestUpdateForm" data-permission="loans:manage_requests"/);
  assert.match(html, /\.status-pill\.alert\{/);
  assert.match(html, /const LOAN_ALERT_DAYS = 15;/);
  assert.match(html, /operator:\[.*'loans:view','loans:request'\]/);

  assert.match(
    workerSource,
    /"loans:view" \| "loans:create" \| "loans:edit" \| "loans:delete" \| "loans:request" \| "loans:manage_requests"/,
  );
  assert.match(workerSource, /"\/aparelhos-emprestimo"/);
  assert.match(
    workerSource,
    /path === "\/aparelhos-emprestimo" \|\| path\.startsWith\("\/api\/loans"\), "loans"/,
  );
  assert.match(
    workerSource,
    /loans: \[\s*"loans:view", "loans:create", "loans:edit", "loans:delete", "loans:request", "loans:manage_requests",\s*\]/,
  );
  assert.match(workerSource, /"loans:view", "loans:request",\s*\],\s*\n\s*assistance:/);

  assert.match(devicesRoute, /actor\.permissions\.includes\("loans:create"\)/);
  assert.match(devicesRoute, /actor\.permissions\.includes\("loans:edit"\)/);
  assert.match(devicesRoute, /actor\.permissions\.includes\("loans:delete"\)/);
  assert.match(devicesRoute, /WHERE status='available' ORDER BY name ASC/);
  assert.match(devicesRoute, /INSERT INTO loan_devices/);
  assert.match(devicesRoute, /accessories/);

  assert.match(html, /id="loanDeviceAccessories"/);
  assert.match(html, />Acessórios</);

  assert.match(requestsRoute, /canManageRequests\(actor\)/);
  assert.match(requestsRoute, /canRequest\(actor\)/);
  assert.match(requestsRoute, /device\.status !== "available"/);
  assert.match(requestsRoute, /action !== "loan" && action !== "return"/);
  assert.match(requestsRoute, /UPDATE loan_devices/);
  assert.match(requestsRoute, /status='loaned', current_company_id=/);
  assert.match(requestsRoute, /status='returned', returned_by=/);
  assert.match(requestsRoute, /status='available', current_company_id=''/);
  assert.match(requestsRoute, /existing\.status !== "loaned"/);
  assert.match(requestsRoute, /DELETE FROM loan_request_updates WHERE request_id=\?1/);

  assert.match(commentsRoute, /canManageRequests\(actor\)/);
  assert.match(commentsRoute, /INSERT INTO loan_request_updates/);

  assert.match(schema, /export const loanDevices = pgTable/);
  assert.match(schema, /export const loanRequests = pgTable/);
  assert.match(schema, /export const loanRequestUpdates = pgTable/);
  assert.match(schema, /returnedAt: text\("returned_at"\)/);
  assert.match(migration, /CREATE TABLE "loan_devices"/);
  assert.match(migration, /CREATE TABLE "loan_requests"/);
  assert.match(migration, /CREATE TABLE "loan_request_updates"/);
  assert.match(migration, /loan_requests_company_status_created_idx/);
  assert.match(migration, /ALTER TABLE "loan_devices" ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /ALTER TABLE "loan_requests" ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /ALTER TABLE "loan_request_updates" ENABLE ROW LEVEL SECURITY/);
  assert.match(returnMigration, /ADD COLUMN "returned_by"/);
  assert.match(returnMigration, /ADD COLUMN "returned_by_name"/);
  assert.match(returnMigration, /ADD COLUMN "returned_at"/);
  assert.match(accessoriesMigration, /ADD COLUMN "accessories"/);
  assert.match(schema, /accessories: text\("accessories"\)/);

  assert.match(liveUpdates, /"missions", "captures", "supplies", "tasks", "loans"/);
  assert.match(workerSource, /loans: "loans",\s*\n\s*\};/);
  assert.match(html, /aparelhosEmprestimo:'loans'/);
  assert.match(
    html,
    /if\(livePageName === 'aparelhosEmprestimo'\)\{\s*\n\s*await loadLoans\(\);/,
  );
  assert.match(liveEvents, /path === "\/api\/loans\/devices" \|\| path\.startsWith\("\/api\/loans\/requests"\)/);
  assert.match(liveEvents, /return \{ module: "loans", audience: \{ kind: "all" \} \};/);
  assert.match(
    liveEvents,
    /return \{ module: "loans", audience: \{ kind: "company", companyId, groups: \["loans_manage"\] \} \};/,
  );
  assert.match(workerSource, /if \(hasPermission\(user, "loans:manage_requests"\)\) groups\.push\("loans_manage"\);/);
  // Precisa existir tanto em navigateToPage() (clique no menu) quanto em
  // syncPageFromLocation() (URL direta/refresh) — só num dos dois já
  // deixou a página travada em "Carregando..." ao abrir a URL direto.
  const loadLoansOnPageEnter = html.match(/if\(name === 'aparelhosEmprestimo'\) loadLoans\(\);/g) || [];
  assert.equal(loadLoansOnPageEnter.length, 2);
});

test("formata timestamps do banco no horário de Brasília/Recife em um único ponto do app", async () => {
  const html = await readFile(
    new URL("../public/estoque.html", import.meta.url),
    "utf8",
  );

  assert.match(html, /function formatDateTimeBR\(value\)/);
  assert.match(html, /timeZone:'America\/Recife'/);

  // As implementações antigas e duplicadas (uma por módulo) foram
  // substituídas por chamadas à função central.
  assert.match(html, /function outputDateTime\(value\)\{\s*return formatDateTimeBR\(value\) \|\| '—';\s*\}/);
  assert.match(html, /function captureDateTime\(value\)\{\s*return formatDateTimeBR\(value\) \|\| '—';\s*\}/);
  assert.match(html, /function report41DateTime\(value\)\{\s*return formatDateTimeBR\(value\) \|\| 'ATUALIZADO';\s*\}/);
  assert.match(html, /function formatDocumentDate\(value\)\{\s*return formatDateTimeBR\(value\) \|\| 'DATA NÃO INFORMADA';\s*\}/);
  assert.match(html, /supplyItemTimestampHtml[\s\S]{0,200}formatDateTimeBR\(dateValue\)/);
  assert.match(html, /supplyStockMovementRowHtml[\s\S]{0,120}formatDateTimeBR\(movement\.createdAt\)/);
  assert.match(html, /supplyExitHistoryRowHtml[\s\S]{0,120}formatDateTimeBR\(movement\.createdAt\)/);
});

test("simplifica os indicadores e filtros do estoque fiscal", async () => {
  const html = await readFile(
    new URL("../public/estoque.html", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(html, /<span class="company-label">Visão<\/span>/);
  assert.doesNotMatch(html, /Sem cadastro no catálogo/);
  assert.doesNotMatch(html, /id="cardNaoCadastrado"/);
  assert.doesNotMatch(html, /el\('cardNaoCadastrado'\)/);
  assert.match(html, /\.summary\{display:grid; grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
});

test("reclassifica o sidebar e oferece início Lightglass com acessos rápidos", async () => {
  const html = await readFile(
    new URL("../public/estoque.html", import.meta.url),
    "utf8",
  );

  assert.match(
    html,
    /id="navInicio"[\s\S]*class="nav-label">Início<[\s\S]*id="navEstoque"[\s\S]*id="navPuxadas"[\s\S]*id="navDashboard"[\s\S]*class="nav-label">Estoque Fiscal<[\s\S]*id="navCompras"[\s\S]*id="navSaidas"[\s\S]*id="navCadastros"/,
  );
  assert.match(html, /class="nav-item sub-item" id="navPuxadas"[\s\S]*class="nav-item sub-item" id="navSaidas"/);
  assert.match(html, /id="navLojas"[\s\S]*class="nav-item sub-item" id="navDados"/);
  assert.match(html, /id="pageInicio" class="page wrap home-page active"/);
  assert.match(html, /class="home-lightglass"/);
  assert.match(html, /class="home-brand-logo" data-logo alt="LOGO UNIGAMES"/);
  assert.match(html, /id="navPuxadas"[^>]*data-home-desc=/);
  assert.match(html, /id="navCompras"[^>]*data-home-desc=/);
  assert.doesNotMatch(html, /id="navDashboard"[^>]*data-home-desc=/);
  assert.match(html, /id="navCaptacao" data-page="captacao" data-permission="captures" data-home-desc=/);
  assert.match(html, /id="navCadastros"[^>]*data-home-page="cadastros"/);
  assert.match(html, /id="homeAccessGrid" aria-label="Acessos rápidos"><\/div>/);
  assert.match(html, /function buildHomeAccessCards\(\)/);
  assert.match(html, /document\.querySelectorAll\('#sidebar \[data-home-desc\]'\)/);
  assert.match(html, /Atividades diárias e semanais que precisam ser realizadas pela loja/);
  assert.match(html, /\.home-operation-head > div > span\{/);
  assert.match(html, /html\[data-theme="light"\] \.home-missions\{/);
  assert.match(html, /get\('entrada'\) === '1'/);
  assert.match(html, /document\.title = 'UNIGAMES'/);
  assert.match(html, /document\.querySelectorAll\('\[data-home-target\]'\)/);
  assert.match(html, /\.page\.home-page\.active\{display:flex;\}/);
  assert.doesNotMatch(html, /\.home-page\{[^}]*display:flex/);
  assert.match(html, /@media \(max-width:800px\)[\s\S]*\.home-access-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\);\}/);
  assert.match(html, /@media \(max-width:520px\)[\s\S]*\.home-access-grid\{grid-template-columns:1fr;/);
  assert.doesNotMatch(html, /data-dashboard-home/);
  for (const pageId of ["pagePuxadas", "pageRelatorio41", "pageCompras", "pageDashboard", "pageMissoes", "pageSaidas", "pageInsumos", "pageInstrucoes", "pageLojas", "pageDados"]) {
    assert.match(html, new RegExp(`id="${pageId}" class="page wrap"`));
  }
});

test("separa o Relatório 41 por loja, usa estoque geral e gera o TXT oficial", async () => {
  const [html, workerSource, sharedStateRoute, schema, migration] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/shared-state/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle-sqlite-legacy/0004_short_nighthawk.sql", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="navRelatorio41" data-page="relatorio41" data-permission="report41" data-home-desc=/);
  assert.match(html, /id="pageRelatorio41" class="page wrap"/);
  assert.match(html, /id="report41StoreSelect"/);
  assert.match(html, /id="btnReport41SalesUpload"/);
  assert.match(html, /id="btnReport41StockUpload"/);
  assert.match(html, /id="btnCompanyStockUpload"/);
  assert.match(html, /id="userCompanyId"/);
  assert.match(html, /REPORT41_EXCLUDED_PRODUCT_TERMS = new Set\(\['indicacao','cortesia','garantia','frete'\]\)/);
  assert.match(html, /function report41ExcludedProduct\(name\)/);
  assert.match(html, /if\(report41ExcludedProduct\(nome\)\) continue/);
  assert.match(html, /function buildReport41Rows\(\)/);
  assert.match(html, /if\(mainStock > 1\) continue/);
  assert.match(html, /function exportReport41Txt\(\)/);
  assert.match(html, /function downloadBlobFile\(blob,fileName\)/);
  assert.match(html, /id="report41TxtHint"/);
  assert.match(html, /el\('btnReport41Txt'\)\.disabled = report41Rows\.length === 0/);
  assert.doesNotMatch(html, /btnReport41Txt'\)\.disabled = report41Rows\.length === 0 \|\|/);
  assert.match(html, /Consultando novamente o estoque geral da empresa/);
  assert.match(html, /await loadCompanyStock\(\)/);
  assert.match(html, /O estoque geral está cadastrado, mas não foi possível consultá-lo agora/);
  assert.match(html, /isIosDevice[\s\S]*deliverIosFile\(blob,fileName,'RELATÓRIO 41'\)/);
  assert.match(html, /\['\*RELATORIO 41\*',''\]/);
  assert.match(html, /EMPRESA: '\+report41TwoDigits/);
  assert.match(html, /report41-siren[\s\S]*🚨/);
  assert.match(html, /report41:company-stock/);
  assert.match(html, /report41:store:/);
  assert.match(html, /relatorio41:'\/relatorio-41'/);
  assert.match(html, /value="report41:view"> Visualizar/);
  assert.match(workerSource, /"\/relatorio-41"/);
  assert.match(workerSource, /\[path === "\/relatorio-41", "report41"\]/);
  assert.match(workerSource, /reportStoreMatch[\s\S]*user\.companyId/);
  assert.match(workerSource, /company_id AS companyId/);
  assert.match(workerSource, /fiscal: \[\s*"missions:view",\s*"outputs:view", "outputs:create",\s*"supplies:view", "supplies:request", "supplies:receive", "supplies:stock_out",\s*"stock:view",\s*"database:view", "database:manage",\s*"pulls:view",\s*"report41:view",\s*\]/);
  assert.match(sharedStateRoute, /key === "report41:company-stock"/);
  assert.match(sharedStateRoute, /report41:store:c\[a-z0-9\]/);
  assert.match(schema, /companyId: text\("company_id"\)/);
  assert.match(migration, /ALTER TABLE `app_users` ADD `company_id`/);
});

test("abre o menu de cadastros e encaminha para lojas ou base de dados", async () => {
  const html = await readFile(
    new URL("../public/estoque.html", import.meta.url),
    "utf8",
  );

  assert.match(html, /id="pageCadastros" class="page wrap"/);
  assert.match(html, /class="cadastros-menu"/);
  assert.match(html, /data-cadastro-target="lojas"[\s\S]*<strong>LOJAS<\/strong>/);
  assert.match(html, /data-cadastro-target="dados"[\s\S]*<strong>BASE DE DADOS<\/strong>/);
  assert.match(html, /id="navDados" data-page="dados"[\s\S]*class="nav-label">Base de Dados<\/span><\/a>/);
  assert.match(html, /id="navCadastros" type="button" aria-expanded="false" aria-controls="navCadastrosSubmenu"/);
  assert.match(html, /id="navCadastrosSubmenu" aria-hidden="true"/);
  assert.match(html, /\.nav-group-toggle\[aria-expanded="true"\] \+ \.nav-submenu/);
  assert.match(html, /function setCadastrosExpanded\(expanded\)/);
  assert.match(html, /setCadastrosExpanded\(!expanded\)/);
  assert.match(html, /document\.querySelectorAll\('\[data-cadastro-target\]'\)/);
  assert.match(html, /navigateToPage\(button\.dataset\.cadastroTarget\)/);
});

test("oculta a sidebar no inicio e exibe o acesso nos demais modulos", async () => {
  const html = await readFile(
    new URL("../public/estoque.html", import.meta.url),
    "utf8",
  );

  assert.match(html, /<body class="home-active">/);
  assert.match(html, /body\.home-active \.menu-toggle\{display:none;\}/);
  assert.match(html, /document\.body\.classList\.toggle\('home-active', isHome\)/);
  assert.match(html, /if\(isHome\) setSidebarOpen\(false, false\)/);
});

test("mantém uma URL por módulo e integra voltar e avançar do navegador", async () => {
  const [html, manifest, homePage, workerSource] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
  ]);

  assert.match(html, /inicio:'\/inicio'/);
  assert.match(html, /puxadas:'\/puxadas'/);
  assert.match(html, /relatorio41:'\/relatorio-41'/);
  assert.match(html, /compras:'\/compras'/);
  assert.match(html, /dashboard:'\/estoque'/);
  assert.match(html, /lojas:'\/cadastros\/lojas'/);
  assert.match(html, /dados:'\/cadastros\/base-de-dados'/);
  assert.match(html, /history\[method\]\(\{page:name\}, '', route\)/);
  assert.match(html, /window\.addEventListener\('popstate'/);
  assert.match(html, /href="\/manifest\.webmanifest"/);
  assert.match(html, /register\('\/service-worker\.js'\)/);
  assert.equal(JSON.parse(manifest).start_url, "/inicio");
  assert.match(homePage, /redirect\("\/inicio"\)/);
  assert.match(workerSource, /APP_ROUTE_PATHS/);
  assert.match(workerSource, /new URL\("\/estoque\.html", request\.url\)/);
});

test("aplica o sistema visual responsivo sem alterar os módulos existentes", async () => {
  const html = await readFile(
    new URL("../public/estoque.html", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(html, /body\{[^}]*text-transform:uppercase/);
  assert.match(html, /class="page-header"/);
  assert.match(html, /class="mobile-tabbar no-print"/);
  assert.match(html, /id="btnSidebarCompact"/);
  assert.match(html, /class="nav-icon"/);
  assert.match(html, /id="homeStoreUpdates"/);
  assert.match(html, /id="homePurchaseProgress"/);
  assert.match(html, /function loadHomeOverview\(\)/);
  assert.match(html, /class="density-toggle"/);
  assert.match(html, /data-purchase-density="compact"/);
  assert.match(html, /<details class="purchase-files">/);
  assert.match(html, /tone-'\+tone/);
  assert.match(html, /function renderPurchaseSkeletons\(\)/);
  assert.match(html, /\.responsive-table tbody td::before/);
  assert.match(html, /data-label="Produto"/);
  assert.match(html, /position:sticky; top:0/);
  assert.match(html, /body\.purchase-density-compact \.purchase-card/);
  assert.doesNotMatch(html, /<script defer src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/xlsx/);
  assert.match(html, /function ensureXlsx\(\)/);
  assert.match(html, /BASE GLOBAL DE RESPONSIVIDADE E DESEMPENHO/);
  assert.match(html, /min-height:100dvh/);
  assert.match(html, /@supports\(content-visibility:auto\)/);
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(html, /debounce\(renderCaptures,120\)/);
  assert.match(html, /function resumeTaskReminderMonitor\(\)/);
});

test("oferece documentos em PDF para todos os grupos e restringe a gestão ao administrador", async () => {
  const [html, workerSource, route, shared, fileRoute, schema, migration, wrangler] =
    await Promise.all([
      readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
      readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/documents/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/documents/shared.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/documents/file/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
      readFile(new URL("../drizzle/0012_documents.sql", import.meta.url), "utf8"),
      readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    ]);

  assert.match(html, /id="navDocumentos"/);
  assert.match(html, /data-document-folder="garantia-produto"/);
  assert.match(html, /data-document-folder="garantia-estendida"/);
  assert.match(html, /data-document-folder="documentos-avulsos"/);
  assert.match(html, /id="pageDocumentos" class="page wrap"/);
  assert.match(html, /id="documentsUploadForm"/);
  assert.match(html, /class="documents-upload-panel" data-admin-only/);
  assert.match(html, /accept="\.pdf,application\/pdf"/);
  assert.match(html, /documentos:'\/documentos'/);
  assert.match(html, /function navigateToDocumentFolder\(folder\)/);

  assert.match(workerSource, /"documents_manage"/);
  assert.match(workerSource, /ASSIGNABLE_PERMISSIONS/);
  assert.match(workerSource, /path === "\/documentos" \|\| path\.startsWith\("\/documentos\/"\)/);
  assert.match(workerSource, /path\.startsWith\("\/api\/documents"\)/);
  assert.match(workerSource, /hasPermission\(user, "documents_manage"\)/);

  assert.match(shared, /actor\.role === "admin"/);
  assert.match(shared, /actor\.permissions\.includes\("documents_manage"\)/);
  assert.match(shared, /const bucket = \(env as \{ UPLOADS\?: R2Bucket \}\)\.UPLOADS/);
  assert.match(shared, /\^%PDF-\[12\]/);
  assert.match(shared, /%%EOF/);
  assert.match(route, /INSERT INTO documents/);
  assert.match(route, /DELETE FROM documents WHERE id=\?1/);
  assert.match(shared, /download \? "attachment" : "inline"/);
  assert.match(fileRoute, /"content-type": row\.contentType \|\| "application\/pdf"/);

  assert.match(schema, /export const documents = pgTable/);
  assert.match(schema, /r2Key: text\("r2_key"\)/);
  assert.match(migration, /CREATE TABLE "documents"/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE "documents" FROM anon, authenticated/);
  assert.match(wrangler, /"binding": "UPLOADS"/);
  assert.equal((wrangler.match(/"r2_buckets"/g) || []).length, 1);
});

test("expõe o módulo Financeiro (DRE) e restringe o acesso a finance:manage", async () => {
  const [html, workerSource, shared, categoriesRoute, itemsRoute, entriesRoute, revenueRoute, dreShared, schema, migration] =
    await Promise.all([
      readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
      readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/finance/shared.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/finance/categories/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/finance/items/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/finance/entries/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/finance/revenue/route.ts", import.meta.url), "utf8"),
      // A montagem da DRE (buildStoreDre/buildConsolidatedDre/etc.) foi
      // extraída para dre/shared.ts na Fase 2 do Financeiro (Dashboard
      // Geral), pra ser reaproveitada sem duplicar a fórmula de
      // resultado/margem — route.ts ficou só com os handlers HTTP.
      readFile(new URL("../app/api/finance/dre/shared.ts", import.meta.url), "utf8"),
      readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
      readFile(new URL("../drizzle/0021_thin_lightspeed.sql", import.meta.url), "utf8"),
    ]);

  // Item de menu único (não é mais um nav-group com submenu de 3 páginas):
  // as 3 visões da DRE vivem dentro da mesma page/section, como abas.
  assert.match(html, /id="navFinanceiro" data-page="financeiro" data-permission="finance"/);
  assert.match(html, /id="pageFinanceiro" class="page wrap"/);
  assert.match(html, /financeiro:'\/financeiro\/dre'/);
  assert.match(html, /financeiro:'finance'/);
  assert.match(html, /function loadFinanceiroTab\(\)/);
  assert.match(html, /'finance:manage':'Financeiro: acessar módulo'/);
  assert.match(html, /canAccess\('finance'\)/);
  assert.match(html, /id="financeCatalogDialog"/);

  assert.match(workerSource, /"finance:manage"/);
  // finance: [...] agora inclui as permissões granulares do módulo NF/
  // Duplicatas (payables:*) além de finance:manage — ver
  // MODULE_VIEW_PERMISSIONS em worker/index.ts.
  assert.match(workerSource, /finance: \[\s*"finance:manage",/);
  assert.match(workerSource, /"\/financeiro\/dre"/);
  assert.match(
    workerSource,
    /path === "\/financeiro" \|\| path\.startsWith\("\/financeiro\/"\) \|\| path\.startsWith\("\/api\/finance"\)/,
  );

  assert.match(shared, /canManageFinance/);
  assert.match(shared, /actor\.permissions\.includes\("finance:manage"\)/);
  assert.match(categoriesRoute, /INSERT INTO finance_categories/);
  assert.match(itemsRoute, /INSERT INTO finance_items/);
  assert.match(itemsRoute, /finance_store_entries WHERE item_id=\?1/);
  assert.match(entriesRoute, /INSERT INTO finance_store_entries/);
  assert.match(revenueRoute, /INSERT INTO finance_store_revenue/);
  assert.match(dreShared, /FROM finance_store_entries WHERE store_id=\?1 AND month=\?2/);

  assert.match(schema, /export const financeCategories = pgTable/);
  assert.match(schema, /export const financeItems = pgTable/);
  assert.match(schema, /export const financeStoreEntries = pgTable/);
  assert.match(schema, /export const financeStoreRevenue = pgTable/);
  assert.match(migration, /CREATE TABLE "finance_categories"/);
  assert.match(migration, /CREATE TABLE "finance_store_entries"/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE "finance_store_revenue" FROM anon, authenticated/);
});

test("DRE por Loja permite excluir um lançamento e mantém os cards abertos após salvar/excluir", async () => {
  const [html, dreShared] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance/dre/shared.ts", import.meta.url), "utf8"),
  ]);

  // Botão de excluir lançamento por item, só aparece quando já existe um
  // lançamento (entryId presente).
  assert.match(html, /data-finance-delete-entry="'\+escapeHtml\(item\.entryId\)\+'"/);
  assert.match(
    html,
    /el\('dreCategoryList'\)\.addEventListener\('click', async event => \{[\s\S]{0,300}data-finance-delete-entry/,
  );
  assert.match(html, /financeApiRequest\('\/entries\?id='\+encodeURIComponent\(button\.dataset\.financeDeleteEntry\), \{method:'DELETE'\}\)/);

  // Cards de categoria/subgrupo carregam um id estável (data-finance-node-id)
  // e renderDreCategories() reabre os que já estavam abertos antes do
  // recarregamento — sem isso, cada save/delete fechava tudo de novo.
  assert.match(html, /data-finance-node-id="'\+escapeHtml\(category\.id\)\+'"/);
  assert.match(html, /data-finance-node-id="'\+escapeHtml\(subgroup\.id\)\+'"/);
  assert.match(
    html,
    /details\.dataset\.financeNodeId/,
  );

  assert.match(dreShared, /entryId: entry\?\.id \?\? null/);
  assert.match(dreShared, /SELECT id, item_id AS itemId, entry_type AS entryType/);
});

test("DRE Por Loja/Consolidada/Gerencial vivem na mesma página, alternadas por abas", async () => {
  const [html, dreRoute, dreShared] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance/dre/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance/dre/shared.ts", import.meta.url), "utf8"),
  ]);

  // Abas dentro de #pageFinanceiro, não páginas/itens de menu separados.
  assert.match(html, /data-dre-tab="porLoja"/);
  assert.match(html, /data-dre-tab="consolidada"/);
  assert.match(html, /data-dre-tab="gerencial"/);
  assert.match(html, /id="dreTabPorLoja"/);
  assert.match(html, /id="dreTabConsolidada" hidden/);
  assert.match(html, /id="dreTabGerencial" hidden/);
  assert.match(html, /function setDreActiveTab\(tab\)/);
  assert.doesNotMatch(html, /id="navDrePorLoja"/);
  assert.doesNotMatch(html, /id="navDreConsolidada"/);
  assert.doesNotMatch(html, /id="navDreGerencial"/);
  assert.doesNotMatch(html, /id="pageDrePorLoja"/);
  assert.doesNotMatch(html, /id="pageDreConsolidada"/);
  assert.doesNotMatch(html, /id="pageDreGerencial"/);

  assert.match(html, /function loadDrePorLoja\(\)/);
  assert.match(html, /function loadDreConsolidada\(\)/);
  // A Consolidada nunca abre itens individuais — só linhas por categoria.
  assert.match(html, /function renderDreConsolidadaCategories\(\)/);
  assert.doesNotMatch(
    html,
    /renderDreConsolidadaCategories[\s\S]{0,400}dre-item-row/,
  );
  assert.match(html, /function loadDreGerencial\(\)/);
  // Diferente da Consolidada, a Gerencial abre os itens (soma entre lojas)
  // dentro de cada categoria/subgrupo.
  assert.match(html, /function dreGerencialCategoryCardHtml\(category\)/);
  assert.match(html, /function dreGerencialItemRowHtml\(item\)/);

  assert.match(dreRoute, /scope === "consolidated"/);
  assert.match(dreShared, /FROM finance_store_entries WHERE month=\?1/);
  assert.match(dreShared, /FROM finance_store_revenue WHERE month=\?1/);
  // Percentual continua fora da soma de despesa também na Consolidada.
  assert.match(dreShared, /entry\?\.entryType === "fixed" \? entry\.amountCents \?\? 0 : 0/);
  assert.match(dreRoute, /scope === "managerial"/);
  assert.match(dreShared, /async function buildManagerialDre/);
  assert.match(dreShared, /async function loadMonthWideTotals/);
});

test("cron do worker sempre resolve o driver Postgres antes de rodar as rotinas agendadas", async () => {
  // Bug real já corrigido: o handler scheduled() usava o env cru do
  // Cloudflare (com binding D1) direto nas rotinas do cron. Como a
  // produção não tem mais D1 (DB_DRIVER=postgres, ver PR "remove binding
  // D1"), toda execução do cron quebrava silenciosamente logo no primeiro
  // env.DB.prepare(...) — e como a geração diária das tarefas de Rotina
  // Operacional (advanceOperationalRoutines) só acontece pelo cron, nenhuma
  // rotina cadastrada para um dia da semana diferente do dia do cadastro
  // chegava a aparecer para a loja. Este teste trava se alguma rotina do
  // cron voltar a usar o env cru (rawEnv) em vez do resolvido.
  const workerSource = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");

  const scheduledStart = workerSource.indexOf("async scheduled(");
  assert.notEqual(scheduledStart, -1, "método scheduled não encontrado em worker/index.ts");
  const bodyStart = workerSource.indexOf("{", workerSource.indexOf(")", scheduledStart));
  let depth = 0;
  let bodyEnd = -1;
  for (let index = bodyStart; index < workerSource.length; index++) {
    if (workerSource[index] === "{") depth++;
    if (workerSource[index] === "}") depth--;
    if (depth === 0) {
      bodyEnd = index + 1;
      break;
    }
  }
  assert.notEqual(bodyEnd, -1, "corpo do método scheduled incompleto");
  const scheduledBody = workerSource.slice(scheduledStart, bodyEnd);

  assert.match(scheduledBody, /const env = await resolvePostgresBackedEnv\(rawEnv\)/);
  assert.match(scheduledBody, /dispatchDueTaskNotifications\(env\)/);
  assert.match(scheduledBody, /dispatchDueMissionNotifications\(env\)/);
  assert.match(scheduledBody, /advanceOperationalRoutines\(env\)/);
  assert.match(scheduledBody, /createAutomaticBackup\(env, config\.sessionSecret\)/);
  assert.doesNotMatch(scheduledBody, /dispatchDueTaskNotifications\(rawEnv\)/);
  assert.doesNotMatch(scheduledBody, /dispatchDueMissionNotifications\(rawEnv\)/);
  assert.doesNotMatch(scheduledBody, /advanceOperationalRoutines\(rawEnv\)/);
  assert.doesNotMatch(scheduledBody, /createAutomaticBackup\(rawEnv,/);

  assert.match(workerSource, /async function resolvePostgresBackedEnv\(rawEnv: Env\): Promise<Env> \{/);
  assert.match(workerSource, /if \(process\.env\.DB_DRIVER !== "postgres"\) return rawEnv;/);
});

test("regra genérica: usuário sem loja com a permissão do módulo enxerga e age em todas as lojas", async () => {
  const [
    accessScope,
    outputsRoute,
    capturesRoute,
    capturesShared,
    missionsRoute,
    routinesRoute,
    suppliesRoute,
    suppliesMissingRoute,
    suppliesRequestsRoute,
    workerSource,
  ] = await Promise.all([
    readFile(new URL("../app/lib/access-scope.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/outputs/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/captures/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/captures/shared.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/routines/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/supplies/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/supplies/missing/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/supplies/requests/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
  ]);

  // O helper único existe e implementa a regra: admin sempre vê tudo; quem
  // tem loja fica preso a ela mesmo com a permissão; só quem NÃO tem loja é
  // que a permissão do módulo decide se vê/age em todas as lojas.
  assert.match(accessScope, /export function canSeeAllStores\(actor: ScopeActor, requiredPermission: string\): boolean \{/);
  assert.match(accessScope, /if \(actor\.role === "admin"\) return true;/);
  assert.match(accessScope, /if \(hasCompany\(actor\.companyId\)\) return false;/);
  assert.match(accessScope, /return actor\.permissions\.includes\(requiredPermission\);/);
  assert.match(accessScope, /export const NO_COMPANY_ERROR = "SEU USUÁRIO PRECISA ESTAR VINCULADO A UMA LOJA\."/);

  // Cada módulo afetado importa e reaproveita o helper central, em vez de
  // reimplementar a própria checagem (raiz do bug em Captação/Saídas/etc.).
  for (const [name, source] of [
    ["outputs/route.ts", outputsRoute],
    ["captures/route.ts", capturesRoute],
    ["captures/shared.ts", capturesShared],
    ["missions/route.ts", missionsRoute],
    ["routines/route.ts", routinesRoute],
    ["supplies/route.ts", suppliesRoute],
    ["supplies/missing/route.ts", suppliesMissingRoute],
    ["supplies/requests/route.ts", suppliesRequestsRoute],
  ]) {
    assert.match(source, /from ["'].*lib\/access-scope["']/, `${name} não importa o helper central`);
    assert.match(source, /canSeeAllStores\(/, `${name} não usa canSeeAllStores()`);
  }

  // Saídas: sem loja + outputs:view enxerga todas (não precisa mais das 4
  // permissões nem só do setor Administrativo).
  assert.match(outputsRoute, /canSeeAllStores\(actor, "outputs:view"\) \|\| isAdministrativeActor\(actor\)/);
  // Captação: idem para captures:view/receive/assign (view) e captures:create (cadastro).
  assert.match(capturesRoute, /canSeeAllStores\(actor, "captures:view"\) \|\|/);
  assert.match(capturesRoute, /canSeeAllStores\(actor, "captures:create"\)/);
  // Missões: sem loja + missions:view passa a poder escolher a loja no
  // filtro "store", igual ao administrador.
  assert.match(missionsRoute, /canSeeAllStores\(actor, "missions:view"\)/);
  assert.match(routinesRoute, /canSeeAllStores\(actor, "missions:view"\)/);
  // Insumos: view/request/receive cobertos nos três arquivos de rota.
  assert.match(suppliesRoute, /canSeeAllSupplyStores\(actor\)/);
  assert.match(suppliesMissingRoute, /canSeeAllStores\(actor, "supplies:request"\)/);
  assert.match(suppliesRequestsRoute, /canSeeAllStores\(actor, "supplies:request"\)/);
  assert.match(suppliesRequestsRoute, /canSeeAllStores\(actor, "supplies:receive"\)/);
  assert.match(suppliesRequestsRoute, /canSeeAllStores\(actor, "supplies:stock_out"\)/);

  // Relatório 41: mesma regra aplicada ao acesso por loja dentro do worker
  // (não é uma rota Next.js, então não importa o helper — a lógica vive
  // direto no gate do shared-state).
  assert.match(
    workerSource,
    /const hasFullAccessWithoutCompany = !user\.companyId && hasPermission\(user, "report41:view"\);/,
  );
  assert.match(workerSource, /if \(!boundToOwnStore && !hasFullAccessWithoutCompany\) return false;/);
});

test("regra genérica no front-end: canActAcrossStores() substitui os antigos gates isAdmin-only por módulo", async () => {
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");

  assert.match(html, /function canActAcrossStores\(permission\)\{/);
  assert.match(html, /if\(currentSession\.role === 'admin'\) return true;/);
  assert.match(html, /if\(currentSession\.companyId\) return false;/);
  assert.match(html, /return canAccess\(permission\);/);

  for (const permission of [
    "captures:create",
    "outputs:create",
    "supplies:request",
    "missions:view",
    "report41:view",
  ]) {
    assert.match(
      html,
      new RegExp(`canActAcrossStores\\('${permission}'\\)`),
      `nenhum uso de canActAcrossStores('${permission}') encontrado`,
    );
  }
});

test("Insumos: usuário sem loja com acesso total ao módulo enxerga e age em todas as abas do painel administrativo, como um admin", async () => {
  // Bug relatado: o usuário "Renato" (sem loja vinculada), mesmo com todas
  // as permissões de Insumos concedidas no cadastro, só conseguia
  // visualizar produtos — o painel inteiro (Dashboard, Categorias,
  // Produtos, Estoque, Separação, Histórico) e a maioria das ações
  // continuavam checando `currentSession.role === 'admin'` hardcoded no
  // front-end, e algumas rotas de API checavam `actor.role === "admin"`
  // hardcoded no backend, em vez da permissão granular real do usuário.
  const [html, stockRoute, productsRoute, dashboardRoute] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../app/api/supplies/stock/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/supplies/products/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/supplies/dashboard/route.ts", import.meta.url), "utf8"),
  ]);

  // Front-end: visibilidade do painel e de cada aba vem das permissões
  // granulares reais (espelha isSuppliesManager() do backend), não de uma
  // checagem isolada de role.
  assert.match(html, /function supplyAdminTabAccess\(\)\{/);
  assert.match(html, /const canManageCatalog = canAccess\('supplies:manage_catalog'\);/);
  assert.match(html, /const canStockIn = canAccess\('supplies:stock_in'\);/);
  assert.match(html, /const canStockOut = canAccess\('supplies:stock_out'\);/);
  assert.match(html, /const canDeleteSupplies = canAccess\('supplies:delete'\);/);
  assert.match(html, /const canSeparationQueue = canActAcrossStores\('supplies:stock_out'\);/);
  assert.match(
    html,
    /const hasAdminAccess = canManageCatalog \|\| canStockIn \|\| canStockOut \|\| canDeleteSupplies \|\| canSeparationQueue;/,
  );
  assert.match(html, /dashboard: hasAdminAccess,/);
  assert.match(html, /categorias: canManageCatalog,/);
  assert.match(html, /produtos: canManageCatalog,/);
  assert.match(html, /estoque: canStockIn \|\| canStockOut \|\| canDeleteSupplies,/);
  assert.match(html, /separacao: canSeparationQueue,/);
  assert.match(html, /historico: canSeparationQueue,/);
  assert.match(html, /el\('supplyAdminPanel'\)\.hidden = !access\.hasAdminAccess;/);
  assert.match(html, /button\.hidden = !access\.tabs\[button\.dataset\.supplyAdminTab\];/);
  assert.match(html, /if\(!supplyAdminTabAccess\(\)\.hasAdminAccess \|\| supplyDashboardLoading\) return;/);
  assert.match(html, /if\(!canActAcrossStores\('supplies:stock_out'\) \|\| supplyAdminHistoryLoading\) return;/);

  // O bug antigo era exatamente essas checagens isoladas de role — garante
  // que não voltam.
  assert.doesNotMatch(html, /el\('supplyAdminPanel'\)\.hidden = !isAdmin/);
  assert.doesNotMatch(html, /button\.hidden = !isAdmin && button\.dataset\.supplyAdminTab/);
  assert.doesNotMatch(html, /if\(currentSession\.role !== 'admin' \|\| supplyDashboardLoading\)/);
  assert.doesNotMatch(html, /if\(currentSession\.role !== 'admin' \|\| supplyAdminHistoryLoading\)/);

  // Backend: dashboard, produtos (lista com inativos) e movimentações de
  // estoque (visão entre lojas) usam a permissão granular real, não
  // `actor.role === "admin"` isolado.
  assert.match(dashboardRoute, /function isSuppliesManager\(actor: Identity\)/);
  assert.match(dashboardRoute, /if \(!isSuppliesManager\(actor\)\) \{/);
  assert.doesNotMatch(dashboardRoute, /if \(actor\.role !== "admin"\) \{/);

  assert.match(
    productsRoute,
    /\(actor\.role === "admin" \|\| actor\.permissions\.includes\("supplies:manage_catalog"\)\) &&/,
  );

  assert.match(stockRoute, /function isSuppliesManager\(actor: Identity\)/);
  assert.match(stockRoute, /const isManager = isSuppliesManager\(actor\);/);
  assert.match(stockRoute, /if \(isManager && COMPANY_PATTERN\.test\(requestedCompanyId\)\)/);
  assert.match(stockRoute, /if \(!isManager\) \{\s*\n\s*bindings\.push\(actor\.id\);/);
  assert.match(stockRoute, /const limit = isManager \? \(hasFilters \? 300 : 50\) : 20;/);
});

test("remove o fluxo especial de assistência: acesso 100% via permissões granulares", async () => {
  const [
    workerSource,
    captureShared,
    capturesRoute,
    captureUploadRoute,
    outputsRoute,
    suppliesRoute,
    suppliesRequestsRoute,
    suppliesMissingRoute,
    html,
  ] = await Promise.all([
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/captures/shared.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/captures/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/captures/upload/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/outputs/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/supplies/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/supplies/requests/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/supplies/missing/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
  ]);

  // Bug relatado: resolveAccessGroup forçava accessGroup="assistance" (e o
  // pacote fixo de permissões dessa preset) sempre que o username fosse
  // literalmente "assistencia" — mesmo que o admin tivesse escolhido "custom"
  // e concedido Insumos/Saídas manualmente no cadastro. Isso descartava
  // silenciosamente a escolha do admin tanto ao salvar (handleAdminUsers)
  // quanto ao resolver a sessão (storedUser/publicUser).
  assert.doesNotMatch(workerSource, /function resolveAccessGroup/);
  assert.doesNotMatch(workerSource, /if \(normalized === "assistencia"\) return "assistance";/);

  // Nenhum módulo mais detecta "é assistência?" por setor/grupo/nome de
  // usuário — nem em Captação (onde o fluxo existia) nem em Insumos/Saídas
  // (onde nunca deveria ter influenciado nada, mas o usuário suspeitou que
  // sim, já que a causa real — resolveAccessGroup — é global).
  for (const [name, source] of [
    ["worker/index.ts", workerSource],
    ["captures/shared.ts", captureShared],
    ["captures/route.ts", capturesRoute],
    ["captures/upload/route.ts", captureUploadRoute],
    ["outputs/route.ts", outputsRoute],
    ["supplies/route.ts", suppliesRoute],
    ["supplies/requests/route.ts", suppliesRequestsRoute],
    ["supplies/missing/route.ts", suppliesMissingRoute],
    ["estoque.html", html],
  ]) {
    assert.doesNotMatch(source, /isAssistanceActor/, `${name} ainda referencia isAssistanceActor`);
    assert.doesNotMatch(source, /isAssistanceSession/, `${name} ainda referencia isAssistanceSession`);
  }

  // O setor "Assistência" continua existindo só como metadado organizacional
  // (rótulo no cadastro), sem gate de acesso vinculado.
  assert.match(html, /sectorNames = \{administrative:'Administrativo',assistance:'Assistência'\}/);
  assert.match(html, /<option value="assistance">ASSISTÊNCIA<\/option>/);

  // Captação: quem recebe/prepara e define destino passa a ser controlado só
  // por captures:receive / captures:assign, sem bloqueio hardcoded pra criar.
  assert.match(html, /function canReceiveCaptures\(\)\{/);
  assert.match(html, /return currentSession\.role !== 'admin' && canAccess\('captures:receive'\);/);
  assert.doesNotMatch(capturesRoute, /A ASSISTÊNCIA NÃO PODE CADASTRAR PRODUTOS CAPTADOS/);
  assert.doesNotMatch(captureUploadRoute, /A ASSISTÊNCIA NÃO PODE CADASTRAR PRODUTOS CAPTADOS/);

  // Canal de aviso em tempo real (WebSocket) também passa a ser calculado
  // pela permissão granular, não mais por identidade.
  assert.match(workerSource, /function liveConnectionGroups\(user: AuthenticatedUser\): string\[\] \{/);
  assert.match(workerSource, /if \(hasPermission\(user, "captures:receive"\)\) groups\.push\("assistance"\);/);
});

test("Rotina Operacional: cadastro simplificado (sem descrição/loja específica, vários dias da semana) e geração auto-suficiente das tarefas", async () => {
  const [html, route, schema, migration, workerSource] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../app/api/routines/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0020_routine_weekdays.sql", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
  ]);

  // Cadastro só pede título + dias da semana (checkbox, permite mais de um).
  assert.match(html, /id="routineWeekdayGrid"/);
  assert.match(html, /name="routineWeekday" value="1"/);
  assert.match(html, /name="routineWeekday" value="0"/);
  assert.doesNotMatch(html, /id="routineDescription"/);
  assert.doesNotMatch(html, /id="routineScope"/);
  assert.doesNotMatch(html, /id="routineCompanyField"/);
  assert.doesNotMatch(html, /id="routineCompany"/);

  // Status vira feita/não feita (sem "em andamento") com botão de alternar.
  assert.match(html, /function routineStatusToggleHtml\(task,home\)\{/);
  assert.match(html, /'data-routine-toggle'/);
  assert.match(html, /'MARCAR COMO FEITA'/);
  assert.doesNotMatch(html, /data-routine-status/);

  // Exportar TXT da rotina do dia, formatado pra colar no WhatsApp.
  assert.match(html, /id="btnDownloadRoutineTxt"/);
  assert.match(html, /function routineTxtReport\(date\)\{/);
  assert.match(html, /'\*ROTINA OPERACIONAL - '\+companyName\.toUpperCase\(\)\+'\*'/);
  assert.match(html, /downloadBlobFile\(blob,'rotina-operacional-'\+date\+'\.txt'\)/);

  // Backend: rotina sempre geral, dias da semana em texto ("1,3,5"), e a
  // geração/migração de pendência roda a cada GET e POST — não depende só
  // do cron rodar no dia certo (causa raiz do bug de rotinas não aparecerem
  // pra loja quando cadastradas pra um dia futuro).
  assert.match(route, /function routineWeekdays\(value: unknown\): number\[\] \| null/);
  assert.match(route, /async function ensureRoutineTasksForDate\(database: D1Database, date: string\)/);
  assert.match(route, /await ensureRoutineTasksForDate\(database, date\);/);
  assert.match(route, /await ensureRoutineTasksForDate\(database, recifeDateKey\(\)\);/);
  assert.match(route, /VALUES \(\?1, \?2, 'general', \?3, \?4, \?5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP\)/);
  assert.match(route, /const ROUTINE_STATUSES = new Set<RoutineStatus>\(\["todo", "completed"\]\);/);
  assert.match(route, /import \{ canSeeAllStores \} from "\.\.\/\.\.\/lib\/access-scope";/);

  // Cron (rede de segurança, além da geração sob demanda no GET/POST) usa a
  // mesma lista de dias da semana em vez de um único valor fixo.
  assert.match(workerSource, /function parseRoutineWeekdays\(text: string\): number\[\]/);
  assert.match(workerSource, /SELECT id, weekdays FROM operational_routines WHERE active=1/);
  assert.match(workerSource, /parseRoutineWeekdays\(routine\.weekdays\)\.includes\(todayWeekday\)/);

  assert.match(schema, /weekdays: text\("weekdays"\)\.notNull\(\)\.default\(""\)/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "weekdays" text/);
  assert.match(migration, /UPDATE "operational_routines" SET "weekdays" = "weekday"::text/);
  assert.match(migration, /DROP COLUMN IF EXISTS "weekday"/);
});

test("tarefa marcada 'em andamento — próximo dia' aparece na agenda futura", async () => {
  const html = await readFile(
    new URL("../public/estoque.html", import.meta.url),
    "utf8",
  );

  // Regressão: syncTaskCarryover criava a tarefa copiada no dia seguinte com
  // outcome:'not_seen', mas loadTaskAgenda só lista na AGENDA FUTURA tarefas
  // com outcome==='carryover' (ver linha do filtro abaixo) — por isso a
  // tarefa nunca aparecia na agenda do dia seguinte mesmo sendo copiada.
  assert.match(
    html,
    /tasks:day\.tasks\.filter\(task => Boolean\(task\.carriedFrom\) && task\.outcome === 'carryover'\)/,
  );

  const store = new Map();
  const storage = {
    async get(key) {
      return store.has(key) ? { value: store.get(key) } : null;
    },
    async set(key, value) {
      store.set(key, value);
    },
  };

  const syncTaskCarryover = new Function(
    "storage",
    `${extractNamedFunction(html, "nextDateKey")}
     ${extractNamedFunction(html, "normalizeTaskData")}
     return async ${extractNamedFunction(html, "syncTaskCarryover")};`,
  )(storage);

  const sourceDate = "2026-08-21";
  const task = {
    id: "task-1",
    time: "09:00",
    text: "Conferir estoque",
    priority: "high",
  };

  await syncTaskCarryover(sourceDate, task, true);

  const nextDay = JSON.parse(store.get("tarefas:2026-08-22"));
  const carried = nextDay.tasks.find((item) => item.carriedFrom === sourceDate);
  assert.ok(carried, "tarefa copiada não encontrada no dia seguinte");
  assert.equal(
    carried.outcome,
    "carryover",
    "tarefa marcada como 'em andamento — próximo dia' deve manter outcome carryover para aparecer na agenda futura",
  );
});

test("Missões: abas Check-in, Check-out e Troca de Turno com checklists fixas que reiniciam por dia e completam a Rotina Operacional correspondente", async () => {
  const [html, route, schema, migration, workerSource] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../app/api/checklists/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0022_pale_marrow.sql", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
  ]);

  // Três abas novas ao lado de Rotina Operacional, nesta ordem.
  assert.match(html, /data-mission-section-tab="rotina">ROTINA OPERACIONAL</);
  assert.match(html, /data-mission-section-tab="checkin">CHECK-IN</);
  assert.match(html, /data-mission-section-tab="checkout">CHECK-OUT</);
  assert.match(html, /data-mission-section-tab="turno">TROCA DE TURNO</);
  assert.match(html, /id="missionSectionCheckin" hidden/);
  assert.match(html, /id="missionSectionCheckout" hidden/);
  assert.match(html, /id="missionSectionTurno" hidden/);

  // Itens marcáveis individualmente via checkbox, sem cadastro/edição.
  assert.match(html, /data-checklist-toggle="'\+tab\+'"/);
  assert.doesNotMatch(html, /checklistItemForm/);

  // Worker: /api/checklists cai no mesmo gate de permissão do módulo Missões.
  assert.match(workerSource, /\[path\.startsWith\("\/api\/checklists"\), "missions"\]/);

  // Itens fixos das 3 checklists (conteúdo do print anexado pelo usuário).
  assert.match(route, /checkin: \[/);
  assert.match(route, /"Ligar computadores",/);
  assert.match(route, /"Revisar Kanban",/);
  assert.match(route, /checkout: \[/);
  assert.match(route, /"Recolher lixo",/);
  assert.match(route, /"Postagem do cumprimento da rotina",/);
  assert.match(route, /shift_change: \["Atualizar o Kanban", "Bater o caixa"\]/);

  // Admin não marca item (mesma regra da Rotina Operacional) e usuário sem
  // loja vinculada também não pode.
  assert.match(route, /O ADMINISTRADOR NÃO PODE ALTERAR A CHECKLIST\./);
  assert.match(route, /SEU USUÁRIO PRECISA ESTAR VINCULADO A UMA LOJA\./);

  // Reinicia sozinho por dia: não há job de carryover/migração de pendência
  // como em Rotina Operacional — a data faz parte da chave de unicidade.
  assert.doesNotMatch(route, /carried_over|carriedOver/);
  assert.match(migration, /daily_checklist_items_unique" ON "daily_checklist_items" USING btree \("kind","item_key","company_id","date"\)/);

  // Integração: ao completar 100% da checklist do dia, marca a tarefa
  // correspondente na Rotina Operacional (por título normalizado) como
  // concluída, sem reverter se a checklist for desmarcada depois. Match por
  // substring, não igualdade exata — o admin cadastra títulos mais longos
  // na prática (ex.: "REALIZAR CHECK-IN", não só "Check-in").
  assert.match(route, /async function completeLinkedRoutineTask\(/);
  assert.match(route, /normalizeTitle\(task\.title\)\.includes\(target\)/);
  assert.match(
    route,
    /const ROUTINE_TITLE_MATCH: Record<ChecklistKind, string> = \{\s*checkin: "checkin",\s*checkout: "checkout",\s*shift_change: "trocadeturno",\s*\};/,
  );
  assert.match(route, /checklistComplete = Number\(doneCountRow\?\.doneCount \|\| 0\) >= CHECKLIST_ITEMS\[kind\]\.length;/);
  assert.match(route, /if \(checklistComplete\) \{\s*linkedRoutineCompleted = await completeLinkedRoutineTask/);

  // Quem não tem loja vinculada (admin ou acompanhamento geral) enxerga o
  // status item x loja de todas as lojas, mesmo padrão da Rotina
  // Operacional (lista plana com badge de loja), só que sem poder marcar.
  assert.match(route, /canSeeAllStores\(actor, "missions:view"\)/);
  assert.match(route, /allItems = companies\s*\.slice\(\)\s*\.sort\(\(a, b\) => a\.name\.localeCompare\(b\.name\)\)\s*\.flatMap\(/);
  assert.match(html, /function checklistOverviewRowHtml\(item\)\{/);
  assert.match(html, /data\.mine === false\)\{/);
  assert.match(html, /'NÃO FEITO'/);

  // Schema/migration da tabela nova, com RLS habilitada como as demais.
  assert.match(schema, /export const dailyChecklistItems = pgTable\(\s*"daily_checklist_items",/);
  assert.match(migration, /CREATE TABLE "daily_checklist_items"/);
  assert.match(migration, /ALTER TABLE "daily_checklist_items" ENABLE ROW LEVEL SECURITY;/);
  assert.match(migration, /REVOKE ALL ON TABLE "daily_checklist_items" FROM anon, authenticated;/);
});

test("titular de users:manage consegue salvar a própria conta sem ser bloqueado como escalação", async () => {
  const workerSource = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");

  // Bug relatado: usuário com users:manage delegado (ex.: Renato) não
  // conseguia clicar em SALVAR no próprio cadastro — o checkbox
  // "Gerenciar usuários" aparece marcado (mas desabilitado) no formulário,
  // então o payload sempre reenvia users:manage=true, e a checagem antiga
  // bloqueava qualquer edição de um usuário que já tivesse essa permissão,
  // inclusive a própria conta de quem a possui.
  assert.match(
    workerSource,
    /const isSelfEdit = existing\.id === actor\.id;/,
  );
  assert.match(
    workerSource,
    /const existingHadUsersManage = permissionsFromJson\(existing\.permissionsJson\)\.includes\("users:manage"\);/,
  );
  // Manter (não conceder de novo) uma permissão que a pessoa já tinha não é
  // escalação — só bloqueia se for uma concessão NOVA (!existingHadUsersManage).
  assert.match(
    workerSource,
    /if \(access\.permissions\.includes\("users:manage"\) && !existingHadUsersManage\) \{/,
  );
  // Autoedição sempre é permitida — só mexer na conta de OUTRO
  // admin/titular de users:manage é que continua bloqueado.
  assert.match(
    workerSource,
    /if \(!isSelfEdit && \(existing\.role === "admin" \|\| existingHadUsersManage\)\) \{/,
  );
  // A checagem de accessGroup==="administrator" não depende mais de existir
  // (aplicada antes de saber se é POST ou PATCH), e a checagem de
  // users:manage em POST é sempre escalação nova (usuário novo nunca "já
  // tinha" nada).
  assert.match(
    workerSource,
    /if \(!actorIsSuperAdmin && accessGroup === "administrator"\) \{/,
  );
  assert.match(
    workerSource,
    /if \(!actorIsSuperAdmin && access\.permissions\.includes\("users:manage"\)\) \{/,
  );
});

test("Rotina Operacional: falha ao notificar o criador não derruba a marcação de feita/não feita", async () => {
  const [routinesRoute, missionsRoute, html] = await Promise.all([
    readFile(new URL("../app/api/routines/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
  ]);

  // Bug real: as 25 rotinas gerais migradas tinham created_by='env-admin',
  // uma conta com inscrições push reais — qualquer loja marcando qualquer
  // rotina como feita disparava notifyRoutineCreator, e uma falha ali (sem
  // proteção própria) derrubava a resposta inteira com "NÃO FOI POSSÍVEL
  // ATUALIZAR A ROTINA.", mesmo com a tarefa já salva como concluída no
  // banco. app/api/missions/route.ts já protegia o equivalente
  // (notifyMissionCreator) com .catch — routines/route.ts não tinha a
  // mesma proteção.
  assert.match(
    routinesRoute,
    /try \{\s*const storeName = \(await companyName\(database, actor\.companyId\)\) \|\| "Loja";\s*await notifyRoutineCreator\(database, \{ title: task\.title, createdBy: task\.createdBy \}, storeName\);\s*\} catch \(error\) \{\s*console\.error\("Não foi possível avisar o administrador sobre a rotina\.", error\);\s*\}/,
  );
  assert.match(
    missionsRoute,
    /await notifyMissionCreator\(database, mission, storeName\)\.catch\(\(error\) => \{/,
  );

  // Front-end: distingue falha de rede (fetch rejeitou) de erro real do
  // servidor, em vez de um "Não foi possível concluir a operação"
  // genérico pra qualquer caso — facilita diagnosticar da próxima vez.
  assert.match(html, /'SEM CONEXÃO COM O SERVIDOR\. VERIFIQUE SUA INTERNET E TENTE NOVAMENTE\.'/);
  assert.match(html, /'NÃO FOI POSSÍVEL CONCLUIR A OPERAÇÃO \(ERRO '\+response\.status\+'\)\.'/);
});

test("Rotina Operacional: marcar como feita não quebra mais com erro de tipo do Postgres no completed_at", async () => {
  const routinesRoute = await readFile(new URL("../app/api/routines/route.ts", import.meta.url), "utf8");

  // Causa raiz real (confirmada em produção via wrangler tail): o Postgres
  // unifica os dois ramos de um CASE pelo tipo da expressão mais específica
  // — CURRENT_TIMESTAMP é timestamptz, então o ramo ELSE '' era validado
  // como timestamp mesmo quando não era o ramo escolhido, e toda tentativa
  // de marcar como feita quebrava com "invalid input syntax for type
  // timestamp with time zone: ''", mascarada como erro genérico pro
  // usuário. completed_at é coluna text — os dois ramos do CASE precisam
  // ser text também (now()::text), não CURRENT_TIMESTAMP cru.
  assert.match(
    routinesRoute,
    /completed_at=CASE WHEN \?1='completed' THEN now\(\)::text ELSE '' END/,
  );
  assert.doesNotMatch(
    routinesRoute,
    /completed_at=CASE WHEN \?1='completed' THEN CURRENT_TIMESTAMP ELSE ''/,
  );
});

test("botão de desfazer feita/não feita permanece legível em item concluído (não herda o opacity esmaecido do texto)", async () => {
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");

  // Bug real: opacity aplicado no card/linha inteira (pra esmaecer o título
  // riscado) também esmaecia o botão de ação (ex.: "DESFAZER"), deixando-o
  // quase ilegível no tema claro — texto escuro a 55-58% de opacidade sobre
  // fundo branco vira cinza muito claro. O esmaecimento agora é escopado só
  // ao texto/ícone (copy/check), nunca à área de ação (actions), tanto no
  // card principal de missões/rotina quanto na linha do dashboard inicial.
  assert.doesNotMatch(html, /\.mission-card\.completed\{opacity:/);
  assert.doesNotMatch(html, /\.home-mission-row\.completed\{opacity:/);
  assert.match(
    html,
    /\.mission-card\.completed \.mission-check,\s*\.mission-card\.completed \.mission-card-copy\{opacity:\.58;\}/,
  );
  assert.match(
    html,
    /\.home-mission-row\.completed \.home-mission-check,\s*\.home-mission-row\.completed \.home-mission-copy\{opacity:\.55;\}/,
  );
});

test("Financeiro Fase 3: Fornecedores em Aberto e Conta Corrente do Fornecedor", async () => {
  const [
    html,
    workerSource,
    schema,
    migration,
    supplierDebtsShared,
    supplierDebtsRoute,
    supplierDebtsIdRoute,
    supplierDebtsCancelRoute,
    supplierDebtsDashboardRoute,
    suppliersStatementRoute,
    payablesSummaryShared,
    paymentAttachmentsRoute,
  ] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0034_supplier_open_debts.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance/supplier-debts/shared.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance/supplier-debts/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance/supplier-debts/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance/supplier-debts/[id]/cancel/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance/supplier-debts/dashboard/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance/suppliers/[id]/statement/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance/payables/summary/shared.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/api/finance/payables/[id]/payments/[paymentId]/attachments/route.ts", import.meta.url),
      "utf8",
    ),
  ]);

  // Nav: entrada nova dentro do submenu Financeiro, rota estática (o
  // roteador só aceita paths fixos, sem parâmetro dinâmico).
  assert.match(
    html,
    /id="navFinanceiroSupplierStatement" data-page="financeiroSupplierStatement" data-permission="finance"[^>]*href="\/financeiro\/fornecedores\/conta-corrente"/,
  );
  assert.match(html, /id="pageFinanceiroSupplierStatement" class="page wrap"/);
  assert.match(html, /financeiroSupplierStatement:'\/financeiro\/fornecedores\/conta-corrente'/);
  assert.match(html, /financeiroSupplierStatement:'finance'/);
  assert.match(html, /function loadSupplierStatementPage\(\)/);
  assert.match(
    html,
    /isFinanceiro = name === 'financeiroDashboard'[\s\S]{0,200}name === 'financeiroSupplierStatement'/,
  );

  // Rota estática liberada no allowlist do worker.
  assert.match(workerSource, /"\/financeiro\/fornecedores\/conta-corrente"/);

  // Aba "Fornecedores em Aberto" dentro de Contas a Pagar.
  assert.match(html, /data-payables-section-tab="suppliers">FORNECEDORES EM ABERTO/);
  assert.match(html, /id="payablesTabSuppliers" hidden/);
  assert.match(html, /function setPayablesSectionTab\(tab\)/);
  assert.match(html, /id="supplierDebtForm"/);
  assert.match(html, /id="supplierDebtDialog"/);

  // Card de acesso rápido "FORNECEDORES EM ABERTO" no lugar do antigo
  // placeholder "EM BREVE".
  assert.match(html, /\{key:'suppliersOpen', label:'FORNECEDORES EM ABERTO', switchTab:true\}/);
  assert.doesNotMatch(html, /comingSoon:true/);

  // Comprovante de pagamento: campo de arquivo no formulário de pagamento
  // e upload disparado depois que o pagamento é registrado com sucesso.
  assert.match(html, /id="payablePaymentReceipt"/);
  assert.match(html, /async function uploadPaymentReceipt\(payableId, paymentId, file\)/);
  assert.match(
    html,
    /const paymentResp = await financeApiRequest\('\/payables\/'\+encodeURIComponent\(payablesCurrentDetailId\)\+'\/payments', \{/,
  );
  assert.match(html, /await uploadPaymentReceipt\(payablesCurrentDetailId, paymentResp\.id, receiptFile\)/);

  // Schema: tabelas novas — dívida avulsa com sua accounts_payable "gêmea",
  // e anexo de comprovante genérico (não exclusivo desta feature).
  assert.match(schema, /export const supplierOpenDebts = pgTable\(\s*"supplier_open_debts"/);
  assert.match(schema, /export const accountsPayablePaymentAttachments = pgTable\(\s*"accounts_payable_payment_attachments"/);
  assert.match(schema, /accountsPayableId: text\("accounts_payable_id"\)\.notNull\(\)\.default\(""\)/);

  // Migration: tabelas, índices, seed idempotente da categoria/item
  // genéricos (accounts_payable.finance_item_id é NOT NULL) e RLS.
  assert.match(migration, /CREATE TABLE "supplier_open_debts"/);
  assert.match(migration, /CREATE TABLE "accounts_payable_payment_attachments"/);
  assert.match(
    migration,
    /INSERT INTO "finance_items" \("id", "category_id", "name"[\s\S]{0,120}'seed-supplier-open-debt-item'/,
  );
  assert.match(migration, /ON CONFLICT \("id"\) DO NOTHING/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE "supplier_open_debts" FROM anon, authenticated/);

  // Backend: cada dívida cria sua accounts_payable gêmea na mesma
  // transação (mesmo padrão de duplicatas de NF), reaproveitando o motor
  // único de status/pagamento/DRE — sem tabela de pagamento própria.
  assert.match(supplierDebtsShared, /DEFAULT_SUPPLIER_DEBT_FINANCE_ITEM_ID = "seed-supplier-open-debt-item"/);
  assert.match(supplierDebtsRoute, /INSERT INTO accounts_payable/);
  assert.match(supplierDebtsRoute, /INSERT INTO supplier_open_debts/);
  assert.match(supplierDebtsRoute, /recalcPayableEntrySql/);
  assert.match(supplierDebtsIdRoute, /UPDATE supplier_open_debts/);
  assert.match(supplierDebtsIdRoute, /UPDATE accounts_payable/);
  assert.match(supplierDebtsCancelRoute, /SET canceled=1/);
  assert.match(supplierDebtsCancelRoute, /SET status='canceled'/);

  // Dashboard de Fornecedores reaproveita buildOpenSuppliers em vez de
  // duplicar a consulta de saldo em aberto por fornecedor.
  assert.match(supplierDebtsDashboardRoute, /buildOpenSuppliers/);
  assert.match(payablesSummaryShared, /export async function buildOpenSuppliersPaged/);

  // Conta corrente do fornecedor: extrato agrega accounts_payable de
  // qualquer origem (NF, duplicata, despesa ou dívida avulsa) via LEFT JOIN
  // com as tabelas "gêmeas" conhecidas.
  assert.match(suppliersStatementRoute, /LEFT JOIN supplier_invoice_installments sii ON sii\.accounts_payable_id = a\.id/);
  assert.match(suppliersStatementRoute, /LEFT JOIN supplier_open_debts sod ON sod\.accounts_payable_id = a\.id/);

  // Comprovante via rota HTTP dedicada (tabela genérica, mesmo bucket R2
  // do resto do projeto), não uma tabela exclusiva de Fornecedores em
  // Aberto.
  assert.match(paymentAttachmentsRoute, /INSERT INTO accounts_payable_payment_attachments/);
});

test("Financeiro Fase 6: Recebíveis e Fluxo de Caixa", async () => {
  const [
    html,
    workerSource,
    schema,
    migration,
    receivedIndexMigration,
    receivablesRoute,
    cashFlowRoute,
    balancesShared,
    balancesRoute,
  ] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0037_finance_cash_flow.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0038_accounts_receivable_received_idx.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance/receivables/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance/cash-flow/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance/account-balances/shared.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance/account-balances/route.ts", import.meta.url), "utf8"),
  ]);

  // Nav + rotas: duas telas novas dentro do submenu Financeiro, liberadas
  // pela MESMA permissão do resto do módulo (nenhuma permissão nova).
  assert.match(
    html,
    /id="navFinanceiroRecebiveis" data-page="financeiroRecebiveis" data-permission="finance"[^>]*href="\/financeiro\/recebiveis"/,
  );
  assert.match(
    html,
    /id="navFinanceiroFluxoCaixa" data-page="financeiroFluxoCaixa" data-permission="finance"[^>]*href="\/financeiro\/fluxo-de-caixa"/,
  );
  assert.match(html, /id="pageFinanceiroRecebiveis" class="page wrap"/);
  assert.match(html, /id="pageFinanceiroFluxoCaixa" class="page wrap"/);
  assert.match(html, /financeiroRecebiveis:'\/financeiro\/recebiveis'/);
  assert.match(html, /financeiroFluxoCaixa:'\/financeiro\/fluxo-de-caixa'/);
  assert.match(html, /financeiroRecebiveis:'finance'/);
  assert.match(html, /financeiroFluxoCaixa:'finance'/);
  assert.match(workerSource, /"\/financeiro\/recebiveis"/);
  assert.match(workerSource, /"\/financeiro\/fluxo-de-caixa"/);

  // O dispatch on-enter precisa existir nos DOIS caminhos (clique no menu e
  // navegação direta pela URL), como em todos os módulos anteriores.
  assert.equal(html.split("if(name === 'financeiroRecebiveis') loadRecebiveisPage();").length - 1, 2);
  assert.equal(html.split("if(name === 'financeiroFluxoCaixa') loadFluxoCaixaPage();").length - 1, 2);

  // Gráfico e imagem de compartilhamento sem dependência externa nova.
  assert.match(html, /<svg viewBox="0 0 '\+width\+' '\+height\+'"/);
  assert.match(html, /canvas\.toDataURL\('image\/png'\)/);
  assert.doesNotMatch(html, /cdn\.jsdelivr|chart\.js|unpkg\.com/i);

  // Schema/migration: status de recebível NUNCA é persistido (só o
  // cancelamento), e o saldo manual do caixa não reaproveita as colunas de
  // saldo de abertura de finance_accounts.
  assert.match(schema, /export const accountsReceivable = pgTable\(\s*"accounts_receivable"/);
  assert.match(schema, /export const financeAccountBalances = pgTable\(\s*"finance_account_balances"/);
  assert.match(schema, /export const financeCashFlowSettings = pgTable\(\s*"finance_cash_flow_settings"/);
  assert.doesNotMatch(schema, /accounts_receivable[\s\S]{0,2000}?display_status/);
  assert.match(migration, /CREATE TABLE "accounts_receivable"/);
  assert.match(migration, /CREATE UNIQUE INDEX "accounts_receivable_idempotency_idx"/);
  assert.match(migration, /CREATE UNIQUE INDEX "finance_account_balances_account_idx"/);

  // Escrita sempre com sameOrigin + idempotência, como no resto do módulo.
  assert.match(receivablesRoute, /sameOrigin\(request\)/);
  assert.match(receivablesRoute, /idempotency_key/);

  // Saídas do fluxo de caixa vêm de UMA consulta unificada sobre
  // accounts_payable + accounts_payable_payments (cobre Contas a Pagar,
  // Fornecedores em Aberto e Despesas de uma vez) mais o RH Financeiro.
  assert.match(cashFlowRoute, /FROM accounts_payable\b/);
  assert.match(cashFlowRoute, /FROM accounts_payable_payments p/);
  assert.match(cashFlowRoute, /FROM hr_payroll_entries/);
  assert.match(cashFlowRoute, /FROM hr_benefits/);
  assert.match(cashFlowRoute, /FROM hr_commissions/);
  assert.match(cashFlowRoute, /buildCashFlowSeries\(/);
  // Impostos/taxas de cartão só chegam na Fase 7 — a UI precisa dizer isso.
  assert.match(cashFlowRoute, /taxesAndFeesIncluded: false/);
  assert.match(html, /Impostos e taxas de cartão: não incluídos ainda \(Fase 7\)/);

  // Conta ativa sem saldo informado fica FORA do Caixa Atual, mas visível.
  // A regra vive num shared.ts único, consumido tanto pela tela de saldos
  // quanto pela projeção do Fluxo de Caixa — as duas NÃO podem calcular
  // "Caixa Atual" por conta própria e divergir.
  assert.match(balancesShared, /export async function loadAccountBalances\(/);
  assert.match(balancesShared, /hasBalance/);
  assert.match(balancesShared, /accountsMissingBalance/);
  assert.match(balancesRoute, /loadAccountBalances\(database, companyId\)/);
  assert.match(cashFlowRoute, /loadAccountBalances\(database, companyId\)/);
  assert.doesNotMatch(cashFlowRoute, /FROM finance_account_balances/);

  // RH no Fluxo de Caixa: as três consultas precisam de LIMITE INFERIOR de
  // competência, senão anos de folha já paga caem no dia 0 da série (toda
  // data anterior a hoje é bucketizada no primeiro dia) e destroem a
  // projeção. Folha e benefícios ainda excluem o que já foi pago no passado.
  assert.match(cashFlowRoute, /FROM hr_payroll_entries[\s\S]{0,400}?month >= /);
  assert.match(cashFlowRoute, /FROM hr_benefits[\s\S]{0,400}?month >= /);
  assert.match(cashFlowRoute, /FROM hr_commissions[\s\S]{0,400}?month >= /);
  assert.match(cashFlowRoute, /NOT \(payment_done = 1 AND payment_date <> '' AND payment_date < /);

  // Funcionário ativo sem lançamento de folha no mês precisa entrar pelo
  // salário-base do cadastro — senão o Fluxo de Caixa projeta R$ 0,00 de
  // folha justamente nos meses futuros, que quase nunca estão lançados.
  assert.match(cashFlowRoute, /FROM hr_employees e/);
  assert.match(cashFlowRoute, /e\.status = 'active'/);
  assert.match(cashFlowRoute, /SUM\(e\.salary_cents\)/);
  assert.match(cashFlowRoute, /NOT EXISTS \(\s*SELECT 1 FROM hr_payroll_entries p/);

  // Índice de received_date: o Fluxo de Caixa agrupa por essa coluna a cada
  // carregamento da tela. Migration incremental — a 0037 não foi reescrita.
  assert.match(schema, /accounts_receivable_company_received_idx/);
  assert.match(receivedIndexMigration, /CREATE INDEX "accounts_receivable_company_received_idx"/);
  assert.doesNotMatch(migration, /accounts_receivable_company_received_idx/);

  // Saldo de conta negativo (cheque especial) precisa ser aceito no
  // formulário: parseBRLToCents rejeita negativo e é reaproveitada em campos
  // onde negativo não faz sentido, por isso a variante separada.
  assert.match(html, /function parseBRLToCentsAllowNegative\(/);
  assert.match(html, /parseBRLToCentsAllowNegative\(el\('cashFlowBalanceAmount'\)\.value\)/);

  // O aviso de impostos no PNG segue a MESMA condição da tela — não pode
  // ficar afirmado pra sempre depois que a Fase 7 chegar.
  assert.match(html, /if\(cashFlowData\.taxesAndFeesIncluded === false\)\{\s*footerNotes\.push/);
});
