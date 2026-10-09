import * as gd from "../controle-gd/handlers";

// Assistência > Controle Gorduras Assistência (permissões gorduras_assistencia:*),
// clone do Controle de Gorduras do Comercial com dados separados.
export const GET = (request: Request) => gd.GET(request, gd.ASSISTENCIA_GD);
export const POST = (request: Request) => gd.POST(request, gd.ASSISTENCIA_GD);
export const PATCH = (request: Request) => gd.PATCH(request, gd.ASSISTENCIA_GD);
export const DELETE = (request: Request) => gd.DELETE(request, gd.ASSISTENCIA_GD);
export const PUT = (request: Request) => gd.PUT(request, gd.ASSISTENCIA_GD);
