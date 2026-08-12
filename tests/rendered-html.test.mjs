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
  assert.match(serviceWorker, /CACHE_NAME = "estoque-unigames-v28"/);
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

  assert.match(html, /id="navMissoes" data-page="missoes" data-permission="missions"/);
  assert.match(html, /data-home-target="missoes" data-permission="missions"/);
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
  assert.match(schema, /export const missions = pgTable/);
  assert.match(schema, /export const missionCompletions = pgTable/);
  assert.match(migration, /CREATE TABLE `missions`/);
  assert.match(migration, /CREATE TABLE `mission_completions`/);
  assert.match(migration, /mission_completions_occurrence_unique/);
  assert.match(statusMigration, /ADD `status` text DEFAULT 'completed' NOT NULL/);
  assert.match(statusMigration, /ADD `updated_at` text DEFAULT '' NOT NULL/);
  assert.match(manifest, /"url": "\/missoes"/);
  assert.match(serviceWorker, /CACHE_NAME = "estoque-unigames-v28"/);
});

test("implementa a captação por loja com fluxo protegido de assistência e destino", async () => {
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
  assert.match(html, /currentSession\.role === 'admin' \? el\('captureOriginCompany'\)\.value : ''/);
  assert.match(html, /AGUARDANDO ASSISTÊNCIA/);
  assert.match(html, /RECEBIDO PELA ASSISTÊNCIA/);
  assert.match(html, /DISPONÍVEL PARA SEPARAÇÃO/);
  assert.match(html, /data-capture-action="receive"/);
  assert.match(html, /data-capture-action="ready"/);
  assert.match(html, /data-capture-action="assign"/);
  assert.match(html, /function isAssistanceSession\(\)/);
  assert.match(html, /username\.includes\('assistencia'\)/);
  assert.match(html, /displayName\.includes\('assistencia'\)/);
  assert.match(html, /value="assistance">ASSISTÊNCIA — FLUXO DE CAPTAÇÃO/);
  assert.match(html, /value="captures:view"> Visualizar/);
  assert.match(html, /captacao:'\/captacao'/);
  assert.match(html, /captacao:'captures'/);
  assert.match(html, /if\(livePageName === 'captacao'\) await loadCaptures\(\)/);

  assert.match(workerSource, /"captures"/);
  assert.match(workerSource, /assistance: \["captures:view", "captures:create", "captures:receive"\]/);
  assert.match(workerSource, /normalized === "assistencia"/);
  assert.match(workerSource, /const sector: UserSector = accessGroup === "assistance" \? "assistance" : requestedSector/);
  assert.match(workerSource, /const companyId = sector \? "" : requestedCompanyId/);
  assert.match(workerSource, /path === "\/captacao" \|\| path\.startsWith\("\/api\/captures"\)/);
  assert.match(workerSource, /authenticatedHeaders\.set\(ACCESS_GROUP_HEADER, user\.accessGroup\)/);
  assert.match(workerSource, /env\.DB\.prepare\("SELECT \* FROM captured_products"\)\.all\(\)/);
  assert.match(workerSource, /capturedProducts: capturedProducts\.results \?\? \[\]/);
  assert.match(workerSource, /headers\.delete\("x-unigames-live-company-id"\)/);
  assert.match(liveEvents, /module: "captures"/);
  assert.match(liveEvents, /category === "jogo" \? \[\] : \["assistance"\]/);

  assert.match(captureShared, /accessGroup === "assistance"/);
  assert.match(captureShared, /actor\.sector === "assistance"/);
  assert.match(captureShared, /accessGroup === "assistencia"/);
  assert.match(captureShared, /username\.includes\("assistencia"\)/);
  assert.match(captureShared, /displayName\.includes\("assistencia"\)/);
  assert.match(route, /const allStores = actor\.role === "admin" \|\| isAssistanceActor\(actor\)/);
  assert.match(route, /actor\.role === "admin" \? requestedOriginCompanyId : actor\.companyId/);
  assert.match(route, /ESCOLHA A LOJA DE ORIGEM/);
  assert.match(route, /isAssistanceActor\(actor\) \|\| actor\.permissions\.includes\("captures:receive"\)/);
  assert.match(route, /SOMENTE A ASSISTÊNCIA PODE ALTERAR ESTA ETAPA/);
  assert.match(route, /VOCÊ NÃO TEM PERMISSÃO PARA DEFINIR O DESTINO/);
  assert.match(route, /existing\.status !== "submitted"/);
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
  assert.match(serviceWorker, /CACHE_NAME = "estoque-unigames-v28"/);
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
  assert.match(captureShared, /actor\.role === "admin" \|\| actor\.companyId === row\.originCompanyId/);

  assert.match(html, /<option value="jogo">JOGOS<\/option>/);
  assert.match(html, /id="captureGameName"/);
  assert.match(html, /id="captureGameConsole"[\s\S]*value="PS4"[\s\S]*value="PS3"[\s\S]*value="PS5"[\s\S]*value="Nintendo Switch"[\s\S]*value="Xbox One\/Series"/);
  assert.match(html, /id="captureGameCondition"[\s\S]*value="Novo"[\s\S]*value="Semi Novo"/);
  assert.match(html, /el\('captureValue'\)\.required = isGame/);
  assert.match(html, /gameName:el\('captureGameName'\)\.value/);
  assert.match(html, /isAssistanceSession\(\) && row\.category === 'jogo'/);

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

  assert.match(route, /export async function DELETE\(request: Request\)/);
  assert.match(route, /!can\(actor, "captures:delete"\)/);
  assert.match(route, /VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR CAPTAÇÕES/);
  assert.match(route, /DELETE FROM captured_products WHERE id=\?1/);
  assert.match(route, /await bucket\.delete\(existing\.photoKey\)/);
});

test("registra saídas por defeito por loja e preserva o histórico do administrador", async () => {
  const [html, workerSource, route, schema, migration, manifest, serviceWorker] =
    await Promise.all([
      readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
      readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/outputs/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
      readFile(new URL("../drizzle-sqlite-legacy/0009_hard_young_avengers.sql", import.meta.url), "utf8"),
      readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
      readFile(new URL("../public/service-worker.js", import.meta.url), "utf8"),
    ]);

  assert.match(html, /id="navSaidas" data-page="saidas" data-permission="outputs"/);
  assert.match(html, /data-home-target="saidas" data-permission="outputs"/);
  assert.match(html, /id="pageSaidas" class="page wrap"/);
  assert.match(html, /id="outputForm"/);
  assert.match(html, /id="outputQuantity" type="number" min="1" max="9999"/);
  assert.match(html, /id="outputProductName"/);
  assert.match(html, /id="outputDefect"/);
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

  assert.match(route, /actor\.role === "admin" \? requestedCompanyId : actor\.companyId/);
  assert.match(route, /WHERE company_id=\?1/);
  assert.match(route, /!can\(actor, "outputs:complete"\)/);
  assert.match(route, /VOCÊ NÃO TEM PERMISSÃO PARA CONCLUIR UMA SAÍDA/);
  assert.match(route, /existing\.status !== "requested"/);
  assert.match(route, /SET status='completed'/);
  assert.match(route, /completed_at=CURRENT_TIMESTAMP/);
  assert.match(schema, /export const defectiveOutputs = pgTable/);
  assert.match(migration, /CREATE TABLE `defective_outputs`/);
  assert.match(migration, /defective_outputs_status_created_idx/);
  assert.match(migration, /defective_outputs_company_created_idx/);
  assert.match(migration, /PRAGMA optimize/);
  assert.match(manifest, /"url": "\/saidas"/);
  assert.match(serviceWorker, /CACHE_NAME = "estoque-unigames-v28"/);
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

  assert.match(html, /id="navInsumos" data-page="insumos" data-permission="supplies"/);
  assert.match(html, /data-home-target="insumos" data-permission="supplies"/);
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

  assert.match(route, /actor\.role === "admin" \? requestedCompanyId : actor\.companyId/);
  assert.match(route, /actor\.role !== "admin" && existing\.companyId !== actor\.companyId/);
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
  assert.match(serviceWorker, /CACHE_NAME = "estoque-unigames-v28"/);
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
  assert.match(serviceWorker, /CACHE_NAME = "estoque-unigames-v28"/);
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
  assert.match(html, /data-home-target="puxadas"/);
  assert.match(html, /data-home-target="compras"/);
  assert.match(html, /data-home-target="dashboard"/);
  assert.match(html, /data-home-target="captacao" data-permission="captures"/);
  assert.match(html, /data-home-target="cadastros"/);
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

  assert.match(html, /id="navRelatorio41" data-page="relatorio41" data-permission="report41"/);
  assert.match(html, /data-home-target="relatorio41" data-permission="report41"/);
  assert.match(html, /id="pageRelatorio41" class="page wrap"/);
  assert.match(html, /id="report41StoreSelect"/);
  assert.match(html, /id="btnReport41SalesUpload"/);
  assert.match(html, /id="btnReport41StockUpload"/);
  assert.match(html, /id="btnCompanyStockUpload"/);
  assert.match(html, /id="userCompanyId"/);
  assert.match(html, /REPORT41_EXCLUDED_PRODUCT_TERMS = new Set\(\['indicacao','cortesia','garantia'\]\)/);
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
  assert.match(route, /\^%PDF-\[12\]/);
  assert.match(route, /%%EOF/);
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
