// Dashboard de Divergências (ilha React) — lógica pura, sem React e sem DOM,
// para poder ser testada direto no Node (tests/islands-divergences-dashboard
// .test.mjs). Recebe a resposta de GET /api/divergences/dashboard e devolve
// o que os componentes desenham, com os mesmos textos e cálculos do
// renderDivDashboard vanilla de public/estoque.html (que continua lá como
// reserva).

import {
  divergenceLabel,
  ITEM_STATUS_LABELS,
  ITEM_STATUSES,
  OVERDUE_DAYS,
  REQUEST_STATUSES,
  type ItemStatus,
  type RequestStatus,
} from "../../app/lib/divergences";

export type DashboardStore = {
  companyId?: string;
  companyName?: string;
  requests?: number;
  items?: number;
  missing?: number;
  surplus?: number;
  pending?: number;
};

export type DashboardProductStore = {
  companyName?: string;
  divergence?: number;
  items?: number;
};

export type DashboardProduct = {
  productCode?: string;
  productName?: string;
  occurrences?: number;
  totalAbs?: number;
  storeCount?: number;
  multiStore?: boolean;
  stores?: DashboardProductStore[];
};

/** Resposta de GET /api/divergences/dashboard (campos opcionais por segurança). */
export type DashboardData = {
  allStores?: boolean;
  totals?: { requests?: number; items?: number; totalAbs?: number; overdue?: number };
  requestsByStatus?: Partial<Record<string, number>>;
  itemsByStatus?: Partial<Record<string, number>>;
  byStore?: DashboardStore[];
  topProducts?: DashboardProduct[];
};

/** Filtro aplicado na aba PEDIDOS ao clicar num card de métrica. */
export type MetricFilter = { status: RequestStatus | ""; itemStatus: ItemStatus | "" };

export type DashboardProps = {
  data: DashboardData | null | undefined;
  onMetricClick?: (filter: MetricFilter) => void;
};

export type Tone = "" | "alert" | "progress";

/** Mesmo critério do vanilla: qualquer coisa não numérica vira 0. */
export function toCount(value: unknown): number {
  return Number(value) || 0;
}

/** Número com separador de milhar do pt-BR (1.234). */
export function formatCount(value: unknown): string {
  return toCount(value).toLocaleString("pt-BR");
}

/** Largura de barra em % (2 casas, igual ao vanilla), limitada a 0–100%. */
export function barWidth(value: unknown, max: unknown): string {
  const total = toCount(max);
  const ratio = total > 0 ? toCount(value) / total : 0;
  return `${(Math.min(1, Math.max(0, ratio)) * 100).toFixed(2)}%`;
}

/** Chaves estáveis e únicas para as listas (repete → ganha sufixo). */
function uniqueKeys(values: string[]): string[] {
  const seen = new Map<string, number>();
  return values.map((value) => {
    const count = seen.get(value) || 0;
    seen.set(value, count + 1);
    return count ? `${value}#${count}` : value;
  });
}

const REQUEST_METRIC_LABELS: Record<RequestStatus, string> = {
  aberto: "PEDIDOS EM ABERTO",
  verificacao: "PEDIDOS EM VERIFICAÇÃO",
  finalizado: "PEDIDOS FINALIZADOS",
};

export type Metric = {
  key: string;
  label: string;
  value: number;
  alert: boolean;
  filter: MetricFilter;
};

/** Os 4 cards do topo: 3 status de pedido + itens não vistos há +14 dias. */
export function buildMetrics(data: DashboardData | null | undefined): Metric[] {
  const requests = data?.requestsByStatus || {};
  const overdue = toCount(data?.totals?.overdue);
  return [
    ...REQUEST_STATUSES.map((status) => ({
      key: status,
      label: REQUEST_METRIC_LABELS[status],
      value: toCount(requests[status]),
      alert: false,
      filter: { status, itemStatus: "" } as MetricFilter,
    })),
    {
      key: "overdue",
      label: `NÃO VISTOS HÁ MAIS DE ${OVERDUE_DAYS} DIAS`,
      value: overdue,
      alert: overdue > 0,
      filter: { status: "", itemStatus: "nao_visto" },
    },
  ];
}

export type ItemsChartRow = {
  status: ItemStatus;
  label: string;
  count: number;
  /** Fatia na barra empilhada (proporção do total de itens). */
  share: string;
  /** Barra da linha (proporção do maior status). */
  width: string;
};

export type ItemsChart = { total: number; summary: string; rows: ItemsChartRow[] };

/** ITENS POR STATUS: barra empilhada + uma barra por status (ordem fixa). */
export function buildItemsChart(data: DashboardData | null | undefined): ItemsChart {
  const items = data?.itemsByStatus || {};
  const total = toCount(data?.totals?.items);
  const counts = ITEM_STATUSES.map((status) => ({ status, count: toCount(items[status]) }));
  const max = Math.max(1, ...counts.map(({ count }) => count));
  return {
    total,
    summary: `${formatCount(total)} ITEM(NS) · ${formatCount(data?.totals?.totalAbs)} UN. DE DIVERGÊNCIA`,
    rows: counts.map(({ status, count }) => ({
      status,
      label: ITEM_STATUS_LABELS[status],
      count,
      share: barWidth(count, total),
      width: barWidth(count, max),
    })),
  };
}

export type StoreChartRow = {
  key: string;
  name: string;
  detail: string;
  missing: number;
  surplus: number;
  missingWidth: string;
  surplusWidth: string;
};

/** DIVERGÊNCIAS POR LOJA: as duas barras usam a mesma escala (maior lado). */
export function buildStoreChart(data: DashboardData | null | undefined): StoreChartRow[] {
  const stores = Array.isArray(data?.byStore) ? data.byStore : [];
  const maxSide = Math.max(1, ...stores.map((store) => Math.max(toCount(store.missing), toCount(store.surplus))));
  const keys = uniqueKeys(stores.map((store) => `store:${store.companyId || store.companyName || ""}`));
  return stores.map((store, index) => {
    const missing = toCount(store.missing);
    const surplus = toCount(store.surplus);
    return {
      key: keys[index],
      name: store.companyName || "—",
      detail: `${toCount(store.items)} ITEM(NS) · ${toCount(store.pending)} PENDENTE(S)`,
      missing,
      surplus,
      missingWidth: barWidth(missing, maxSide),
      surplusWidth: barWidth(surplus, maxSide),
    };
  });
}

/**
 * Mesma ordem da rota (app/api/divergences/dashboard/route.ts): mais lojas,
 * depois mais ocorrências, mais unidades e nome (pt-BR). A rota já entrega
 * ordenado; reaplicar aqui só garante a ordem se a resposta mudar.
 */
export function sortTopProducts(products: DashboardProduct[]): DashboardProduct[] {
  return [...products].sort((a, b) =>
    toCount(b.storeCount) - toCount(a.storeCount) ||
    toCount(b.occurrences) - toCount(a.occurrences) ||
    toCount(b.totalAbs) - toCount(a.totalAbs) ||
    String(a.productName || "").localeCompare(String(b.productName || ""), "pt-BR"));
}

export type Pill = { key: string; label: string; tone: Tone };

export type TopProductRow = {
  key: string;
  rank: string;
  name: string;
  detail: string;
  multiStore: boolean;
  stores: Pill[];
  side: Pill;
};

/** PRODUTOS MAIS DIVERGENTES: ranking com uma pílula por loja. */
export function buildTopProducts(data: DashboardData | null | undefined): TopProductRow[] {
  const products = sortTopProducts(Array.isArray(data?.topProducts) ? data.topProducts : []);
  const keys = uniqueKeys(products.map((product) => `product:${product.productCode || ""}:${product.productName || ""}`));
  return products.map((product, index) => {
    const stores = Array.isArray(product.stores) ? product.stores : [];
    const storeKeys = uniqueKeys(stores.map((store) => store.companyName || "—"));
    const multiStore = Boolean(product.multiStore);
    return {
      key: keys[index],
      rank: `${index + 1}º`,
      name: product.productName || "—",
      detail: `${product.productCode ? `CÓD. ${product.productCode} · ` : ""}${toCount(product.occurrences)} OCORRÊNCIA(S) · ${toCount(product.totalAbs)} UN. DE DIVERGÊNCIA`,
      multiStore,
      stores: stores.map((store, storeIndex) => {
        const divergence = toCount(store.divergence);
        return {
          key: storeKeys[storeIndex],
          label: `${store.companyName || "—"}: ${divergenceLabel(divergence, 0)}`,
          tone: divergence < 0 ? "alert" : divergence > 0 ? "progress" : "",
        };
      }),
      side: multiStore
        ? { key: "side", label: `EM ${toCount(product.storeCount)} LOJAS`, tone: "alert" }
        : { key: "side", label: "1 LOJA", tone: "" },
    };
  });
}
