import Foundation
import XCTest
@testable import OrkestrMobileCore

private actor FixtureTransport: PersonalAgentTransport {
    private(set) var requests: [PersonalAgentHTTPRequest] = []
    private let response: Data
    init(json: String) { response = Data(json.utf8) }
    func send(_ request: PersonalAgentHTTPRequest) async throws -> Data {
        requests.append(request)
        return response
    }
    func recordedRequests() -> [PersonalAgentHTTPRequest] { requests }
}

final class PersonalAgentAPIClientTests: XCTestCase {
    func testCapabilityFeatureFlagsAreOptionalAndRequireExplicitTrue() throws {
        let missing = try JSONDecoder().decode(PersonalAgentCapability.self, from: Data(#"{"enabled":true,"capability":true,"assistant":{"available":false,"reason":"not_configured"}}"#.utf8))
        XCTAssertNil(missing.features?.projectResources)
        XCTAssertNil(missing.features?.integrationHub)

        let advertised = try JSONDecoder().decode(PersonalAgentCapability.self, from: Data(#"{"enabled":true,"capability":true,"assistant":{"available":false,"reason":"not_configured"},"features":{"projectResources":true,"integrationHub":false}}"#.utf8))
        XCTAssertEqual(advertised.features?.projectResources, true)
        XCTAssertEqual(advertised.features?.integrationHub, false)
    }

    func testFrozenResourceAndPluginEnumsDecodeExactWireValues() throws {
        XCTAssertEqual(try JSONDecoder().decode(ProvisioningState.self, from: Data(#""needs_approval""#.utf8)), .needsApproval)
        XCTAssertEqual(try JSONDecoder().decode(BlockerCode.self, from: Data(#""local_service_unavailable""#.utf8)), .localServiceUnavailable)
        XCTAssertEqual(try JSONDecoder().decode(HealthState.self, from: Data(#""degraded""#.utf8)), .degraded)
        XCTAssertEqual(try JSONDecoder().decode(ResourceKind.self, from: Data(#""whatsapp_conversation""#.utf8)), .whatsappConversation)
        XCTAssertEqual(try JSONDecoder().decode(PluginIsolation.self, from: Data(#""host_privileged""#.utf8)), .hostPrivileged)
    }

    func testTransportRejectsPlainHTTPOutsideLoopback() throws {
        XCTAssertThrowsError(try URLSessionPersonalAgentTransport(baseURL: URL(string: "http://server.example.test")!, session: .shared))
        XCTAssertNoThrow(try URLSessionPersonalAgentTransport(baseURL: URL(string: "https://server.example.test")!, session: .shared))
        XCTAssertNoThrow(try URLSessionPersonalAgentTransport(baseURL: URL(string: "http://localhost:3000")!, session: .shared))
    }

    func testCapabilityUsesAuthenticatedOwnerRouteAndDecodesDegradedAssistant() async throws {
        let transport = FixtureTransport(json: #"{"enabled":true,"capability":true,"assistant":{"available":false,"reason":"not_configured"}}"#)
        let client = PersonalAgentAPIClient(transport: transport)

        let capability = try await client.capability()
        XCTAssertTrue(capability.enabled)
        XCTAssertTrue(capability.capability)
        XCTAssertFalse(capability.assistant.available)
        XCTAssertEqual(capability.assistant.reason, "not_configured")
        let requests = await transport.recordedRequests()
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.path, "/api/personal-agent/capability")
        XCTAssertEqual(request.method, "GET")
    }

    func testProjectAndTaskRoutesUseADRPathsAndIdempotentRequestFields() async throws {
        let transport = FixtureTransport(json: #"{"project":{"id":"prj_test","title":"Synthetic","state":"active"},"created":true}"#)
        let client = PersonalAgentAPIClient(transport: transport)
        _ = try await client.createProject(CreateProjectRequest(title: "Synthetic", idempotencyKey: "fixture-key"))

        let requests = await transport.recordedRequests()
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.path, "/api/personal-agent/projects")
        XCTAssertEqual(request.method, "POST")
        let body = try XCTUnwrap(request.body)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(json["title"], "Synthetic")
        XCTAssertEqual(json["idempotencyKey"], "fixture-key")
        XCTAssertNil(json["password"])
    }

    func testOwnerIngressUsesGlobalScopeAndDoesNotSelectActorOrChannel() async throws {
        let transport = FixtureTransport(json: #"{"accepted":true,"replayed":false,"conversationId":"pac_test","messageId":"pam_test","eventId":"evt_test","cursor":"pa1.1","inboxItemId":"pai_test","causalSequence":1}"#)
        let client = PersonalAgentAPIClient(transport: transport)
        let receipt = try await client.acceptMessage(.init(message: "Synthetic request", idempotencyKey: "stable-test-key"))

        XCTAssertTrue(receipt.accepted)
        let requests = await transport.recordedRequests()
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.path, "/api/personal-agent/messages")
        let body = try XCTUnwrap(request.body)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual((json["scope"] as? [String: Any])?["kind"] as? String, "global")
        XCTAssertEqual(json["idempotencyKey"] as? String, "stable-test-key")
        XCTAssertNil(json["actor"])
        XCTAssertNil(json["channel"])
    }

    func testOwnerIngressOmitsOptionalIdempotencyKeyWhenUnavailable() async throws {
        let transport = FixtureTransport(json: #"{"accepted":true,"replayed":false,"conversationId":"pac_test","messageId":"pam_test","eventId":"evt_test","cursor":"pa1.1","inboxItemId":"pai_test","causalSequence":1}"#)
        let client = PersonalAgentAPIClient(transport: transport)
        _ = try await client.acceptMessage(.init(message: "Synthetic request"))
        let requests = await transport.recordedRequests()
        let request = try XCTUnwrap(requests.first)
        let body = try XCTUnwrap(request.body)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertNil(json["idempotencyKey"])
    }

    func testIdentifierCannotEscapeItsAPIPathSegment() async throws {
        let transport = FixtureTransport(json: #"{"id":"tsk_test","projectId":"prj_test","title":"Fixture","outcome":"Fixture","acceptanceCriteria":[],"state":"queued"}"#)
        let client = PersonalAgentAPIClient(transport: transport)
        do {
            _ = try await client.task(id: "../projects")
            XCTFail("expected an invalid identifier")
        } catch let error as PersonalAgentAPIError {
            XCTAssertEqual(error, .invalidIdentifier)
        }
        let requests = await transport.recordedRequests()
        XCTAssertTrue(requests.isEmpty)
    }
}
