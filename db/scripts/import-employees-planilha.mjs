// Importa os funcionários reais da planilha "CADASTRO DE
// FUNCIONARIOS.xlsx" pra hr_employees, substituindo os 31 fictícios
// de teste (removidos antes, ver DELETE no PR que criou este script).
// RODAR SÓ DEPOIS que a migration 0073 (colunas rg e telefone) já
// estiver aplicada em produção.
//
// Tudo roda numa única transação: se qualquer INSERT falhar, nada fica
// gravado. Recusa rodar de novo se já houver linhas importadas por ele.
//
// Funcionário cujo CPF já está cadastrado no sistema NÃO é inserido de novo:
// o registro existente é atualizado preenchendo só os campos que estão
// vazios nele (nome e dados digitados à mão são preservados) — decisão
// confirmada com o usuário.
//
// Uso:
//   SUPABASE_DB_URL="postgresql://..." node db/scripts/import-employees-planilha.mjs

import postgres from "postgres";
import { randomUUID } from "node:crypto";

const CREATED_BY = "import-planilha-script";

// Apelido (como está na planilha, maiúsculo/sem acento) -> nome real
// da loja já cadastrada em shared_state('companies_list').
const COMPANY_ALIASES = {
  "QUISOQUE": "QUIOSQUE P.A",
  "QUIOSQUE": "QUIOSQUE P.A",
  "UNIGAMES-RIOMAR": "RIOMAR",
  "UNIGAMES RIOMAR": "RIOMAR",
  "UNIGAMES-RECIFE": "RECIFE",
  "RECIFE": "RECIFE",
  "UNIGAMES-TACARUNA": "TACARUNA",
  "TACARUNA": "TACARUNA",
  "UNIGAMES GUARARAPES": "GUARARAPES",
  "GUARARAPES": "GUARARAPES",
  "UNIGAMES-NORTH WAY": "NORTH WAY",
  "P.A": "P.A LOJA",
  "UNIGAMES-PATTEO": "PATTEO",
  "UNIGAMES FILIAL RECIFE NOVA": "RECIFE",
  "DEPOSITO": "DEPÓSITO",
};

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .trim().toUpperCase();
}

const EMPLOYEES = [
  { fullName: "ALEXSANDRO PERES", cpf: "11102444448", rg: "8216759", telefone: "81 8459-4206", email: "alex.peres@outlook.com", roleTitle: "OPERACIONAL", salaryCents: 0, pixKey: "", birthDate: "1996-10-27", admissionDate: "2025-12-01", company: "QUISOQUE" },
  { fullName: "ALINE LETICIA", cpf: "15932336471", rg: "15932336471", telefone: "(81) 99611-5106", email: "alineleticia986@gmail.com", roleTitle: "LÍDER OPERACIONAL", salaryCents: 0, pixKey: "", birthDate: "2003-12-23", admissionDate: "2025-06-09", company: "UNIGAMES-RIOMAR" },
  { fullName: "ARIANY KELLY", cpf: "15005546421", rg: "7907615", telefone: "81 8655-6799", email: "ariany.kelly03@gmail.com", roleTitle: "Vendedor", salaryCents: 0, pixKey: "", birthDate: "2003-03-03", admissionDate: "2026-04-06", company: "UNIGAMES-RECIFE" },
  { fullName: "ASAFE AOKY", cpf: "11346288461", rg: "9269066", telefone: "81-98502-5896", email: "aoky2015@gmail.com", roleTitle: "Vendedor", salaryCents: 0, pixKey: "", birthDate: "1998-07-21", admissionDate: "2022-11-21", company: "UNIGAMES-TACARUNA" },
  { fullName: "BRENNDHA PEREIRA", cpf: "07417193471", rg: "9108684", telefone: "(81)9.9351-7053", email: "Brenndha_21@hotmail.com", roleTitle: "ASSISTENTE COMERCIAL", salaryCents: 0, pixKey: "", birthDate: "2001-01-21", admissionDate: "2026-03-09", company: "UNIGAMES-RECIFE" },
  { fullName: "BRENO CIPRIANO", cpf: "01568948409", rg: "", telefone: "81986790559", email: "brenociprianoo123@gmail.com", roleTitle: "Vendedor", salaryCents: 0, pixKey: "", birthDate: "", admissionDate: "2033-08-21", company: "UNIGAMES-RIOMAR" },
  { fullName: "CECILLIA SALES", cpf: "13303766410", rg: "10199382", telefone: "81985577579", email: "cecilliasales14@gmail.com", roleTitle: "GERENTE TECNICO", salaryCents: 163900, pixKey: "81985577579", birthDate: "2005-03-08", admissionDate: "", company: "" },
  { fullName: "CLAUDIO AUGUSTO", cpf: "07359595444", rg: "10826360", telefone: "81 9140-6850", email: "claudioaugusto3371@gmail.com", roleTitle: "LÍDER COMERCIAL", salaryCents: 0, pixKey: "", birthDate: "2004-02-27", admissionDate: "2025-03-06", company: "" },
  { fullName: "DAVI GABRIEL", cpf: "71572294477", rg: "71572294477", telefone: "81987970182", email: "davigabriel8899@gmail.com", roleTitle: "OPERACIONAL", salaryCents: 0, pixKey: "", birthDate: "2008-02-03", admissionDate: "2026-09-28", company: "UNIGAMES-RIOMAR" },
  { fullName: "DEIVID NASCIMENTO", cpf: "08522373400", rg: "", telefone: "81992952654", email: "deividpaes34@gmail.com", roleTitle: "MOTOQUEIRO", salaryCents: 0, pixKey: "", birthDate: "1983-12-22", admissionDate: "2026-09-23", company: "" },
  { fullName: "DOUGLAS FEITOSA", cpf: "", rg: "", telefone: "81-98171-3754", email: "douglasconzz@hotmail.com", roleTitle: "DIRETOR", salaryCents: 0, pixKey: "", birthDate: "1975-01-29", admissionDate: "2015-02-13", company: "DEPOSITO" },
  { fullName: "DOUGLAS SANTOS", cpf: "11135563403", rg: "8910757", telefone: "81997377773", email: "d.sou.art@gmail.com", roleTitle: "LIDER COMERCIAL", salaryCents: 0, pixKey: "", birthDate: "1994-11-12", admissionDate: "2026-03-05", company: "UNIGAMES GUARARAPES" },
  { fullName: "EMERSON CRUZ", cpf: "09948474406", rg: "09948474406", telefone: "81994945196", email: "Emersoncruz3016@gmail.com", roleTitle: "OPERACIONAL", salaryCents: 0, pixKey: "", birthDate: "2000-03-30", admissionDate: "2026-07-01", company: "UNIGAMES-TACARUNA" },
  { fullName: "ESDRAS JERONIMO", cpf: "10101153406", rg: "8562332", telefone: "81-988349805", email: "ezraferreira51@gmail.com", roleTitle: "SUPERVISOR COMERCIAL", salaryCents: 163900, pixKey: "10101153406", birthDate: "1994-03-24", admissionDate: "", company: "UNIGAMES RIOMAR" },
  { fullName: "EVELLYN BRUNA", cpf: "71196037442", rg: "71196037442", telefone: "81993363324", email: "bevellynnn@icloud.com", roleTitle: "Vendedor", salaryCents: 0, pixKey: "", birthDate: "2003-03-23", admissionDate: "2026-09-28", company: "UNIGAMES GUARARAPES" },
  { fullName: "FERNANDO DE LIMA", cpf: "11058912402", rg: "210592612076", telefone: "81 9989-9506", email: "fernandolima.2507@gmail.com", roleTitle: "TÉCNICO", salaryCents: 0, pixKey: "", birthDate: "1992-04-30", admissionDate: "", company: "DEPOSITO" },
  { fullName: "GABRIEL UBIRACY", cpf: "14596667470", rg: "", telefone: "81996666563", email: "ubiracy.gabriel123@gmail.com", roleTitle: "OPERACIONAL", salaryCents: 0, pixKey: "", birthDate: "2004-04-28", admissionDate: "2026-08-06", company: "" },
  { fullName: "GEOVANA SOARES", cpf: "13673304402", rg: "11509777", telefone: "81 9273-6204", email: "geovanassoares55@gmail.com", roleTitle: "OPERACIONAL", salaryCents: 0, pixKey: "", birthDate: "2007-05-15", admissionDate: "2025-12-16", company: "UNIGAMES-RECIFE" },
  { fullName: "GEOVANE SOARES", cpf: "13673372408", rg: "", telefone: "81 9207-8953", email: "geovanesoarres888@gmail.com", roleTitle: "OPERACIONAL", salaryCents: 0, pixKey: "", birthDate: "2007-05-15", admissionDate: "2026-03-23", company: "UNIGAMES GUARARAPES" },
  { fullName: "GIOVANNA GOMES", cpf: "71748521497", rg: "10912093", telefone: "81994578637", email: "giovannagomes940@gmail.com", roleTitle: "OPERACIONAL", salaryCents: 0, pixKey: "", birthDate: "2005-10-29", admissionDate: "2026-09-07", company: "UNIGAMES-RIOMAR" },
  { fullName: "GLAUBER BARBOSA", cpf: "12287630465", rg: "12287630465", telefone: "81 99758-1332", email: "fpsar145@gmail.com", roleTitle: "Vendedor", salaryCents: 0, pixKey: "", birthDate: "2007-03-19", admissionDate: "2026-09-28", company: "UNIGAMES-TACARUNA" },
  { fullName: "GUGUINHA", cpf: "07896626470", rg: "2364476", telefone: "81-8445-1222", email: "douglasconzz15@gmail.com", roleTitle: "DIRETOR", salaryCents: 0, pixKey: "", birthDate: "2021-11-15", admissionDate: "2015-02-13", company: "DEPOSITO" },
  { fullName: "ISRAEL EDGAR", cpf: "13326705476", rg: "13326705476", telefone: "81999199599", email: "israeledgar255@gmail.com", roleTitle: "AUXILIAR TECNICO", salaryCents: 0, pixKey: "", birthDate: "2000-06-22", admissionDate: "2026-06-10", company: "DEPOSITO" },
  { fullName: "JHONATHA LIMA", cpf: "71468524402", rg: "10502758", telefone: "81984890658", email: "Jonatha901santos@gmail.com", roleTitle: "AUXILIAR TECNICO", salaryCents: 0, pixKey: "", birthDate: "2002-09-27", admissionDate: "2026-07-09", company: "DEPOSITO" },
  { fullName: "JHONY ANDERSON", cpf: "13707556433", rg: "10328538", telefone: "81993041823", email: "ribeirojhonyanderson@gmail.com", roleTitle: "VENDEDOR", salaryCents: 0, pixKey: "", birthDate: "2005-03-22", admissionDate: "2025-05-16", company: "QUIOSQUE" },
  { fullName: "JOÃO", cpf: "", rg: "", telefone: "81 9275-1205", email: "", roleTitle: "", salaryCents: 0, pixKey: "", birthDate: "", admissionDate: "", company: "" },
  { fullName: "JOÃO VITOR", cpf: "70662203402", rg: "9826386", telefone: "81981426075", email: "rotivy123@gmail.com", roleTitle: "Vendedor", salaryCents: 0, pixKey: "", birthDate: "2000-08-19", admissionDate: "2026-06-13", company: "QUIOSQUE" },
  { fullName: "JOSÉ GUILHERME", cpf: "17293045409", rg: "17293045409", telefone: "81 994299811", email: "joseguilhermee002@gmail.com", roleTitle: "OPERACIONAL", salaryCents: 0, pixKey: "", birthDate: "2007-02-25", admissionDate: "2026-09-02", company: "QUIOSQUE" },
  { fullName: "LEANDRO NERI", cpf: "70207578478", rg: "9429737", telefone: "81 8680-8196", email: "leandroo32211@gmail.com", roleTitle: "VENDEDOR", salaryCents: 0, pixKey: "", birthDate: "1998-12-30", admissionDate: "2025-03-03", company: "UNIGAMES-TACARUNA" },
  { fullName: "LIDIANE DE SENA", cpf: "11267896400", rg: "11420851", telefone: "81 98112-7575", email: "lidianesenasantos@hotmail.com", roleTitle: "AUXILIAR RH", salaryCents: 0, pixKey: "", birthDate: "2005-11-19", admissionDate: "2025-03-01", company: "DEPOSITO" },
  { fullName: "LUIZ ARTUR", cpf: "16060182488", rg: "16060182488", telefone: "81992335063", email: "Luiizallves800@gmail.com", roleTitle: "OPERACIONAL", salaryCents: 0, pixKey: "", birthDate: "2002-01-13", admissionDate: "2026-07-27", company: "UNIGAMES-RIOMAR" },
  { fullName: "LUIZ FERNANDO", cpf: "13377490442", rg: "10228366", telefone: "81 8338-3046", email: "Luiz83766@gmail.com", roleTitle: "TECNICO", salaryCents: 0, pixKey: "", birthDate: "2001-07-21", admissionDate: "2024-12-01", company: "DEPOSITO" },
  { fullName: "LUIZ FILIPE", cpf: "11179750454", rg: "10031618", telefone: "81-99538-5250", email: "filipenascimento12@gmail.com", roleTitle: "LIDER COMERCIAL", salaryCents: 0, pixKey: "", birthDate: "2001-02-22", admissionDate: "", company: "UNIGAMES-NORTH WAY" },
  { fullName: "LUIZ HENRIQUE", cpf: "12331854467", rg: "12331854467", telefone: "81989220911", email: "euhenry91@gmail.com", roleTitle: "VENDEDOR", salaryCents: 0, pixKey: "", birthDate: "2003-05-16", admissionDate: "2026-07-18", company: "P.A" },
  { fullName: "MARCELLO TIMOTEO", cpf: "09849462418", rg: "8670057", telefone: "81994064267", email: "marcellovinny22@gmail.com", roleTitle: "Vendedor", salaryCents: 0, pixKey: "", birthDate: "1993-10-22", admissionDate: "2026-05-17", company: "UNIGAMES-RIOMAR" },
  { fullName: "MARIA SUYANE", cpf: "09279381466", rg: "9673875", telefone: "81999440600", email: "suyane_oliveira@hotmail.com", roleTitle: "LÍDER COMERCIAL", salaryCents: 0, pixKey: "", birthDate: "1997-02-23", admissionDate: "2024-12-01", company: "GUARARAPES" },
  { fullName: "MIKAEL ALESSANDER", cpf: "71156934478", rg: "10185498", telefone: "81987968577", email: "Mikael.alessander2002@gmail.com", roleTitle: "Vendedor", salaryCents: 0, pixKey: "", birthDate: "2002-12-23", admissionDate: "2026-03-02", company: "UNIGAMES-NORTH WAY" },
  { fullName: "NAOMI LIZANDRA", cpf: "07262689410", rg: "", telefone: "81-98737-9486", email: "naomiunigames@gmail.com", roleTitle: "GERENTE ADM", salaryCents: 0, pixKey: "", birthDate: "2003-09-15", admissionDate: "", company: "DEPOSITO" },
  { fullName: "NORDSON DE PAULA", cpf: "03546957466", rg: "6030466", telefone: "81 9559-1593", email: "Nordsonfilho@gmail.com", roleTitle: "MOTOQUEIRO", salaryCents: 0, pixKey: "", birthDate: "1983-08-13", admissionDate: "2026-01-02", company: "DEPOSITO" },
  { fullName: "OTAVIO PAULO", cpf: "13842518471", rg: "10465565", telefone: "98850-4370", email: "otavio2003paulo@gmail.com", roleTitle: "Vendedor", salaryCents: 0, pixKey: "", birthDate: "2003-01-29", admissionDate: "", company: "RECIFE" },
  { fullName: "PEDRO PAULO", cpf: "11644021455", rg: "9185291", telefone: "81-99791-5853", email: "p.galdinho116@gmail.com", roleTitle: "GERENTE TECNICO", salaryCents: 400000, pixKey: "", birthDate: "1996-07-20", admissionDate: "2026-02-16", company: "DEPOSITO" },
  { fullName: "RENATO FREIRE", cpf: "12448794448", rg: "8711398", telefone: "81-98297-6536", email: "renatofreire.unigames@gmail.com", roleTitle: "ESTOQUE/ FISCAL", salaryCents: 0, pixKey: "", birthDate: "1999-07-31", admissionDate: "", company: "DEPOSITO" },
  { fullName: "RHUAN EXPEDITO", cpf: "11781576440", rg: "9778085", telefone: "81998263624", email: "rhuanbandeira2012@hotmail.com", roleTitle: "TECNICO", salaryCents: 0, pixKey: "", birthDate: "1999-09-28", admissionDate: "", company: "DEPOSITO" },
  { fullName: "RODRIGO PEREIRA", cpf: "14034014466", rg: "10416735", telefone: "81 8636-6293", email: "rpsilva135@gmail.com", roleTitle: "OPERACIONAL", salaryCents: 0, pixKey: "", birthDate: "2000-02-09", admissionDate: "2026-01-10", company: "UNIGAMES-NORTH WAY" },
  { fullName: "SALES", cpf: "10376525410", rg: "7097373", telefone: "81-98581-7740", email: "ricksales21@gmail.com", roleTitle: "GERENTE COMERCIAL", salaryCents: 0, pixKey: "", birthDate: "1993-06-06", admissionDate: "", company: "DEPOSITO" },
  { fullName: "SERGIO DE ANDRADE", cpf: "71185484485", rg: "10209487", telefone: "81988928702", email: "sergio_rogerio123@hotmail.com", roleTitle: "Vendedor", salaryCents: 0, pixKey: "", birthDate: "2002-01-14", admissionDate: "2026-05-01", company: "QUIOSQUE" },
  { fullName: "TATIANY LUIZA", cpf: "70305601407", rg: "70305601407", telefone: "81986060276", email: "tatianyluiza17@gmail.com", roleTitle: "Vendedor", salaryCents: 0, pixKey: "", birthDate: "2003-09-15", admissionDate: "2026-06-15", company: "UNIGAMES-RECIFE" },
  { fullName: "THAMIRES BARBOSA", cpf: "11434065405", rg: "8848934", telefone: "81987891081", email: "thamires.barbosa@yahoo.com", roleTitle: "ASSISTENTE DE PUBLICIDADE", salaryCents: 0, pixKey: "", birthDate: "1993-01-09", admissionDate: "2026-09-04", company: "RECIFE" },
  { fullName: "THAYNA SHIRLEY", cpf: "70733905498", rg: "9853338", telefone: "(81) 98660-1902", email: "Thaynashirley0@gmail.com", roleTitle: "OPERACIONAL", salaryCents: 0, pixKey: "", birthDate: "1999-08-29", admissionDate: "2026-04-06", company: "UNIGAMES GUARARAPES" },
  { fullName: "THIAGO SOARES", cpf: "11733433422", rg: "9479676", telefone: "81 98418-9862", email: "thiagosoares2598@gmail.com", roleTitle: "LIDER OPERACIONAL", salaryCents: 0, pixKey: "11733433422", birthDate: "1998-03-25", admissionDate: "", company: "UNIGAMES FILIAL RECIFE NOVA" },
  { fullName: "THIERRY", cpf: "13237103454", rg: "8833090", telefone: "81 9939-5115", email: "Thierrysilvasantana@hotmail.com", roleTitle: "Assistente administrativo", salaryCents: 0, pixKey: "", birthDate: "2003-06-17", admissionDate: "2025-11-18", company: "UNIGAMES-RIOMAR" },
  { fullName: "VICTOR HUGO", cpf: "10917641400", rg: "", telefone: "81 9860-4242", email: "", roleTitle: "AUXILIAR LOGISTICA", salaryCents: 0, pixKey: "", birthDate: "1997-04-16", admissionDate: "2026-03-05", company: "" },
  { fullName: "VICTORIA CONZZ", cpf: "70282961488", rg: "9510884", telefone: "81-99477-6297", email: "victoriaconzz@hotmail.com", roleTitle: "SUPERVISOR COMERCIAL", salaryCents: 0, pixKey: "", birthDate: "2001-12-27", admissionDate: "", company: "DEPOSITO" },
  { fullName: "VINICIUS DE FREITAS", cpf: "70526471417", rg: "9726142", telefone: "81997942091", email: "viniciusdefreitas14@gmail.com", roleTitle: "OPERACIONAL", salaryCents: 0, pixKey: "viniciusdefreitas14@gmail.com", birthDate: "1996-06-18", admissionDate: "2023-11-01", company: "TACARUNA" },
  { fullName: "VITOR DE LIMA", cpf: "12956426460", rg: "10662199", telefone: "81991604456", email: "vitorviard@outlook.com", roleTitle: "Vendedor", salaryCents: 0, pixKey: "", birthDate: "2000-05-19", admissionDate: "2026-07-22", company: "UNIGAMES-NORTH WAY" },
  { fullName: "VITOR GOMES", cpf: "71654617440", rg: "10751048", telefone: "81 9500-6873", email: "vrgmss210706@gmail.com", roleTitle: "OPERACIONAL", salaryCents: 0, pixKey: "", birthDate: "2006-07-21", admissionDate: "2025-10-01", company: "UNIGAMES-NORTH WAY" },
  { fullName: "VITORIA ELAINE", cpf: "15901151470", rg: "11592163", telefone: "81999551315", email: "vitoriamotadasilva.2007@gmail.com", roleTitle: "OPERACIONAL", salaryCents: 0, pixKey: "", birthDate: "2007-03-29", admissionDate: "2026-07-14", company: "UNIGAMES-PATTEO" },
  { fullName: "WAGNER EDUARDO", cpf: "13334979466", rg: "10214108", telefone: "81998748346", email: "wagnereduardo007@gmail.com", roleTitle: "Vendedor", salaryCents: 0, pixKey: "", birthDate: "2000-07-09", admissionDate: "2026-08-03", company: "UNIGAMES-PATTEO" },
  { fullName: "WALESKA QUEIROZ", cpf: "03821760494", rg: "5587159", telefone: "81 99721-8160", email: "waleskaqueiroz1981@gmail.com", roleTitle: "SUPERVISOR OPERACIONAL", salaryCents: 0, pixKey: "", birthDate: "1981-04-02", admissionDate: "2026-07-09", company: "UNIGAMES-RIOMAR" },
  { fullName: "WAMBERTO PORTAL", cpf: "14267798443", rg: "10570216", telefone: "81 99706-5689", email: "wambertojoa@gmail.com", roleTitle: "LIDER COMERCIAL", salaryCents: 0, pixKey: "", birthDate: "2002-05-16", admissionDate: "2024-09-16", company: "UNIGAMES-NORTH WAY" },
  { fullName: "WESLEY LUCAS", cpf: "12793021431", rg: "10417293", telefone: "81 8635-0430", email: "wesleylucas2f@gmail.com", roleTitle: "TECNICO", salaryCents: 0, pixKey: "", birthDate: "1999-07-09", admissionDate: "2025-04-21", company: "DEPOSITO" },
  { fullName: "WILLIAN LUCAS", cpf: "70918265401", rg: "73418000065", telefone: "81 9767-8027", email: "Willian.14256@gmail.com", roleTitle: "MOTORISTA", salaryCents: 0, pixKey: "", birthDate: "1999-06-29", admissionDate: "2025-08-18", company: "DEPOSITO" },
  { fullName: "WILSON ROGÉRIO", cpf: "08436988450", rg: "7974950", telefone: "81993582706", email: "wilcfilho95@gmail.com", roleTitle: "AUXILIAR TECNICO", salaryCents: 0, pixKey: "", birthDate: "1995-01-06", admissionDate: "2026-09-10", company: "UNIGAMES-NORTH WAY" },
];

async function main() {
  if (!process.env.SUPABASE_DB_URL) {
    throw new Error("Defina SUPABASE_DB_URL antes de rodar este script.");
  }
  const sql = postgres(process.env.SUPABASE_DB_URL, { ssl: "require", max: 1 });
  try {
    const already = await sql.unsafe(
      `SELECT COUNT(*)::int AS total FROM hr_employees WHERE created_by=$1`,
      [CREATED_BY],
    );
    if (already[0]?.total > 0) {
      throw new Error(`Já existem ${already[0].total} funcionários importados por este script — abortando para não duplicar.`);
    }

    const companiesRow = await sql.unsafe(
      `SELECT value_json AS value FROM shared_state WHERE state_key='companies_list'`,
    );
    let companies = [];
    try {
      const parsed = JSON.parse(companiesRow[0]?.value || "[]");
      if (Array.isArray(parsed)) companies = parsed;
    } catch {
      companies = [];
    }
    const companyByName = new Map(
      companies
        .filter((c) => c && typeof c.id === "string" && typeof c.name === "string")
        .map((c) => [normalizeKey(c.name), c]),
    );

    const existingCpfRows = await sql.unsafe(`SELECT id, cpf, full_name AS "fullName" FROM hr_employees WHERE cpf <> ''`);
    const existingCpf = new Map(existingCpfRows.map((row) => [row.cpf, row]));

    const seenCpf = new Set();
    const now = new Date().toISOString();
    let inserted = 0;
    let updated = 0;
    let skippedDuplicateCpf = 0;
    const unmatchedCompanies = new Set();

    await sql.begin(async (tx) => {
      for (const emp of EMPLOYEES) {
        let cpf = emp.cpf;
        if (cpf) {
          if (seenCpf.has(cpf)) {
            console.warn(`CPF duplicado (${cpf}) em "${emp.fullName}" — cadastrando sem CPF pra não colidir com o já inserido.`);
            skippedDuplicateCpf++;
            cpf = "";
          } else if (existingCpf.has(cpf)) {
            seenCpf.add(cpf);
          } else {
            seenCpf.add(cpf);
          }
        }

        let companyId = "";
        let companyName = "";
        if (emp.company) {
          const targetName = COMPANY_ALIASES[normalizeKey(emp.company)] || emp.company;
          const match = companyByName.get(normalizeKey(targetName));
          if (match) {
            companyId = match.id;
            companyName = match.name;
          } else {
            unmatchedCompanies.add(emp.company);
          }
        }

        const notes = emp.email ? `E-mail: ${emp.email}` : "";

        const existing = cpf ? existingCpf.get(cpf) : null;
        if (existing) {
          // Só preenche o que está vazio; o resto fica como já estava.
          await tx.unsafe(
            `UPDATE hr_employees SET
               rg = CASE WHEN rg = '' THEN $2 ELSE rg END,
               telefone = CASE WHEN telefone = '' THEN $3 ELSE telefone END,
               admission_date = CASE WHEN admission_date = '' THEN $4 ELSE admission_date END,
               company_id = CASE WHEN company_id = '' THEN $5 ELSE company_id END,
               company_name = CASE WHEN company_id = '' THEN $6 ELSE company_name END,
               role_title = CASE WHEN role_title = '' THEN $7 ELSE role_title END,
               salary_cents = CASE WHEN salary_cents = 0 THEN $8 ELSE salary_cents END,
               pix_key = CASE WHEN pix_key = '' THEN $9 ELSE pix_key END,
               birth_date = CASE WHEN birth_date = '' THEN $10 ELSE birth_date END,
               notes = CASE WHEN notes = '' THEN $11 ELSE notes END,
               updated_by = $12, updated_by_name = 'Importação Planilha RH', updated_at = $13
             WHERE id = $1`,
            [
              existing.id, emp.rg, emp.telefone, emp.admissionDate, companyId, companyName,
              emp.roleTitle, emp.salaryCents, emp.pixKey, emp.birthDate, notes, CREATED_BY, now,
            ],
          );
          console.log(`"${emp.fullName}" já cadastrado como "${existing.fullName}" (mesmo CPF) — só campos vazios preenchidos.`);
          updated++;
          continue;
        }

        await tx.unsafe(
          `INSERT INTO hr_employees
            (id, full_name, cpf, rg, telefone, admission_date, company_id, company_name,
             role_title, salary_cents, pix_key, bank_name, status, work_schedule, user_id,
             notes, birth_date, birthday_acknowledged_year, created_by, created_by_name,
             created_at, updated_by, updated_by_name, updated_at)
           VALUES
            ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'','active','5x2','',$12,$13,0,$15,'Importação Planilha RH',$14,'','',$14)`,
          [
            randomUUID(), emp.fullName, cpf, emp.rg, emp.telefone, emp.admissionDate,
            companyId, companyName, emp.roleTitle, emp.salaryCents, emp.pixKey,
            notes, emp.birthDate, now, CREATED_BY,
          ],
        );
        inserted++;
      }
    });

    console.log(`${inserted} funcionários importados, ${updated} já existentes atualizados.`);
    if (skippedDuplicateCpf) console.log(`${skippedDuplicateCpf} com CPF duplicado (cadastrados sem CPF).`);
    if (unmatchedCompanies.size) console.log("Lojas da planilha sem correspondência encontrada:", [...unmatchedCompanies]);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error("Falha ao importar funcionários:", error);
  process.exitCode = 1;
});
