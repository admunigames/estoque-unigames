// Build ÚNICO das ilhas React (ver README, seção "Ilhas React").
//
// - Cada pasta islands/<nome>/ com index.tsx vira uma entrada e uma chave do
//   manifest: para criar uma ilha nova basta criar a pasta.
// - REGRA DO REACT COMPARTILHADO: react, react-dom, react/jsx-runtime (e o
//   scheduler do react-dom) vão para UM chunk só, vendor-react-<hash>.js,
//   que todas as ilhas importam. O Vite 8 usa o Rolldown, onde o equivalente
//   do `manualChunks` do Rollup é `output.codeSplitting.groups`. O build
//   falha se alguma ilha embutir o React ou não importar o vendor. O
//   Rolldown ainda gera um rolldown-runtime-<hash>.js (~90 bytes, helper de
//   CommonJS) importado só pelo vendor; é baixado e cacheado junto com ele.
// - Saída em public/islands/ (gerada, fora do git) para o `vinext build`
//   copiar para dist/client; por isso `islands:build` roda antes dele.

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const ISLANDS_DIR = fileURLToPath(new URL("./islands", import.meta.url));
const OUT_DIR = fileURLToPath(new URL("./public/islands", import.meta.url));
const PUBLIC_BASE = "/islands/";
const VENDOR_CHUNK = "vendor-react";
const REACT_MODULE = /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/;

function islandEntries(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const entry of readdirSync(ISLANDS_DIR, { withFileTypes: true })) {
    const file = path.join(ISLANDS_DIR, entry.name, "index.tsx");
    if (!entry.isDirectory() || !existsSync(file)) continue;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.name) || entry.name === VENDOR_CHUNK) {
      throw new Error(`Nome de ilha inválido: islands/${entry.name} (use kebab-case).`);
    }
    entries[entry.name] = file;
  }
  if (!Object.keys(entries).length) throw new Error("Nenhuma ilha em islands/<nome>/index.tsx.");
  return entries;
}

// Gera public/islands/manifest.json:
// { "vendor": "/islands/vendor-react-<hash>.js",
//   "islands": { "<nome>": "/islands/<nome>-<hash>.js" } }
function islandsManifest(): Plugin {
  return {
    name: "unigames-islands-manifest",
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((file) => file.type === "chunk");
      const vendor = chunks.find((chunk) => chunk.name === VENDOR_CHUNK);
      if (!vendor) this.error(`Chunk ${VENDOR_CHUNK} não foi gerado.`);
      const islands: Record<string, string> = {};
      for (const chunk of chunks.filter((item) => item.isEntry)) {
        if (Object.keys(chunk.modules).some((id) => REACT_MODULE.test(id))) {
          this.error(`A ilha ${chunk.name} embutiu o React; ele deve ficar só em ${VENDOR_CHUNK}.`);
        }
        if (!chunk.imports.includes(vendor.fileName)) {
          this.error(`A ilha ${chunk.name} não importa ${vendor.fileName}.`);
        }
        islands[chunk.name] = PUBLIC_BASE + chunk.fileName;
      }
      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: `${JSON.stringify({ vendor: PUBLIC_BASE + vendor.fileName, islands }, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig({
  // Sem pasta public aqui: a saída já fica dentro de public/.
  publicDir: false,
  plugins: [react(), islandsManifest()],
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    assetsDir: "",
    modulePreload: false,
    rolldownOptions: {
      input: islandEntries(),
      output: {
        format: "es",
        // Hash só com [0-9a-z]: o último "-" do nome sempre separa nome e
        // hash (o service worker usa isso para apagar versões antigas).
        hashCharacters: "base36",
        entryFileNames: "[name]-[hash].js",
        chunkFileNames: "[name]-[hash].js",
        codeSplitting: {
          groups: [{ name: VENDOR_CHUNK, test: REACT_MODULE }],
        },
      },
    },
  },
});
