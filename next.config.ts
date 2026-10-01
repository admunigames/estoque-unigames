import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // So afeta o dev server. A tela de login responde com
  // `referrer-policy: no-referrer`, entao o navegador envia o POST do
  // formulario com `Origin: null`, que o vinext bloqueia por padrao.
  allowedDevOrigins: ["null"],
};

export default nextConfig;
