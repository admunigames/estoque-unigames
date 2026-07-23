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
  assert.match(html, /Entrar · Estoque Unigames/);
  assert.match(html, /name="username"/);
  assert.match(html, /name="password"/);
  assert.doesNotMatch(html, /senha-de-teste-forte/);
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
  assert.equal(login.headers.get("location"), "/inicio");
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
  assert.equal(login.headers.get("location"), "/inicio");
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

test("configura o banco geral e conecta a interface à API compartilhada", async () => {
  const [hosting, html, migration] = await Promise.all([
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0000_wild_magik.sql", import.meta.url), "utf8"),
  ]);

  assert.equal(JSON.parse(hosting).d1, "DB");
  assert.match(migration, /CREATE TABLE `shared_state`/);
  assert.match(html, /\/api\/shared-state/);
  assert.match(html, /BANCO GERAL ATIVO/);
  assert.match(html, /ifAbsent:true/);
});

test("oferece divisao expansivel e TXT separado por rota nas puxadas", async () => {
  const html = await readFile(
    new URL("../public/estoque.html", import.meta.url),
    "utf8",
  );

  assert.match(html, /<details class="purchase-division">/);
  assert.match(html, /ARQUIVOS TXT SEPARADOS POR ROTA/);
  assert.match(html, /\*TRANSFERÊNCIA\*/);
  assert.match(html, /route\.origin\.toUpperCase\(\) \+ ' >>>> ' \+ route\.destination\.toUpperCase\(\)/);
  assert.match(html, /padStart\(2,'0'\)/);
  assert.doesNotMatch(html, /Equilibre o estoque entre as lojas usando as vendas do período/);
  assert.doesNotMatch(html, /ETAPA 01/);
  assert.doesNotMatch(html, /class="pull-flow"/);
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
  assert.match(html, /class="purchase-card"/);
  assert.match(html, /class="purchase-card-dates"/);
  assert.match(html, /class="purchase-card-actions"/);
  assert.match(html, /grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,390px\),1fr\)\)/);
  assert.match(html, /el\('purchaseCardGrid'\)\.addEventListener/);
  assert.doesNotMatch(html, /class="table-panel purchase-table"/);
  assert.match(route, /searchParams[\s\S]*\.getAll\("status"\)/);
  assert.match(route, /statuses\.length > 1/);
  assert.match(route, /or: statuses\.map/);
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
    /id="navInicio"[\s\S]*>Início<[\s\S]*id="navPuxadas"[\s\S]*id="navCompras"[\s\S]*id="navDashboard"[\s\S]*>Estoque Fiscal<[\s\S]*id="navCadastros"/,
  );
  assert.match(html, /id="navLojas"[\s\S]*class="nav-item sub-item" id="navDados"/);
  assert.match(html, /id="pageInicio" class="page wrap home-page active"/);
  assert.match(html, /class="home-lightglass"/);
  assert.match(html, /class="home-brand-logo" data-logo alt="LOGO UNIGAMES"/);
  assert.match(html, /data-home-target="puxadas"/);
  assert.match(html, /data-home-target="compras"/);
  assert.match(html, /data-home-target="dashboard"/);
  assert.match(html, /data-home-target="cadastros"/);
  assert.match(html, /document\.querySelectorAll\('\[data-home-target\]'\)/);
  assert.match(html, /\.page\.home-page\.active\{display:flex;\}/);
  assert.doesNotMatch(html, /\.home-page\{[^}]*display:flex/);
  assert.match(html, /@media \(max-width:800px\)[\s\S]*\.home-access-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\);\}/);
  assert.match(html, /@media \(max-width:520px\)[\s\S]*\.home-access-grid\{grid-template-columns:1fr;/);
  assert.doesNotMatch(html, /data-dashboard-home/);
  for (const pageId of ["pagePuxadas", "pageCompras", "pageDashboard", "pageLojas", "pageDados"]) {
    assert.match(html, new RegExp(`id="${pageId}" class="page wrap"`));
  }
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
  assert.match(html, /id="navDados" data-page="dados">Base de Dados<\/button>/);
  assert.match(html, /id="navCadastros" type="button" aria-expanded="false" aria-controls="navCadastrosSubmenu"/);
  assert.match(html, /id="navCadastrosSubmenu" hidden/);
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
