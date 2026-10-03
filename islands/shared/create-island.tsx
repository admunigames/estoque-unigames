// Contrato comum das ilhas React (ver README, seção "Ilhas React"): cada
// ilha registra { mount, update, unmount } em window.UnigamesIslands e o
// vanilla (loadIsland em public/estoque.html) só conversa com isso.
//
// mount/update desenham de forma SÍNCRONA (flushSync) e LANÇAM o erro se o
// React não conseguir desenhar — assim o try/catch do vanilla percebe a
// falha na hora e cai no renderizador antigo (regra do fallback).

import type { ComponentType } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

export type IslandApi<P> = {
  mount(container: Element, props: P): void;
  update(props: P): void;
  unmount(): void;
};

declare global {
  interface Window {
    UnigamesIslands?: Record<string, IslandApi<never> | undefined>;
  }
}

export function createIsland<P extends object>(Component: ComponentType<P>): IslandApi<P> {
  let root: Root | null = null;
  let failed = false;
  let failure: unknown = null;

  function render(props: P) {
    const current = root;
    if (!current) throw new Error("A ILHA AINDA NÃO FOI MONTADA.");
    failed = false;
    failure = null;
    flushSync(() => current.render(<Component {...props} />));
    if (failed) {
      const error = failure instanceof Error ? failure : new Error(String(failure));
      failed = false;
      failure = null;
      throw error;
    }
  }

  return {
    mount(container, props) {
      root?.unmount();
      root = createRoot(container, {
        // Erro de render sem Error Boundary: o React desmonta a árvore e
        // chama isto dentro do flushSync; render() relança para o vanilla.
        onUncaughtError(error) {
          failed = true;
          failure = error;
        },
      });
      render(props);
    },
    update: render,
    unmount() {
      root?.unmount();
      root = null;
    },
  };
}

/** Publica a API da ilha para o carregador do vanilla (nome em camelCase). */
export function registerIsland<P>(name: string, api: IslandApi<P>) {
  window.UnigamesIslands = window.UnigamesIslands || {};
  window.UnigamesIslands[name] = api as IslandApi<never>;
}
