import SwiftUI

struct HistoryMemorySettingsView: View {
    var body: some View {
        List {
            NavigationLink("History") { PlaceholderLibraryView(title: "History", detail: "History loads from owner-authorized server records.") }
            NavigationLink("Memory") { PlaceholderLibraryView(title: "Memory", detail: "Only explicitly consented memory is eligible for display or retrieval.") }
            NavigationLink("Settings") { PlaceholderLibraryView(title: "Settings", detail: "App and server settings are not configured in this skeleton.") }
        }
        .scrollContentBackground(.hidden)
        .background(OrkestrTheme.background)
        .navigationTitle("History, Memory & Settings")
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
