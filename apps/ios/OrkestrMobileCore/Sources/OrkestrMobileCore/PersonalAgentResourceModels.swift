import Foundation

public enum ProvisioningState: String, Codable, CaseIterable, Sendable {
    case pending, provisioning, ready, needsConnection = "needs_connection", needsApproval = "needs_approval", failed
}

public enum BlockerCode: String, Codable, CaseIterable, Sendable {
    case connectionMissing = "connection_missing"
    case connectionUnhealthy = "connection_unhealthy"
    case approvalRequired = "approval_required"
    case providerUnsupportedOperation = "provider_unsupported_operation"
    case quotaExceeded = "quota_exceeded"
    case permissionDenied = "permission_denied"
    case localServiceUnavailable = "local_service_unavailable"
    case reconcileConflict = "reconcile_conflict"
    case unknown
}

public enum HealthState: String, Codable, CaseIterable, Sendable { case unknown, healthy, degraded, unhealthy }
public enum ResourceKind: String, Codable, CaseIterable, Sendable {
    case localGit = "local_git", oxrmWorkspace = "oxrm_workspace", files, desktopPool = "desktop_pool"
    case githubRepo = "github_repo", jiraProject = "jira_project", whatsappConversation = "whatsapp_conversation", pluginResource = "plugin_resource"
}
public enum ResourceSource: String, Codable, Sendable { case localBaseline = "local_baseline", plugin }
public enum ResourceSharing: String, Codable, Sendable { case project, sharedSelected = "shared_selected", poolLease = "pool_lease" }
public enum PluginState: String, Codable, Sendable { case installed, disabled, updateAvailable = "update_available", failed }
public enum AccountMultiplicity: String, Codable, Sendable { case single, multiple }
public enum PluginAuthMode: String, Codable, Sendable { case oauth, pairing, apiKey = "api_key", managed }
public enum PluginIsolation: String, Codable, Sendable {
    case firstPartyInProcess = "first_party_in_process", sandboxed, hostPrivileged = "host_privileged"
}
public enum ConnectionState: String, Codable, Sendable { case configured, needsAuth = "needs_auth", revoked }
public enum CapabilityRisk: String, Codable, Sendable { case read, write, externalEffect = "external_effect", spend }
public enum InstanceBindingScope: String, Codable, Sendable { case global, selectedProjects = "selected_projects" }
public enum ProjectBindingSource: String, Codable, Sendable { case inherited, project }

public struct ResourceBlockerRemedy: Codable, Equatable, Sendable {
    public let action: String
    public let hint: String
}

public struct ResourceBlocker: Codable, Equatable, Sendable {
    public let code: BlockerCode
    public let message: String
    public let remedy: ResourceBlockerRemedy
}

public struct ResourceHealth: Codable, Equatable, Sendable {
    public let state: HealthState
    public let checkedAt: String?
}

public struct DesktopResourceLease: Codable, Equatable, Sendable {
    public let held: Bool
    public let runId: String?
    public let expiresAt: String?
}

public struct ResourceBinding: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let projectId: String
    public let kind: ResourceKind
    public let source: ResourceSource
    public let pluginId: String?
    public let connectionId: String?
    public let logicalId: String
    public let externalId: String?
    public let state: ProvisioningState
    public let blocker: ResourceBlocker?
    public let health: ResourceHealth
    public let permissions: [String]
    public let sharing: ResourceSharing
    public let lease: DesktopResourceLease?
    public let updatedAt: String?
    public let verifiedAt: String?
}

public struct PluginPackage: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let version: String
    public let firstParty: Bool
    public let state: PluginState
    public let accountMultiplicity: AccountMultiplicity
    public let authModes: [PluginAuthMode]
    public let isolation: PluginIsolation
    public let capabilities: [String]
}

public struct Connection: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let pluginId: String
    public let label: String
    public let state: ConnectionState
    public let health: ResourceHealth
    public let scopes: [String]
    public let hasCredential: Bool
}

public struct Capability: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let pluginId: String
    public let risk: CapabilityRisk
    public let requiresApproval: Bool
}

public struct InstanceBinding: Codable, Equatable, Sendable {
    public let pluginId: String
    public let scope: InstanceBindingScope
    public let projectIds: [String]
    public let connectionIds: [String]
    public let capabilities: [String]
}

public struct ProjectPluginBinding: Codable, Equatable, Sendable {
    public let projectId: String
    public let pluginId: String
    public let enabled: Bool
    public let source: ProjectBindingSource
    public let connectionId: String?
    public let effectiveCapabilities: [String]
    public let narrowedFrom: NarrowedCapabilities?
}

public struct NarrowedCapabilities: Codable, Equatable, Sendable {
    public let capabilities: [String]
}
