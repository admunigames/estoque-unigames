import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { isValidCpfOrCnpj, isValidPixKey, PIX_KEY_TYPES, type PixKeyType } from "../../../lib/br-documents";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../shared";

const ACCOUNT_TYPES = [
  "checking",
  "savings",
  "cash",
  "wallet",
  "digital",
  "card",
  "investment",
  "other",
] as const;
type AccountType = (typeof ACCOUNT_TYPES)[number];

// Tipos que não fazem sentido ter agência/número de conta bancária —
// espelha exatamente a regra do requisito ("Caixa"/"Carteira" não exigem
// dados bancários).
const TYPES_WITHOUT_BANK_DETAILS = new Set<AccountType>(["cash", "wallet"]);
// Tipos "conta corrente"/"poupança" clássicos exigem banco + agência +
// número — os demais (digital, cartão, investimento, outros) só exigem
// banco + número, já que muita fintech não usa agência de verdade.
const TYPES_REQUIRING_AGENCY = new Set<AccountType>(["checking", "savings"]);

type AccountRow = {
  id: string;
  companyId: string;
  companyName: string;
  name: string;
  type: AccountType;
  bankName: string;
  bankCode: string;
  agency: string;
  agencyDigit: string;
  accountNumber: string;
  accountDigit: string;
  holderName: string;
  holderDocument: string;
  pixKeyType: string;
  pixKey: string;
  openingBalanceCents: number;
  openingBalanceDate: string;
  notes: string;
  active: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

const SELECT_COLUMNS = `id, company_id AS companyId, company_name AS companyName, name, type,
  bank_name AS bankName, bank_code AS bankCode, agency, agency_digit AS agencyDigit,
  account_number AS accountNumber, account_digit AS accountDigit,
  holder_name AS holderName, holder_document AS holderDocument,
  pix_key_type AS pixKeyType, pix_key AS pixKey,
  opening_balance_cents AS openingBalanceCents, opening_balance_date AS openingBalanceDate,
  notes, active, created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt,
  updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt`;

/** "Nome amigável" pra exibir no seletor de Contas a Pagar, sem detalhes demais. */
export function accountDisplayLabel(account: Pick<AccountRow, "name" | "bankName" | "agency" | "accountNumber">): string {
  const parts = [account.name];
  if (account.bankName) parts.push(account.bankName);
  if (account.agency || account.accountNumber) {
    const agencyPart = account.agency ? `ag. ${account.agency}` : "";
    const accountPart = account.accountNumber ? `cc. ${account.accountNumber}` : "";
    parts.push([agencyPart, accountPart].filter(Boolean).join(" / "));
  }
  return parts.join(" — ");
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }

  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }

  const url = new URL(request.url);
  const includeInactive = url.searchParams.get("includeInactive") === "1";
  const requestedCompanyId = safeText(url.searchParams.get("companyId"), 80);
  if (!allStores && requestedCompanyId && requestedCompanyId !== scopeActor.companyId) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSA LOJA." }, 403);
  }
  const effectiveCompanyId = allStores ? requestedCompanyId : scopeActor.companyId;

  const conditions: string[] = [];
  const values: unknown[] = [];
  if (!includeInactive) conditions.push("active=1");
  if (effectiveCompanyId) {
    values.push(effectiveCompanyId);
    conditions.push(`company_id = ?${values.length}`);
  }
  const typeFilter = safeText(url.searchParams.get("type"), 20);
  if (typeFilter) {
    values.push(typeFilter);
    conditions.push(`type = ?${values.length}`);
  }
  const bankFilter = safeText(url.searchParams.get("bank"), 120);
  if (bankFilter) {
    values.push(`%${bankFilter}%`, bankFilter);
    conditions.push(`(bank_name ILIKE ?${values.length - 1} OR bank_code = ?${values.length})`);
  }
  const search = safeText(url.searchParams.get("search"), 120);
  if (search) {
    values.push(`%${search}%`, `%${search}%`, `%${search}%`);
    conditions.push(
      `(name ILIKE ?${values.length - 2} OR bank_name ILIKE ?${values.length - 1} OR holder_name ILIKE ?${values.length})`,
    );
  }
  const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    const database = await getD1();
    const result = await database
      .prepare(`SELECT ${SELECT_COLUMNS} FROM finance_accounts ${whereSql} ORDER BY name ASC`)
      .bind(...values)
      .all<AccountRow>();
    const accounts = (result.results ?? []).map((account) => ({
      ...account,
      displayLabel: accountDisplayLabel(account),
    }));
    return jsonResponse({ accounts });
  } catch (error) {
    console.error("Não foi possível carregar as contas financeiras.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS CONTAS FINANCEIRAS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR CONTAS FINANCEIRAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
  const allStores = canSeeAllStores(scopeActor, "finance:manage");

  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);

    const companyId = safeText(body.companyId, 80);
    const companyName = safeText(body.companyName, 160);
    if (!companyId) return jsonResponse({ error: "SELECIONE A EMPRESA/LOJA DA CONTA." }, 400);
    if (!allStores && companyId !== scopeActor.companyId) {
      return jsonResponse({ error: "VOCÊ SÓ PODE CADASTRAR CONTAS PARA A PRÓPRIA LOJA." }, 403);
    }

    const name = safeText(body.name, 160);
    if (name.length < 2) return jsonResponse({ error: "INFORME O NOME/DESCRIÇÃO DA CONTA." }, 400);

    const type = safeText(body.type, 20) as AccountType;
    if (!ACCOUNT_TYPES.includes(type)) {
      return jsonResponse({ error: "SELECIONE O TIPO DA CONTA." }, 400);
    }

    const bankName = safeText(body.bankName, 120);
    const bankCode = safeText(body.bankCode, 10);
    const agency = safeText(body.agency, 20);
    const agencyDigit = safeText(body.agencyDigit, 5);
    const accountNumber = safeText(body.accountNumber, 30);
    const accountDigit = safeText(body.accountDigit, 5);

    if (!TYPES_WITHOUT_BANK_DETAILS.has(type)) {
      if (!bankName && !bankCode) {
        return jsonResponse({ error: "INFORME O BANCO/INSTITUIÇÃO FINANCEIRA." }, 400);
      }
      if (!accountNumber) {
        return jsonResponse({ error: "INFORME O NÚMERO DA CONTA." }, 400);
      }
      if (TYPES_REQUIRING_AGENCY.has(type) && !agency) {
        return jsonResponse({ error: "INFORME A AGÊNCIA." }, 400);
      }
    }

    const holderName = safeText(body.holderName, 160);
    const holderDocument = safeText(body.holderDocument, 20);
    if (holderDocument && !isValidCpfOrCnpj(holderDocument)) {
      return jsonResponse({ error: "CPF/CNPJ DO TITULAR INVÁLIDO." }, 400);
    }

    const pixKeyTypeRaw = safeText(body.pixKeyType, 10);
    const pixKey = safeText(body.pixKey, 140);
    let pixKeyType = "";
    if (pixKey || pixKeyTypeRaw) {
      if (!PIX_KEY_TYPES.includes(pixKeyTypeRaw as PixKeyType)) {
        return jsonResponse({ error: "SELECIONE O TIPO DA CHAVE PIX." }, 400);
      }
      if (!pixKey) return jsonResponse({ error: "INFORME A CHAVE PIX." }, 400);
      if (!isValidPixKey(pixKey, pixKeyTypeRaw as PixKeyType)) {
        return jsonResponse({ error: "CHAVE PIX INVÁLIDA PARA O TIPO SELECIONADO." }, 400);
      }
      pixKeyType = pixKeyTypeRaw;
    }

    const openingBalanceRaw = body.openingBalanceCents;
    let openingBalanceCents = 0;
    if (openingBalanceRaw !== undefined && openingBalanceRaw !== null && openingBalanceRaw !== "") {
      openingBalanceCents = Number(openingBalanceRaw);
      if (!Number.isFinite(openingBalanceCents) || !Number.isInteger(openingBalanceCents)) {
        return jsonResponse({ error: "SALDO INICIAL INVÁLIDO." }, 400);
      }
    }
    const openingBalanceDate = safeText(body.openingBalanceDate, 10);

    const notes = safeText(body.notes, 2000);
    const active = body.active === false ? 0 : 1;
    const actorName = actor.displayName || "Administrador";

    const database = await getD1();

    // Duplicidade dentro da mesma loja: mesmo nome, ou mesma combinação
    // banco+agência+número quando esses estiverem preenchidos.
    const duplicateCheck = await database
      .prepare(
        `SELECT id FROM finance_accounts
         WHERE company_id=?1 AND id != ?2 AND (
           name = ?3
           OR (?4 != '' AND account_number = ?4 AND bank_code = ?5 AND agency = ?6)
         )`,
      )
      .bind(companyId, id || "", name, accountNumber, bankCode, agency)
      .first<{ id: string }>();
    if (duplicateCheck) {
      return jsonResponse({ error: "JÁ EXISTE UMA CONTA FINANCEIRA COM ESSES DADOS NESSA LOJA." }, 409);
    }

    if (id) {
      const existing = await database
        .prepare("SELECT id, company_id AS companyId FROM finance_accounts WHERE id=?1")
        .bind(id)
        .first<{ id: string; companyId: string }>();
      if (!existing) return jsonResponse({ error: "CONTA FINANCEIRA NÃO ENCONTRADA." }, 404);
      if (!allStores && existing.companyId && existing.companyId !== scopeActor.companyId) {
        return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSA CONTA." }, 403);
      }
      await database
        .prepare(
          `UPDATE finance_accounts
           SET company_id=?1, company_name=?2, name=?3, type=?4, bank_name=?5, bank_code=?6,
               agency=?7, agency_digit=?8, account_number=?9, account_digit=?10,
               holder_name=?11, holder_document=?12, pix_key_type=?13, pix_key=?14,
               opening_balance_cents=?15, opening_balance_date=?16, notes=?17, active=?18,
               updated_by=?19, updated_by_name=?20, updated_at=CURRENT_TIMESTAMP
           WHERE id=?21`,
        )
        .bind(
          companyId,
          companyName,
          name,
          type,
          bankName,
          bankCode,
          agency,
          agencyDigit,
          accountNumber,
          accountDigit,
          holderName,
          holderDocument,
          pixKeyType,
          pixKey,
          openingBalanceCents,
          openingBalanceDate,
          notes,
          active,
          actor.id,
          actorName,
          id,
        )
        .run();
      return jsonResponse({ updated: true, id });
    }

    const newId = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO finance_accounts
          (id, company_id, company_name, name, type, bank_name, bank_code, agency, agency_digit,
           account_number, account_digit, holder_name, holder_document, pix_key_type, pix_key,
           opening_balance_cents, opening_balance_date, notes, active,
           created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,
           ?19,?20,CURRENT_TIMESTAMP,?19,?20,CURRENT_TIMESTAMP)`,
      )
      .bind(
        newId,
        companyId,
        companyName,
        name,
        type,
        bankName,
        bankCode,
        agency,
        agencyDigit,
        accountNumber,
        accountDigit,
        holderName,
        holderDocument,
        pixKeyType,
        pixKey,
        openingBalanceCents,
        openingBalanceDate,
        notes,
        active,
        actor.id,
        actorName,
      )
      .run();
    return jsonResponse({ created: true, id: newId }, 201);
  } catch (error) {
    console.error("Não foi possível salvar a conta financeira.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR A CONTA FINANCEIRA." }, 500);
  }
}
