import type { getD1 } from "../../../../db";
import { hasCompany } from "../../../lib/access-scope";
import { isMachineStatus, normalizeSerial, validateMachineDraft } from "../../../lib/card-machines";
import { loadCompanyList, safeText, type JsonMap } from "../shared";

export type MachineInput = {
  acquirerId: string;
  acquirerName: string;
  model: string;
  adminPassword: string;
  serial: string;
  establishmentCode: string;
  terminal: string;
  installedAt: string;
  notes: string;
  status: string;
  companyId: string;
  companyName: string;
};

/**
 * Valida o corpo de UMA maquineta (cadastro ou edição) — usada pelo POST e
 * pelo CADASTRAR EM LOTE (card-machines/batch). `takenSerials` deixa o lote
 * recusar o mesmo serial em duas linhas.
 */
export async function validateMachineInput(
  database: Awaited<ReturnType<typeof getD1>>,
  scopeActor: { companyId: string },
  allStores: boolean,
  body: JsonMap,
  editId = "",
  takenSerials?: Set<string>,
): Promise<{ error: string; status: number } | { input: MachineInput }> {
  const acquirerId = safeText(body.acquirerId, 80);
  const model = safeText(body.model, 120);
  // Senha administrativa da maquineta (visível para quem tem o Financeiro, por decisão do usuário).
  const adminPassword = safeText(body.adminPassword, 60);
  const serial = normalizeSerial(body.serial);
  const establishmentCode = safeText(body.establishmentCode, 60);
  const terminal = safeText(body.terminal, 60);
  const installedAt = safeText(body.installedAt, 10);
  const notes = safeText(body.notes, 1000);
  const status = isMachineStatus(body.status) ? body.status : "active";

  let companyId = safeText(body.companyId, 80);
  if (!allStores) companyId = scopeActor.companyId;

  const draftError = validateMachineDraft({ acquirerId, companyId, installedAt });
  if (draftError) return { error: draftError, status: 400 };
  if (allStores && !hasCompany(companyId)) return { error: "SELECIONE A UNIDADE.", status: 400 };

  const acquirer = await database
    .prepare("SELECT name, company_id AS companyId FROM finance_acquirers WHERE id=?1")
    .bind(acquirerId)
    .first<{ name: string; companyId: string }>();
  if (!acquirer) return { error: "ADQUIRENTE NÃO ENCONTRADA.", status: 400 };
  if (acquirer.companyId && acquirer.companyId !== companyId) {
    return { error: "ESSA ADQUIRENTE É DE OUTRA UNIDADE.", status: 400 };
  }

  const companies = await loadCompanyList(database);
  const companyName = companies.find((row) => row.id === companyId)?.name ?? "";
  if (!companyName) return { error: "UNIDADE NÃO ENCONTRADA.", status: 400 };

  if (serial) {
    if (takenSerials?.has(serial)) return { error: "SERIAL REPETIDO NESTE LOTE.", status: 409 };
    const dupSerial = await database
      .prepare("SELECT id FROM finance_card_machines WHERE serial=?1 AND id<>?2")
      .bind(serial, editId || "")
      .first<{ id: string }>();
    if (dupSerial) return { error: "JÁ EXISTE UMA MAQUINETA COM ESSE SERIAL.", status: 409 };
    takenSerials?.add(serial);
  }
  return {
    input: {
      acquirerId, acquirerName: acquirer.name, model, adminPassword, serial, establishmentCode,
      terminal, installedAt, notes, status, companyId, companyName,
    },
  };
}

export function insertMachineSql(id: string, input: MachineInput, actor: { id: string; displayName: string }): [string, unknown[]] {
  const who = actor.displayName || "Administrador";
  return [
    `INSERT INTO finance_card_machines
      (id, acquirer_id, acquirer_name, model, serial, establishment_code, terminal,
       company_id, company_name, installed_at, status, notes,
       created_by, created_by_name, updated_by, updated_by_name, admin_password)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?13, ?14, ?15)`,
    [
      id, input.acquirerId, input.acquirerName, input.model, input.serial, input.establishmentCode, input.terminal,
      input.companyId, input.companyName, input.installedAt, input.status, input.notes, actor.id, who, input.adminPassword,
    ],
  ];
}
