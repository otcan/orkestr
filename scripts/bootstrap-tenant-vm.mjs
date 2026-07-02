#!/usr/bin/env node
import { bootstrapTenantVmFromProfile } from "../packages/core/src/tenant-vm-bootstrap.js";

function publicResult(result = {}) {
  return {
    ok: result.ok === true,
    skipped: result.skipped || "",
    profilePath: result.profilePath || "",
    tenantVmId: result.tenantVmId || "",
    threadId: result.thread?.id || "",
    whatsappChatId: result.thread?.binding?.chatId || "",
    codexStart: result.codexStart || null,
  };
}

try {
  const result = await bootstrapTenantVmFromProfile(null, process.env);
  console.log(JSON.stringify(publicResult(result), null, 2));
} catch (error) {
  console.error(error?.message || String(error));
  process.exit(1);
}
