import { readJson } from "../../storage/src/store.js";

const clean = (value = "") => String(value || "").trim();

function meta(db, key, fallback = "") {
  const row = db.prepare("select value from orkestr_thread_resource_meta where key = ?").get(key);
  return row ? row.value : fallback;
}

function setMeta(db, key, value) {
  db.prepare("insert into orkestr_thread_resource_meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key, String(value));
}

// Legacy desktop grants are imported only when a fresh transactional store is
// first opened. Keeping the one-time bridge separate makes the policy store's
// steady-state transaction path independent of the retired JSON shape.
export async function migrateLegacyDesktopGrants(db, paths, existed) {
  if (meta(db, "legacy_desktop_migrated_at", "")) return;
  const count = Number(db.prepare("select count(*) as count from orkestr_thread_resource_grants").get().count || 0);
  if (existed && count > 0) { setMeta(db, "legacy_desktop_migrated_at", new Date().toISOString()); return; }
  const legacy = await readJson(paths.desktopAccess, {});
  if (!Array.isArray(legacy?.grants) || !legacy.grants.length) { setMeta(db, "legacy_desktop_migrated_at", new Date().toISOString()); return; }
  const now = new Date().toISOString();
  const resources = new Map((legacy.resources || []).map((item) => [item.id, item]));
  db.exec("begin immediate");
  try {
    const upsertResource = db.prepare("insert or ignore into orkestr_thread_resources(resource_type, resource_id, resource_key, owner_user_id, boundary_id, generation, backend, created_at, updated_at, retired_at) values ('desktop', ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertPolicy = db.prepare("insert or ignore into orkestr_thread_resource_policy(thread_id, resource_type, revision, explicit_empty, created_at, updated_at) values (?, 'desktop', ?, 0, ?, ?)");
    const insertGrant = db.prepare("insert or ignore into orkestr_thread_resource_grants(id, thread_id, resource_type, resource_id, resource_key, owner_user_id, boundary_id, permissions_json, revision, source, created_at, updated_at, revoked_at, revoked_by, reason) values (?, ?, 'desktop', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const legacyGrant of legacy.grants) {
      const resource = resources.get(legacyGrant.desktopId || legacyGrant.resourceId) || {};
      const resourceId = clean(legacyGrant.desktopId || legacyGrant.resourceId || resource.id);
      const resourceKey = clean(legacyGrant.desktopSlug || legacyGrant.slug || resource.slug);
      if (!resourceId || !resourceKey || !clean(legacyGrant.threadId)) continue;
      const owner = clean(legacyGrant.ownerUserId || resource.ownerUserId || "admin"); const boundary = clean(legacyGrant.boundaryId || resource.boundaryId || "local");
      upsertResource.run(resourceId, resourceKey, owner, boundary, Number(resource.generation || 1) || 1, resource.backend || "desktop", resource.createdAt || now, resource.updatedAt || now, resource.retiredAt || null);
      insertPolicy.run(legacyGrant.threadId, Number(legacy.revision || 1) || 1, now, now);
      insertGrant.run(clean(legacyGrant.id) || `${legacyGrant.threadId}:${resourceId}`, legacyGrant.threadId, resourceId, resourceKey, owner, boundary, JSON.stringify(legacyGrant.permissions || ["discover", "acquire", "operate", "share"]), Number(legacyGrant.revision || 1) || 1, legacyGrant.source || "legacy", legacyGrant.createdAt || now, legacyGrant.updatedAt || now, legacyGrant.revokedAt || null, legacyGrant.revokedBy || null, legacyGrant.reason || null);
    }
    setMeta(db, "revision", Number(legacy.revision || 0) || 0);
    setMeta(db, "updated_at", legacy.updatedAt || now);
    setMeta(db, "legacy_desktop_migrated_at", now);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback"); throw error;
  }
}
