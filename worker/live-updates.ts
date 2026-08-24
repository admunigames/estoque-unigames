export const LIVE_MODULES = ["missions", "captures", "supplies", "tasks", "loans"] as const;

export type LiveModule = (typeof LIVE_MODULES)[number];

export type LiveAudience =
  | { kind: "all" }
  | { kind: "company"; companyId: string; groups?: string[] }
  | { kind: "user"; userId: string };

export type LiveInvalidation = {
  module: LiveModule;
  audience: LiveAudience;
};

type LiveConnection = {
  userId: string;
  role: "admin" | "user";
  companyId: string;
  groups: string[];
};

function validTagPart(value: string): boolean {
  return /^[a-z0-9._-]{1,80}$/i.test(value);
}

function connectionTags(connection: LiveConnection): string[] {
  const tags = [
    `role:${connection.role}`,
    `user:${connection.userId}`,
  ];
  if (connection.companyId) tags.push(`company:${connection.companyId}`);
  for (const group of connection.groups) tags.push(`group:${group}`);
  return tags;
}

function socketsForAudience(
  ctx: DurableObjectState,
  audience: LiveAudience,
): WebSocket[] {
  if (audience.kind === "all") return ctx.getWebSockets();

  const tags = audience.kind === "user"
    ? [`user:${audience.userId}`]
    : [
        "role:admin",
        `company:${audience.companyId}`,
        ...(audience.groups ?? []).map((group) => `group:${group}`),
      ];
  const sockets = new Set<WebSocket>();
  for (const tag of tags) {
    for (const socket of ctx.getWebSockets(tag)) sockets.add(socket);
  }
  return [...sockets];
}

export function isLiveModule(value: string | null): value is LiveModule {
  return LIVE_MODULES.includes(value as LiveModule);
}

function isLiveAudience(value: unknown): value is LiveAudience {
  if (!value || typeof value !== "object") return false;
  const audience = value as Partial<LiveAudience>;
  if (audience.kind === "all") return true;
  if (audience.kind === "company") {
    return typeof audience.companyId === "string" && validTagPart(audience.companyId);
  }
  return audience.kind === "user" &&
    typeof audience.userId === "string" &&
    validTagPart(audience.userId);
}

export class LiveUpdates {
  private readonly ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/publish" && request.method === "POST") {
      const invalidation = await request.json<Partial<LiveInvalidation>>();
      if (!isLiveModule(invalidation.module ?? null) || !isLiveAudience(invalidation.audience)) {
        return new Response("Invalid live invalidation", { status: 400 });
      }
      this.publish(invalidation as LiveInvalidation);
      return new Response(null, { status: 204 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    const userId = request.headers.get("x-live-user-id") ?? "";
    const role = request.headers.get("x-live-role") === "admin" ? "admin" : "user";
    const companyId = request.headers.get("x-live-company-id") ?? "";
    const groups = (request.headers.get("x-live-groups") ?? "")
      .split(",")
      .map((group) => group.trim())
      .filter(validTagPart)
      .slice(0, 6);
    if (!validTagPart(userId) || (companyId && !validTagPart(companyId))) {
      return new Response("Invalid live connection", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const connection: LiveConnection = { userId, role, companyId, groups };
    this.ctx.acceptWebSocket(server, connectionTags(connection));
    server.serializeAttachment(connection);
    return new Response(null, { status: 101, webSocket: client });
  }

  private publish(invalidation: LiveInvalidation): void {
    const message = JSON.stringify({
      type: "invalidate",
      module: invalidation.module,
      revision: crypto.randomUUID(),
    });
    for (const socket of socketsForAudience(this.ctx, invalidation.audience)) {
      try {
        socket.send(message);
      } catch {
        // A conexao ja pode ter fechado entre a listagem e o envio.
      }
    }
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") socket.send('{"type":"pong"}');
  }
}
