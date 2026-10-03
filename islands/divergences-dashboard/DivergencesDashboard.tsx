// Dashboard de Divergências desenhado em React, com as MESMAS classes e
// textos do renderDivDashboard vanilla (public/estoque.html). Os elementos
// têm chave estável, então entre uma atualização e outra o React só mexe no
// que mudou e as barras animam a largura (CSS .div-dash-island).

import {
  buildItemsChart,
  buildMetrics,
  buildStoreChart,
  buildTopProducts,
  type DashboardProps,
  type ItemsChart,
  type Pill,
  type StoreChartRow,
  type TopProductRow,
} from "./logic";

function StatusPill({ pill }: { pill: Pill }) {
  return <span className={pill.tone ? `status-pill ${pill.tone}` : "status-pill"}>{pill.label}</span>;
}

function Empty({ text }: { text: string }) {
  return (
    <div className="empty-state">
      <h4>{text}</h4>
    </div>
  );
}

function ItemsPanel({ chart }: { chart: ItemsChart }) {
  return (
    <section className="table-panel div-panel">
      <div className="div-panel-head">
        <h3>ITENS POR STATUS</h3>
        <span>{chart.summary}</span>
      </div>
      <div className="div-chart">
        {chart.total ? (
          <>
            <div className="div-stack" role="img" aria-label="Distribuição dos itens por status">
              {chart.rows.map((row) => (
                <span
                  key={row.status}
                  className={`div-tone-${row.status}`}
                  style={{ width: row.share }}
                  title={row.count ? `${row.label}: ${row.count}` : undefined}
                />
              ))}
            </div>
            {chart.rows.map((row) => (
              <div className="div-bar-row" key={row.status}>
                <span className="div-bar-label">
                  <span className={`div-dot div-tone-${row.status}`} />
                  {row.label}
                </span>
                <span className="div-bar-track">
                  <span className={`div-bar-fill div-tone-${row.status}`} style={{ width: row.width }} />
                </span>
                <span className="div-bar-value">{row.count}</span>
              </div>
            ))}
          </>
        ) : (
          <Empty text="Nenhum item no período." />
        )}
      </div>
    </section>
  );
}

function StoresPanel({ rows }: { rows: StoreChartRow[] }) {
  return (
    <section className="table-panel div-panel">
      <div className="div-panel-head">
        <h3>DIVERGÊNCIAS POR LOJA</h3>
        <span>UNIDADES A MENOS / A MAIS FISICAMENTE</span>
      </div>
      <div className="div-chart">
        {rows.length ? (
          <>
            <div className="div-store-legend">
              <span>LOJA</span>
              <span>A MENOS FISICAMENTE</span>
              <span>A MAIS FISICAMENTE</span>
            </div>
            {rows.map((row) => (
              <div className="div-store-row" key={row.key}>
                <span className="div-bar-label">
                  {row.name}
                  <span className="div-cell-sub">{row.detail}</span>
                </span>
                <span className="div-store-side missing">
                  <span className="div-bar-track">
                    <span className="div-bar-fill" style={{ width: row.missingWidth }} />
                  </span>
                  <strong>{row.missing}</strong>
                </span>
                <span className="div-store-side surplus">
                  <span className="div-bar-track">
                    <span className="div-bar-fill" style={{ width: row.surplusWidth }} />
                  </span>
                  <strong>{row.surplus}</strong>
                </span>
              </div>
            ))}
          </>
        ) : (
          <Empty text="Nenhuma divergência no período." />
        )}
      </div>
    </section>
  );
}

function ProductsPanel({ products }: { products: TopProductRow[] }) {
  return (
    <section className="table-panel div-panel">
      <div className="div-panel-head">
        <h3>PRODUTOS MAIS DIVERGENTES</h3>
        <span>EM DESTAQUE: PRODUTOS COM DIVERGÊNCIA EM MAIS DE UMA LOJA</span>
      </div>
      <div className="div-product-list">
        {products.length ? (
          products.map((product) => (
            <article className={product.multiStore ? "div-product multi" : "div-product"} key={product.key}>
              <span className="div-product-rank">{product.rank}</span>
              <div className="div-product-copy">
                <strong>{product.name}</strong>
                <small>{product.detail}</small>
                <div className="div-product-stores">
                  {product.stores.map((pill) => (
                    <StatusPill key={pill.key} pill={pill} />
                  ))}
                </div>
              </div>
              <div className="div-product-side">
                <StatusPill pill={product.side} />
              </div>
            </article>
          ))
        ) : (
          <Empty text="Nenhum produto com divergência no período." />
        )}
      </div>
    </section>
  );
}

export function DivergencesDashboard({ data, onMetricClick }: DashboardProps) {
  const metrics = buildMetrics(data);
  return (
    <>
      <div className="purchase-metrics div-metrics">
        {metrics.map((metric) => (
          <button
            key={metric.key}
            type="button"
            className={metric.alert ? "purchase-metric div-metric-button alert" : "purchase-metric div-metric-button"}
            onClick={() => onMetricClick?.(metric.filter)}
          >
            <small>{metric.label}</small>
            <strong>{metric.value}</strong>
          </button>
        ))}
      </div>
      <div className="div-dash-grid">
        <ItemsPanel chart={buildItemsChart(data)} />
        <StoresPanel rows={buildStoreChart(data)} />
      </div>
      <ProductsPanel products={buildTopProducts(data)} />
    </>
  );
}
