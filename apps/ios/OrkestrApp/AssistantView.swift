import SwiftUI
import OrkestrMobileCore

struct AssistantView: View {
    let readiness: ServerReadiness
    let client: PersonalAgentAPIClient?
    let onRetry: (() async -> Void)?
    @State private var draft = ""
    @State private var isSubmitting = false
    @State private var pendingIdempotencyKey: String?
    @State private var sendStatus: String?

    init(readiness: ServerReadiness, client: PersonalAgentAPIClient? = nil, onRetry: (() async -> Void)? = nil) {
        self.readiness = readiness
        self.client = client
        self.onRetry = onRetry
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ServerReadinessView(state: readiness, onRetry: onRetry)
                AgentPanel(title: "Global conversation") {
                    UnavailableNote(message: "Connect an authenticated Orkestr server to load conversation history.")
                    UnavailableNote(message: "Session status unavailable; fast/deep selection is not connected yet.")
                    TextField("Message the assistant", text: $draft, axis: .vertical)
                        .lineLimit(2...5)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel("Message the global assistant")
                    HStack {
                        if let sendStatus { Text(sendStatus).font(.caption).foregroundStyle(OrkestrTheme.muted) }
                        Spacer()
                        Button {
                            Task { await submitMessage() }
                        } label: {
                            if isSubmitting { ProgressView() } else { Label("Send", systemImage: "arrow.up.circle.fill") }
                        }
                        .disabled(!canSubmit || isSubmitting)
                        .accessibilityHint("Queues your message for the configured assistant runtime")
                    }
                    if client == nil {
                        UnavailableNote(message: "An authenticated server session is required before sending.")
                    }
                }
                AgentPanel(title: "Grounded briefing") {
                    UnavailableNote(message: "Briefing will use attributed server data only; no summary is available offline.")
                }
                AgentPanel(title: "Active work") {
                    UnavailableNote(message: "Work status is not loaded. Connect to the authenticated server to refresh.")
                }
                AgentPanel(title: "Needs attention") {
                    UnavailableNote(message: "Approval and blocker status is not loaded.")
                }
                AgentPanel(title: "Recent results") {
                    UnavailableNote(message: "Recent verified results are not loaded.")
                }
            }
            .padding(16)
        }
        .background(OrkestrTheme.background.ignoresSafeArea())
        .navigationTitle("Assistant")
    }

    private var canSubmit: Bool { client != nil && readiness.canAcceptMessages && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    @MainActor private func submitMessage() async {
        guard canSubmit, let client else { return }
        let message = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        isSubmitting = true
        defer { isSubmitting = false }
        if pendingIdempotencyKey == nil { pendingIdempotencyKey = UUID().uuidString.lowercased() }
        do {
            let receipt = try await client.acceptMessage(.init(message: message, idempotencyKey: pendingIdempotencyKey))
            sendStatus = receipt.accepted ? "Accepted for processing. Replies are not yet available in this app." : "Message was not accepted."
            if receipt.accepted {
                draft = ""
                pendingIdempotencyKey = nil
            }
        } catch {
            sendStatus = "Send failed. Retry keeps the same request key to avoid creating a duplicate."
        }
    }
}
