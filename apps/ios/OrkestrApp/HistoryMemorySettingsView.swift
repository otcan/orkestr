import SwiftUI
import OrkestrMobileCore

struct HistoryMemorySettingsView: View {
    let featureFlags: PersonalAgentFeatureFlags?

    init(featureFlags: PersonalAgentFeatureFlags? = nil) { self.featureFlags = featureFlags }

    var body: some View {
        List {
            NavigationLink("History") { PlaceholderLibraryView(title: "History", detail: "History loads from owner-authorized server records.") }
            NavigationLink("Memory") { PlaceholderLibraryView(title: "Memory", detail: "Only explicitly consented memory is eligible for display or retrieval.") }
            NavigationLink("Integration Hub") { IntegrationHubPlaceholderView(featureAvailable: featureFlags?.integrationHub == true) }
            NavigationLink("Settings") { PlaceholderLibraryView(title: "Settings", detail: "App and server settings are not configured in this skeleton.") }
        }
        .scrollContentBackground(.hidden)
        .background(OrkestrTheme.background)
        .navigationTitle("History, Memory & Settings")
    }
}

private struct IntegrationHubPlaceholderView: View {
    let featureAvailable: Bool
    private let layers = ["Plugin packages", "Connections", "Capabilities", "Global and project bindings", "Resource instances"]

    var body: some View {
        List {
            Section {
                UnavailableNote(message: featureAvailable
                    ? "Integration Hub is advertised, but this app is not connected to its read endpoints yet."
                    : "Integration Hub not available yet. This server has not advertised integrationHub.")
                Text("This view does not connect, enable, provision, or infer integrations or provider health.")
                    .font(.caption)
                    .foregroundStyle(OrkestrTheme.muted)
                    .listRowBackground(OrkestrTheme.surface)
            }
            Section("Integration layers") {
                ForEach(layers, id: \.self) { layer in
                    Text(layer)
                        .foregroundStyle(OrkestrTheme.muted)
                        .listRowBackground(OrkestrTheme.surface)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(OrkestrTheme.background)
        .navigationTitle("Integration Hub")
    }
}

private struct PlaceholderLibraryView: View {
    let title: String
    let detail: String
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            AgentPanel(title: title) { UnavailableNote(message: detail) }
            Spacer()
        }
        .padding(16)
        .background(OrkestrTheme.background)
        .navigationTitle(title)
    }
}
