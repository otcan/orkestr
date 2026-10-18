import Foundation

public struct AssistantCapability: Codable, Equatable, Sendable {
    public let available: Bool
    public let reason: String?
    public let model: String?
    public let checkedAt: String?

    public init(available: Bool, reason: String? = nil, model: String? = nil, checkedAt: String? = nil) {
        self.available = available
        self.reason = reason
        self.model = model
        self.checkedAt = checkedAt
    }
}

public struct PersonalAgentCapability: Codable, Equatable, Sendable {
    public let enabled: Bool
    public let capability: Bool
    public let reason: String?
    public let assistant: AssistantCapability
    public let features: PersonalAgentFeatureFlags?

    public init(enabled: Bool, capability: Bool, reason: String? = nil, assistant: AssistantCapability, features: PersonalAgentFeatureFlags? = nil) {
        self.enabled = enabled
        self.capability = capability
        self.reason = reason
        self.assistant = assistant
        self.features = features
    }
}

/// Optional capability discovery flags. Missing flags are intentionally treated as unavailable.
public struct PersonalAgentFeatureFlags: Codable, Equatable, Sendable {
    public let projectResources: Bool?
    public let integrationHub: Bool?
    public init(projectResources: Bool? = nil, integrationHub: Bool? = nil) {
        self.projectResources = projectResources
        self.integrationHub = integrationHub
    }
}

public struct PersonalAgentProject: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let goal: String?
    public let state: String
    public let createdAt: String?
    public let updatedAt: String?

    public init(id: String, title: String, goal: String? = nil, state: String, createdAt: String? = nil, updatedAt: String? = nil) {
        self.id = id
        self.title = title
        self.goal = goal
        self.state = state
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct PersonalAgentProjectPage: Codable, Equatable, Sendable {
    public let projects: [PersonalAgentProject]
    public let nextCursor: String?

    public init(projects: [PersonalAgentProject], nextCursor: String? = nil) {
        self.projects = projects
        self.nextCursor = nextCursor
    }
}

public struct PersonalAgentProjectMutation: Codable, Equatable, Sendable {
    public let project: PersonalAgentProject
    public let created: Bool?
    public let replayed: Bool?
}

public struct AcceptanceCriterion: Codable, Equatable, Sendable {
    public let id: String
    public let description: String
    public init(id: String, description: String) { self.id = id; self.description = description }

    public init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer(), let text = try? single.decode(String.self) {
            id = ""
            description = text
            return
        }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decodeIfPresent(String.self, forKey: .id) ?? ""
        description = try values.decode(String.self, forKey: .description)
    }
    private enum CodingKeys: String, CodingKey { case id, description }
}

public struct PersonalAgentTask: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let projectId: String
    public let title: String
    public let outcome: String
    public let acceptanceCriteria: [AcceptanceCriterion]
    public let state: String
    public let threadId: String?
    public let runId: String?
    public let createdAt: String?
    public let updatedAt: String?

    public init(id: String, projectId: String, title: String, outcome: String, acceptanceCriteria: [AcceptanceCriterion], state: String,
                threadId: String? = nil, runId: String? = nil, createdAt: String? = nil, updatedAt: String? = nil) {
        self.id = id
        self.projectId = projectId
        self.title = title
        self.outcome = outcome
        self.acceptanceCriteria = acceptanceCriteria
        self.state = state
        self.threadId = threadId
        self.runId = runId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct PersonalAgentTaskPage: Codable, Equatable, Sendable {
    public let tasks: [PersonalAgentTask]
    public let nextCursor: String?

    public init(tasks: [PersonalAgentTask], nextCursor: String? = nil) {
        self.tasks = tasks
        self.nextCursor = nextCursor
    }
}

public struct PersonalAgentTaskMutation: Codable, Equatable, Sendable {
    public let task: PersonalAgentTask
    public let created: Bool?
    public let replayed: Bool?
}

public struct CreateProjectRequest: Codable, Equatable, Sendable {
    public let title: String
    public let goal: String?
    public let idempotencyKey: String
    public init(title: String, goal: String? = nil, idempotencyKey: String) {
        self.title = title
        self.goal = goal
        self.idempotencyKey = idempotencyKey
    }
}

public struct CreateTaskRequest: Codable, Equatable, Sendable {
    public let title: String
    public let outcome: String
    public let acceptanceCriteria: [String]
    public let idempotencyKey: String
    public let threadId: String?
    public init(title: String, outcome: String, acceptanceCriteria: [String], idempotencyKey: String, threadId: String? = nil) {
        self.title = title
        self.outcome = outcome
        self.acceptanceCriteria = acceptanceCriteria
        self.idempotencyKey = idempotencyKey
        self.threadId = threadId
    }
}

public struct TaskTransitionRequest: Codable, Equatable, Sendable {
    public let to: String
    public let reason: String?
    public let evidenceRefs: [String]?
    public let idempotencyKey: String
    public init(to: String, reason: String? = nil, evidenceRefs: [String]? = nil, idempotencyKey: String) {
        self.to = to
        self.reason = reason
        self.evidenceRefs = evidenceRefs
        self.idempotencyKey = idempotencyKey
    }
}

public struct PersonalAgentMessageScope: Codable, Equatable, Sendable {
    public let kind: String
    public let projectId: String?
    public init(kind: String, projectId: String? = nil) {
        self.kind = kind
        self.projectId = projectId
    }

    public static let global = PersonalAgentMessageScope(kind: "global")
    public static func project(_ id: String) -> PersonalAgentMessageScope {
        PersonalAgentMessageScope(kind: "project", projectId: id)
    }
}

public struct PersonalAgentControlFlags: Codable, Equatable, Sendable {
    public let cancel: Bool
    public let hold: Bool
    public let pause: Bool
    public init(cancel: Bool = false, hold: Bool = false, pause: Bool = false) {
        self.cancel = cancel
        self.hold = hold
        self.pause = pause
    }
}

/// ORK-561 durable owner ingress. The server derives actor and channel identity;
/// clients must not send either field.
public struct AcceptPersonalAgentMessageRequest: Codable, Equatable, Sendable {
    public let scope: PersonalAgentMessageScope
    public let message: String
    public let idempotencyKey: String?
    public let priority: String
    public let controlFlags: PersonalAgentControlFlags
    public let taskId: String?
    public let runId: String?

    public init(scope: PersonalAgentMessageScope = .global, message: String, idempotencyKey: String? = nil,
                priority: String = "normal", controlFlags: PersonalAgentControlFlags = .init(),
                taskId: String? = nil, runId: String? = nil) {
        self.scope = scope
        self.message = message
        self.idempotencyKey = idempotencyKey
        self.priority = priority
        self.controlFlags = controlFlags
        self.taskId = taskId
        self.runId = runId
    }
}

public struct PersonalAgentMessageReceipt: Codable, Equatable, Sendable {
    public let accepted: Bool
    public let replayed: Bool
    public let conversationId: String
    public let messageId: String
    public let eventId: String
    public let cursor: String
    public let inboxItemId: String
    public let causalSequence: Int
    public let taskId: String?
    public let runId: String?
}
