import * as gd from "./handlers";

// Comercial > Controle de Gorduras (permissões controle_gd:*).
export const GET = (request: Request) => gd.GET(request, gd.COMERCIAL_GD);
export const POST = (request: Request) => gd.POST(request, gd.COMERCIAL_GD);
export const PATCH = (request: Request) => gd.PATCH(request, gd.COMERCIAL_GD);
export const DELETE = (request: Request) => gd.DELETE(request, gd.COMERCIAL_GD);
export const PUT = (request: Request) => gd.PUT(request, gd.COMERCIAL_GD);
