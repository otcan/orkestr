import {
  readBrokerInstanceRegistry,
  resolveBrokerConnectInstance,
} from "../../../packages/core/src/broker-instance-registry.js";
import { parseInstancePublicRef } from "../../../packages/core/src/canonical-public-references.js";
import { listReleaseInstances } from "../../../packages/core/src/release-instances.js";

export type InstanceAccount = {
  publicRef: string;
  displayName: string;
  canonicalPath: string;
};

type Dependencies = {
  readRegistry?: typeof readBrokerInstanceRegistry;
  listReleases?: typeof listReleaseInstances;
  resolveBroker?: typeof resolveBrokerConnectInstance;
};

function clean(value: unknown): string {
  return String(value || "").trim();
}

function enabled(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

function normalizedBaseUrl(value: unknown): string {
  const raw = clean(value).replace(/\/+$/, "");
  if (!raw) return "";
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return raw;
  }
}

function configuredInstanceIds(env = process.env): Set<string> {
  return new Set(clean(env.ORKESTR_ACCOUNT_SWITCHER_INSTANCE_IDS).split(",").map(clean).filter(Boolean));
}

function releaseInstanceBrokerIds(instance: any): string[] {
  const labels = instance?.labels || {};
  return [labels.brokerInstanceId, labels.instanceId].map(clean).filter(Boolean);
}

function normalizedInstanceName(value: unknown): string {
  return clean(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .replace(/^vm/, "")
    .replace(/vm$/, "");
}

function releaseInstanceNames(instance: any): Set<string> {
  return new Set([
    instance?.displayName,
    instance?.id,
    instance?.sourceId,
    instance?.labels?.tenantSliceId,
  ].map(normalizedInstanceName).filter(Boolean));
}

function brokerRecordTime(record: any): number {
  for (const value of [record?.lastHeartbeatAt, record?.lastSeenAt, record?.updatedAt, record?.createdAt]) {
    const parsed = Date.parse(clean(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function usableReleaseInstance(instance: any): boolean {
  const status = clean(instance?.status).toLowerCase();
  return clean(instance?.kind).toLowerCase() !== "local-service" &&
    instance?.enabled !== false && instance?.releaseTrainEnabled === true &&
    !["disabled", "deleted", "stopped", "unreachable", "failed"].includes(status);
}

export function instanceAccountSwitcherEnabled(env = process.env): boolean {
  return enabled(env.ORKESTR_ACCOUNT_SWITCHER_ENABLED);
}

export async function listInstanceAccounts(
  env = process.env,
  dependencies: Dependencies = {},
): Promise<Array<InstanceAccount & { internalInstanceId: string }>> {
  if (!instanceAccountSwitcherEnabled(env)) return [];
  const readRegistry = dependencies.readRegistry || readBrokerInstanceRegistry;
  const listReleases = dependencies.listReleases || listReleaseInstances;
  const resolveBroker = dependencies.resolveBroker || resolveBrokerConnectInstance;
  const [registry, releases] = await Promise.all([
    readRegistry(env).catch(() => ({ instances: [] })),
    listReleases(env, { probe: false }).catch(() => []),
  ]);
  const explicitIds = configuredInstanceIds(env);
  const records = (Array.isArray(registry?.instances) ? registry.instances : [])
    .filter((record: any) => clean(record?.instanceId) && clean(record?.publicRef));
  const releaseRows = (Array.isArray(releases) ? releases : []).filter(usableReleaseInstance);
  const selected: Array<{ record: any; displayName: string }> = [];
  if (explicitIds.size) {
    for (const record of records) {
      if (explicitIds.has(clean(record?.instanceId))) {
        selected.push({ record, displayName: clean(record?.displayName) });
      }
    }
  } else {
    for (const release of releaseRows) {
      const brokerIds = releaseInstanceBrokerIds(release);
      let candidates = brokerIds.length
        ? records.filter((record: any) => brokerIds.includes(clean(record?.instanceId)))
        : [];
      if (!candidates.length && !brokerIds.length) {
        const baseUrl = normalizedBaseUrl(release?.baseUrl);
        const names = releaseInstanceNames(release);
        candidates = records.filter((record: any) =>
          baseUrl && normalizedBaseUrl(record?.endpointBaseUrl) === baseUrl &&
          names.has(normalizedInstanceName(record?.displayName)),
        );
      }
      candidates.sort((left: any, right: any) => brokerRecordTime(right) - brokerRecordTime(left));
      if (candidates[0]) selected.push({
        record: candidates[0],
        displayName: clean(release?.displayName) || clean(candidates[0]?.displayName),
      });
    }
  }
  const accounts: Array<InstanceAccount & { internalInstanceId: string }> = [];
  const seen = new Set<string>();
  for (const selection of selected) {
    const record = selection.record;
    const instanceId = clean(record?.instanceId);
    const publicRef = clean(record?.publicRef);
    if (!instanceId || !publicRef || seen.has(instanceId)) continue;
    try {
      parseInstancePublicRef(publicRef);
      if (!(await resolveBroker(instanceId, env))) continue;
    } catch {
      continue;
    }
    accounts.push({
      internalInstanceId: instanceId,
      publicRef,
      displayName: selection.displayName || clean(record?.displayName) || publicRef,
      canonicalPath: `/instance/${encodeURIComponent(publicRef)}/`,
    });
    seen.add(instanceId);
  }
  return accounts.sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export async function instanceAccountByPublicRef(
  publicRef: string,
  env = process.env,
  dependencies: Dependencies = {},
): Promise<(InstanceAccount & { internalInstanceId: string }) | null> {
  let exact = "";
  try { exact = parseInstancePublicRef(clean(publicRef)); } catch { return null; }
  return (await listInstanceAccounts(env, dependencies)).find((account) => account.publicRef === exact) || null;
}

export function publicInstanceAccount(account: InstanceAccount & { internalInstanceId?: string }): InstanceAccount {
  return {
    publicRef: account.publicRef,
    displayName: account.displayName,
    canonicalPath: account.canonicalPath,
  };
}
