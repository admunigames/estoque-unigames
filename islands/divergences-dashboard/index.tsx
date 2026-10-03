// Entrada da ilha "divergences-dashboard" (vira /islands/divergences-dashboard-<hash>.js).
// Carregada sob demanda por loadIsland('divergences-dashboard') quando a aba
// DASHBOARD de Divergências abre; busca de dados, filtros e permissões
// continuam no vanilla, que chama mount/update com { data, onMetricClick }.

import { createIsland, registerIsland } from "../shared/create-island";
import { DivergencesDashboard } from "./DivergencesDashboard";

registerIsland("divergencesDashboard", createIsland(DivergencesDashboard));
