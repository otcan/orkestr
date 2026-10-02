import { Body, Controller, Delete, Get, Headers, HttpCode, Post, Query, Req, Res } from "@nestjs/common";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  authorizationServerMetadata,
  createConsent,
  decideConsent,
  exchangeMcpToken,
  listMcpConnections,
  mcpOAuthEnabled,
  mcpPrincipalFromAuthorization,
  mcpPublicBase,
  mcpResourceUrl,
  protectedResourceMetadata,
  registerMcpClient,
  revokeMcpConnection,
  revokeMcpToken,
  validateAuthorizeRequest,
} from "../../../../../packages/core/src/mcp-oauth.js";
import { createThreadBridgeMcpServer } from "../../../../../packages/core/src/thread-bridge-mcp.js";
import { handleModernMcpRequest, isModernMcpRequest, preflightModernMcpRequest, shouldStreamModernRequest } from "../../../../../packages/core/src/mcp-modern-protocol.js";
import { sendMcpJson, streamMcpResponse, trackMcpRequest } from "./mcp-http.js";
import { mcpLandingPage } from "../../../../../packages/core/src/mcp-landing-page.js";
import { readSubscriptions } from "../../../../../packages/core/src/mcp-events.js";
import { keycloakOidcEnabled } from "../../../../../packages/core/src/keycloak-oidc.js";
import { httpError } from "../../common/http.js";

function assertEnabled() {
  if (!mcpOAuthEnabled()) throw httpError("not_found", 404);
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] as string));
}

function oauthFailure(response: any, error: any) {
  const status = Number(error?.statusCode || 400);
  return response.status(status).json({ error: error?.oauthError || "invalid_request", error_description: error?.description || String(error?.message || "") });
}

// Signed-in Orkestr user for the consent step; pre-pairing requests are
// marked anonymous by the auth middleware and never count as a login.
function signedInUser(request: any) {
  const principal = request.orkestrPrincipal;
  if (!principal || request.orkestrAnonymous === true || !principal.userId) return null;
  return { userId: String(principal.userId), sessionId: String(request.orkestrSecuritySession?.id || "") };
}

// Browser form posts must come from this origin (CSRF guard on top of the
// one-time consent id and SameSite session cookie). The site-wide
// "Referrer-Policy: no-referrer" makes browsers send "Origin: null" on form
// POSTs, so a null/absent Origin is accepted only with the browser-controlled
// "Sec-Fetch-Site: same-origin" header, which page scripts cannot set.
function sameOrigin(request: any) {
  const origin = String(request.headers?.origin || "").trim();
  if (origin && origin !== "null") return origin === new URL(mcpPublicBase()).origin;
  return String(request.headers?.["sec-fetch-site"] || "").trim().toLowerCase() === "same-origin";
}

function unauthorized(response: any) {
  return response.status(401)
    .header("www-authenticate", `Bearer resource_metadata="${mcpPublicBase()}/.well-known/oauth-protected-resource/mcp"`)
    .json({ error: "invalid_token" });
}

function consentPage({ request, consentId, userId }: any) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="same-origin">
<title>Connect ${escapeHtml(request.client.clientName)} to Orkestr</title>
<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.5}button{font-size:1rem;padding:.6rem 1.2rem;margin-right:.6rem}li{margin:.3rem 0}</style></head>
<body><h1>Connect ${escapeHtml(request.client.clientName)}</h1>
<p>Signed in to Orkestr as <strong>${escapeHtml(userId)}</strong>. <strong>${escapeHtml(request.client.clientName)}</strong> (returns to ${escapeHtml(request.redirectHost)}) asks to:</p>
<ul><li>read the visible messages of <strong>all your threads</strong>, including future ones;</li>
<li>add comments to your threads, labelled as coming from this assistant;</li>
<li><strong>send messages to your threads' agents</strong>, which then start work as if asked, labelled as coming from this assistant.</li></ul>
<p>Comments are context only. Messages start work in the thread; the agent's answer stays in Orkestr and is not sent to WhatsApp. Nothing is ever sent as you. Access lasts 90 days; you can revoke it at any time.</p>
<form method="post" action="/mcp-oauth/authorize"><input type="hidden" name="consent_id" value="${escapeHtml(consentId)}">
<button type="submit" name="decision" value="approve">Allow</button><button type="submit" name="decision" value="deny">Deny</button></form></body></html>`;
}

@Controller()
export class ThreadBridgeMcpController {
  @Get(".well-known/oauth-protected-resource")
  resourceMetadata() {
    assertEnabled();
    return protectedResourceMetadata();
  }

  @Get(".well-known/oauth-protected-resource/mcp")
  resourceMetadataForPath() {
    assertEnabled();
    return protectedResourceMetadata();
  }

  @Get(".well-known/oauth-authorization-server")
  serverMetadata() {
    assertEnabled();
    return authorizationServerMetadata();
  }

  @Post("mcp-oauth/register")
  @HttpCode(201)
  async register(@Body() body: Record<string, unknown> = {}, @Res() response: any) {
    assertEnabled();
    try { return response.status(201).json(await registerMcpClient(body)); } catch (error) { return oauthFailure(response, error); }
  }

  @Get("mcp-oauth/authorize")
  async authorize(@Req() request: any, @Query() query: Record<string, string>, @Res() response: any) {
    assertEnabled();
    let validated: any;
    try { validated = await validateAuthorizeRequest(query); } catch (error: any) {
      return response.status(400).type("text/plain").send(`Cannot connect: ${error?.description || error?.message}`);
    }
    const user = signedInUser(request);
    if (!user) {
      const returnTo = `/mcp-oauth/authorize?${new URLSearchParams(query).toString()}`;
      if (keycloakOidcEnabled()) return response.status(302).header("location", `/auth/login?return=${encodeURIComponent(returnTo)}`).send("Redirecting to sign in.");
      return response.status(401).type("text/plain").send("Sign in to Orkestr in this browser first, then start the connection again.");
    }
    const consentId = await createConsent(validated, user);
    return response.status(200).type("text/html").header("x-frame-options", "DENY").send(consentPage({ request: validated, consentId, userId: user.userId }));
  }

  @Post("mcp-oauth/authorize")
  async decide(@Req() request: any, @Body() body: Record<string, string> = {}, @Res() response: any) {
    assertEnabled();
    const user = signedInUser(request);
    if (!user) return response.status(401).type("text/plain").send("Sign in to Orkestr first.");
    if (!sameOrigin(request)) return response.status(403).type("text/plain").send("This approval must be submitted from the Orkestr page.");
    try {
      const location = await decideConsent({ consentId: body.consent_id, userId: user.userId, sessionId: user.sessionId, approve: body.decision === "approve" });
      return response.status(302).header("location", location).send("Redirecting.");
    } catch (error: any) {
      return response.status(400).type("text/plain").send(error?.description || "Approval failed.");
    }
  }

  @Post("mcp-oauth/token")
  async token(@Body() body: Record<string, string> = {}, @Headers("authorization") authorization = "", @Res() response: any) {
    assertEnabled();
    try { return response.status(200).header("pragma", "no-cache").json(await exchangeMcpToken(body, authorization)); } catch (error) { return oauthFailure(response, error); }
  }

  @Post("mcp-oauth/revoke")
  @HttpCode(200)
  async revoke(@Body() body: Record<string, string> = {}) {
    assertEnabled();
    await revokeMcpToken(body);
    return {};
  }

  @Post("mcp")
  async mcp(@Req() request: any, @Res() response: any) {
    assertEnabled();
    const principal = await mcpPrincipalFromAuthorization(String(request.headers?.authorization || ""));
    const body = request.body;
    const modern = isModernMcpRequest(body, request.headers);
    const record = trackMcpRequest(request, response, { era: modern ? "2026-07-28" : "legacy", agentId: principal?.agentId || "" });
    if (!principal && !(modern && body?.method === "server/discover")) {
      record.finish("unauthorized", { httpStatus: 401 });
      return unauthorized(response);
    }
    try {
      if (modern) {
        // Validation errors (400 header mismatch / unsupported version, 202
        // for notifications) are answered as JSON before any stream starts.
        const early = preflightModernMcpRequest(body, request.headers);
        if (early) return sendMcpJson(response, record, early.status, early.body);
        const run = (signal: AbortSignal) => handleModernMcpRequest({ body, headers: request.headers, principal, signal });
        if (shouldStreamModernRequest(body, request.headers)) return await streamMcpResponse(response, record, run);
        const result = await run(record.signal);
        return sendMcpJson(response, record, result.status, result.body);
      }
      const server = createThreadBridgeMcpServer({ principal });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.once("close", () => {
        record.finish(record.clientClosed() ? "client_closed" : "ok", { httpStatus: response.statusCode, transport: "sdk" });
        void transport.close().catch(() => {});
        void server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error: any) {
      // Any failure becomes a recorded JSON-RPC error instead of an opaque 500.
      record.finish("exception", { rpcErrorCode: -32603, error: String(error?.message || error).slice(0, 200) });
      if (response.headersSent) return response.end();
      return response.status(500).json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32603, message: "Internal error" } });
    }
  }

  // MCP clients get 405 (no GET stream); a browser gets a page explaining the
  // address and, when signed in, the assistants connected to the account.
  @Get("mcp")
  async mcpGet(@Req() request: any, @Query("revoked") revoked = "", @Res() response: any) {
    assertEnabled();
    if (!String(request.headers?.accept || "").includes("text/html")) {
      return response.status(405).header("allow", "POST").json({ error: "method_not_allowed" });
    }
    const user = signedInUser(request);
    const connections = user ? await listMcpConnections(user.userId) : [];
    const subscriptions = user ? (await readSubscriptions()).subscriptions.filter((entry: any) => entry.ownerUserId === user.userId) : [];
    return response.status(200).type("text/html").header("x-frame-options", "DENY").send(mcpLandingPage({
      resourceUrl: mcpResourceUrl(),
      userId: user?.userId || "",
      connections,
      subscriptions,
      notice: revoked ? "Access revoked." : "",
    }));
  }

  @Post("mcp-oauth/connections/revoke")
  async revokeConnection(@Req() request: any, @Body() body: Record<string, string> = {}, @Res() response: any) {
    assertEnabled();
    const user = signedInUser(request);
    if (!user) return response.status(401).type("text/plain").send("Sign in to Orkestr first.");
    if (!sameOrigin(request)) return response.status(403).type("text/plain").send("Revoke from the Orkestr page.");
    try {
      await revokeMcpConnection(body.grant_id, user.userId);
      return response.status(303).header("location", "/mcp?revoked=1").send("Revoked.");
    } catch (error: any) {
      return response.status(404).type("text/plain").send(error?.description || "Unknown connection.");
    }
  }

  @Delete("mcp")
  mcpDelete(@Res() response: any) {
    assertEnabled();
    return response.status(405).header("allow", "POST").json({ error: "method_not_allowed" });
  }
}

