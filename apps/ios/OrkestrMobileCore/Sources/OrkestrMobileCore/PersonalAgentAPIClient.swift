import Foundation

public protocol PersonalAgentTransport: Sendable {
    func send(_ request: PersonalAgentHTTPRequest) async throws -> Data
}

public struct PersonalAgentHTTPRequest: Sendable, Equatable {
    public let path: String
    public let method: String
    public let queryItems: [URLQueryItem]
    public let body: Data?
    public init(path: String, method: String = "GET", queryItems: [URLQueryItem] = [], body: Data? = nil) {
        self.path = path
        self.method = method
        self.queryItems = queryItems
        self.body = body
    }
}

public enum PersonalAgentAPIError: Error, Equatable {
    case invalidServerURL
    case invalidIdentifier
    case httpStatus(Int)
    case invalidResponse
}

public struct URLSessionPersonalAgentTransport: PersonalAgentTransport {
    private let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL, session: URLSession) throws {
        guard let scheme = baseURL.scheme?.lowercased(), baseURL.host != nil,
              baseURL.user == nil, baseURL.password == nil, baseURL.query == nil, baseURL.fragment == nil else {
            throw PersonalAgentAPIError.invalidServerURL
        }
        let host = baseURL.host?.lowercased() ?? ""
        let loopback = ["localhost", "127.0.0.1", "::1"].contains(host)
        guard scheme == "https" || (scheme == "http" && loopback) else {
            throw PersonalAgentAPIError.invalidServerURL
        }
        self.baseURL = baseURL
        self.session = session
    }

    public func send(_ request: PersonalAgentHTTPRequest) async throws -> Data {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        let prefix = baseURL.path.hasSuffix("/") ? String(baseURL.path.dropLast()) : baseURL.path
        components?.path = prefix + request.path
        components?.queryItems = request.queryItems.isEmpty ? nil : request.queryItems
        guard let url = components?.url else { throw PersonalAgentAPIError.invalidServerURL }
        var outgoing = URLRequest(url: url)
        outgoing.httpMethod = request.method
        outgoing.httpBody = request.body
        outgoing.setValue("application/json", forHTTPHeaderField: "Accept")
        if outgoing.httpBody != nil { outgoing.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await session.data(for: outgoing)
        guard let http = response as? HTTPURLResponse else { throw PersonalAgentAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw PersonalAgentAPIError.httpStatus(http.statusCode) }
        return data
    }
}

/// Contract client for ADR 0002 authenticated owner routes. The caller supplies
/// its authenticated transport; this type never owns or persists credentials.
public struct PersonalAgentAPIClient: Sendable {
    private let transport: any PersonalAgentTransport

    public init(transport: any PersonalAgentTransport) { self.transport = transport }

    public func capability() async throws -> PersonalAgentCapability {
        try await get("/api/personal-agent/capability")
    }

    public func acceptMessage(_ body: AcceptPersonalAgentMessageRequest) async throws -> PersonalAgentMessageReceipt {
        try await post("/api/personal-agent/messages", body: body)
    }

    public func projects(cursor: String? = nil, limit: Int = 50) async throws -> PersonalAgentProjectPage {
        var queryItems = [URLQueryItem(name: "limit", value: String(min(max(limit, 1), 100)))]
        if let cursor { queryItems.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await get("/api/personal-agent/projects", queryItems: queryItems)
    }

    public func createProject(_ body: CreateProjectRequest) async throws -> PersonalAgentProjectMutation {
        try await post("/api/personal-agent/projects", body: body)
    }

    public func project(id: String) async throws -> PersonalAgentProject {
        try await get("/api/personal-agent/projects/\(try Self.pathIdentifier(id))")
    }

    public func createTask(projectId: String, body: CreateTaskRequest) async throws -> PersonalAgentTaskMutation {
        try await post("/api/personal-agent/projects/\(try Self.pathIdentifier(projectId))/tasks", body: body)
    }

    public func task(id: String) async throws -> PersonalAgentTask {
        try await get("/api/personal-agent/tasks/\(try Self.pathIdentifier(id))")
    }

    public func transitionTask(id: String, body: TaskTransitionRequest) async throws -> PersonalAgentTask {
        try await post("/api/personal-agent/tasks/\(try Self.pathIdentifier(id))/transitions", body: body)
    }

    private func get<T: Decodable>(_ path: String, queryItems: [URLQueryItem] = []) async throws -> T {
        let data = try await transport.send(PersonalAgentHTTPRequest(path: path, queryItems: queryItems))
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func post<B: Encodable, T: Decodable>(_ path: String, body: B) async throws -> T {
        let request = PersonalAgentHTTPRequest(path: path, method: "POST", body: try JSONEncoder().encode(body))
        let data = try await transport.send(request)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private static func pathIdentifier(_ value: String) throws -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        guard !value.isEmpty, value.unicodeScalars.allSatisfy(allowed.contains) else { throw PersonalAgentAPIError.invalidIdentifier }
        return value
    }
}
