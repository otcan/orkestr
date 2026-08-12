import type { INestApplication } from "@nestjs/common";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import net from "node:net";
import {
  brokerInstanceByPublicRef,
  resolveBrokerConnectInstance,
} from "../../../packages/core/src/broker-instance-registry.js";
import {
  canonicalAppGatewayEnabled,
  parseInstancePublicRef,
  parseThreadPublicRef,
} from "../../../packages/core/src/canonical-public-references.js";
import { readInstanceIdentity } from "../../../packages/core/src/instance-identity.js";
import { getThreadByPublicRefForPrincipal } from "../../../packages/core/src/threads.js";
import { authorizeHttpRequest } from "../../../packages/core/src/security.js";
import {
  canonicalBrokerBaseUrl,
  proxyCanonicalBrokerHttp,
  proxyCanonicalBrokerUpgrade,
  type CanonicalBrokerTarget,
} from "./canonical-broker-app-proxy.js";
import {
  hostBoundaryUpgradeDenied,
  internalCanonicalUpgradeHeader,
} from "./host-boundaries.js";

export type CanonicalAppRoute = {
  instancePublicRef: string;
  threadPublicRef: string;
  upstreamPath: string;
  prefixPath: string;
};

type ResolvedInstance = {
  kind: "local" | "broker";
  internalInstanceId: string;
  endpointBaseUrl?: string;
};

type CanonicalGatewayContext = {
  route: CanonicalAppRoute;
  instance: ResolvedInstance;
};

function decode(value = ""): string {
  return decodeURIComponent(value);
}

export function parseCanonicalAppUrl(rawUrl = ""): CanonicalAppRoute | null {
  const parsed = new URL(rawUrl || "/", "http://orkestr.local");
  const rawParts = parsed.pathname.split("/").filter(Boolean);
  if (!rawParts.length || decode(rawParts[0]) !== "instance") return null;
  const parts = ["instance", ...rawParts.slice(1).map(decode)];
  if (parts.length < 2) return null;
  const instancePublicRef = parseInstancePublicRef(parts[1]);
  const suffixParts = parts.slice(2);
  let threadPublicRef = "";
  if (suffixParts[0] === "thread") {
    threadPublicRef = parseThreadPublicRef(suffixParts[1]);
  }
  const suffix = `/${suffixParts.map((part) => encodeURIComponent(part)).join("/")}`;
  return {
    instancePublicRef,
    threadPublicRef,
    upstreamPath: `${suffix === "/" ? "/" : suffix}${parsed.search}`,
    prefixPath: `/instance/${encodeURIComponent(instancePublicRef)}/`,
  };
}

function canonicalAppPathCandidate(rawUrl = ""): boolean {
  const parsed = new URL(rawUrl || "/", "http://orkestr.local");
  const first = parsed.pathname.split("/").filter(Boolean)[0] || "";
  try {
    return decode(first) === "instance";
  } catch {
    return first.startsWith("instance");
  }
}

function requestAuthorizedForLocalInstance(request: any, internalInstanceId: string): boolean {
  if (!request?.orkestrPrincipal || request?.orkestrSecuritySession?.shareId) return false;
  const scopedId = String(
    request?.orkestrSecuritySession?.instanceId || request?.orkestrMachineAuthContext?.instanceId || "",
  ).trim();
  return !scopedId || scopedId === internalInstanceId;
}

async function resolveInstance(route: CanonicalAppRoute, request: any): Promise<ResolvedInstance | null> {
  const local = await readInstanceIdentity(process.env);
  if (local?.publicRef === route.instancePublicRef) {
    return requestAuthorizedForLocalInstance(request, local.internalInstanceId)
      ? { kind: "local", internalInstanceId: local.internalInstanceId }
      : null;
  }
  const broker = await brokerInstanceByPublicRef(route.instancePublicRef, process.env);
  if (!broker || String(request?.orkestrSecuritySession?.instanceId || "") !== broker.instanceId) return null;
  const usable = await resolveBrokerConnectInstance(broker.instanceId, process.env).catch(() => null);
  return usable ? {
    kind: "broker",
    internalInstanceId: broker.instanceId,
    endpointBaseUrl: usable.instance?.endpointBaseUrl || "",
  } : null;
}

async function authorizeThread(route: CanonicalAppRoute, request: any): Promise<boolean> {
  if (!route.threadPublicRef) return true;
  return Boolean(await getThreadByPublicRefForPrincipal(
    route.threadPublicRef,
    request?.orkestrPrincipal || {},
    process.env,
  ).catch(() => null));
}

export async function resolveCanonicalRoute(
  route: CanonicalAppRoute,
  request: any,
  dependencies: {
    resolveInstance?: typeof resolveInstance;
    authorizeThread?: typeof authorizeThread;
  } = {},
): Promise<ResolvedInstance | null> {
  const instance = await (dependencies.resolveInstance || resolveInstance)(route, request);
  if (!instance) return null;
  if (instance.kind === "local" && !(await (dependencies.authorizeThread || authorizeThread)(route, request))) return null;
  return instance;
}

export async function preflightCanonicalAppRequest(request: any): Promise<{ matched: boolean; ok: boolean }> {
  if (!canonicalAppGatewayEnabled(process.env)) return { matched: false, ok: true };
  const rawUrl = String(request?.originalUrl || request?.url || "/");
  if (!canonicalAppPathCandidate(rawUrl)) return { matched: false, ok: true };
  let route: CanonicalAppRoute | null = null;
  try { route = parseCanonicalAppUrl(rawUrl); } catch { return { matched: true, ok: false }; }
  if (!route) return { matched: true, ok: false };
  const instance = await resolveInstance(route, request).catch(() => null);
  if (!instance) return { matched: true, ok: false };
  const session = request?.orkestrSecuritySession;
  const specialScope = session?.shareId || (session?.allowedActions || [])
    .some((action: unknown) => String(action).startsWith("orkestr_auth."));
  if (instance.kind === "broker" && specialScope) return { matched: true, ok: false };
  request.orkestrCanonicalGateway = { route, instance } satisfies CanonicalGatewayContext;
  if (instance.kind === "local") request.orkestrPolicyUrl = route.upstreamPath;
  return { matched: true, ok: true };
}

function notFound(response: any): void {
  response.status(404).header("cache-control", "no-store").type("text/plain; charset=utf-8").send("not found");
}

function upgradeNotFound(socket: Duplex): void {
  socket.end("HTTP/1.1 404 Not Found\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\nnot found");
}

function targetFor(route: CanonicalAppRoute, instance: ResolvedInstance): CanonicalBrokerTarget | null {
  const baseUrl = canonicalBrokerBaseUrl(instance.endpointBaseUrl || "");
  if (!baseUrl) return null;
  return {
    instanceId: instance.internalInstanceId,
    upstreamPath: `/instance/${encodeURIComponent(route.instancePublicRef)}${route.upstreamPath}`,
    prefixPath: route.prefixPath,
    baseUrl,
  };
}

export function registerCanonicalAppGateway(app: INestApplication): void {
  if (!canonicalAppGatewayEnabled(process.env)) return;
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.use((request: any, response: any, next: () => void) => {
    if (!canonicalAppPathCandidate(String(request.originalUrl || request.url || "/"))) return next();
    let route: CanonicalAppRoute | null = null;
    try { route = parseCanonicalAppUrl(request.originalUrl || request.url); } catch { notFound(response); return; }
    if (!route) { notFound(response); return; }
    void (async () => {
      const saved = request.orkestrCanonicalGateway as CanonicalGatewayContext | undefined;
      const instance = saved?.route?.instancePublicRef === route.instancePublicRef
        ? saved.instance
        : await resolveCanonicalRoute(route, request).catch(() => null);
      if (!instance) return notFound(response);
      if (instance.kind === "broker") {
        const target = targetFor(route, instance);
        if (!target) return notFound(response);
        return proxyCanonicalBrokerHttp(request, response, target);
      }
      if (!(await authorizeThread(route, request))) return notFound(response);
      request.orkestrCanonicalPrefix = route.prefixPath;
      request.url = route.upstreamPath;
      request.originalUrl = route.upstreamPath;
      return next();
    })().catch(() => notFound(response));
  });
}

export function attachCanonicalAppGatewayUpgrade(server: Server): void {
  if (!canonicalAppGatewayEnabled(process.env)) return;
  server.prependListener("upgrade", async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (hostBoundaryUpgradeDenied(request)) return;
    let route: CanonicalAppRoute | null = null;
    try { route = parseCanonicalAppUrl(request.url || ""); } catch { upgradeNotFound(socket); return; }
    if (!route) return;
    const context = await authorizeHttpRequest(request, process.env).catch(() => null);
    if (!context?.ok) return upgradeNotFound(socket);
    (request as any).orkestrPrincipal = context.principal;
    (request as any).orkestrSecuritySession = context.session || null;
    (request as any).orkestrMachineAuthContext = (context as any).machineAuthContext || null;
    const instance = await resolveCanonicalRoute(route, request).catch(() => null);
    if (!instance) return upgradeNotFound(socket);
    if (instance.kind === "broker") {
      const target = targetFor(route, instance);
      return target ? proxyCanonicalBrokerUpgrade(request, socket, head, target) : upgradeNotFound(socket);
    }
    // Re-enter the local HTTP server at the stripped path so the existing WS
    // handlers remain the single implementation of each protocol endpoint.
    const address = server.address();
    if (!address || typeof address === "string") return upgradeNotFound(socket);
    return proxyLocalUpgrade(request, socket, head, route.upstreamPath, address.port);
  });
}

function proxyLocalUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, path: string, port: number): void {
  const upstream = net.connect(port, "127.0.0.1");
  upstream.on("connect", () => {
    const lines = [`${request.method || "GET"} ${path} HTTP/${request.httpVersion || "1.1"}`];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index] || "";
      const value = request.rawHeaders[index + 1] || "";
      if (["x-orkestr-internal-canonical-upgrade", "x-forwarded-host", "x-forwarded-proto"].includes(name.toLowerCase())) continue;
      lines.push(name.toLowerCase() === "host" ? `Host: 127.0.0.1:${port}` : `${name}: ${value}`);
    }
    if (request.headers["x-forwarded-host"]) lines.push(`X-Forwarded-Host: ${request.headers["x-forwarded-host"]}`);
    if (request.headers["x-forwarded-proto"]) lines.push(`X-Forwarded-Proto: ${request.headers["x-forwarded-proto"]}`);
    lines.push(`X-Orkestr-Internal-Canonical-Upgrade: ${internalCanonicalUpgradeHeader()}`);
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => upgradeNotFound(socket));
}
