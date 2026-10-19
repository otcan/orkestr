import SwiftUI
import OrkestrMobileCore

struct AppRootView: View {
    let apiClient: PersonalAgentAPIClient?
    @State private var readiness: ServerReadiness = .offline
    @State private var lastEnabledCapabilityAt: Date?
    @State private var featureFlags: PersonalAgentFeatureFlags?

    init(apiClient: PersonalAgentAPIClient? = nil) { self.apiClient = apiClient }

    var body: some View {
        Group {
            if !readiness.featureVisible {
                ServerReadinessView(state: readiness, onRetry: loadCapability).padding(16)
            } else {
                TabView {
                    NavigationStack { AssistantView(readiness: readiness, client: apiClient, onRetry: loadCapability) }
                        .tabItem { Label("Assistant", systemImage: "bubble.left.and.bubble.right") }
                    NavigationStack { ProjectsListView(client: apiClient, featureFlags: featureFlags) }
                        .tabItem { Label("Projects", systemImage: "square.grid.2x2") }
                    NavigationStack { ApprovalsAttentionView() }
                        .tabItem { Label("Attention", systemImage: "checkmark.shield") }
                    NavigationStack { HistoryMemorySettingsView(featureFlags: featureFlags) }
                        .tabItem { Label("More", systemImage: "clock.arrow.circlepath") }
                }
                .tint(OrkestrTheme.accent)
                .preferredColorScheme(.dark)
            }
        }
        .task { await loadCapability() }
    }

    @MainActor private func loadCapability() async {
        guard let apiClient else { return }
        readiness = .loading
        do {
            let result = try await apiClient.capability()
            featureFlags = result.features
            if !result.enabled {
                lastEnabledCapabilityAt = nil
                readiness = .disabled(result.reason ?? "The Personal Agent feature flag is off.")
            } else {
                lastEnabledCapabilityAt = Date()
                if !result.capability {
                    readiness = .storageUnavailable
                } else {
                    readiness = .ready
                }
            }
        } catch {
            featureFlags = nil
            if let lastEnabledCapabilityAt {
                readiness = .stale(lastEnabledCapabilityAt)
            } else {
                readiness = .offline
            }
        }
    }
}
