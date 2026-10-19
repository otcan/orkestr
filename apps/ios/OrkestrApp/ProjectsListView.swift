import SwiftUI
import OrkestrMobileCore

struct ProjectsListView: View {
    let client: PersonalAgentAPIClient?
    let featureFlags: PersonalAgentFeatureFlags?
    @State private var projects: [PersonalAgentProject] = []
    @State private var loading = false
    @State private var loadFailed = false

    init(client: PersonalAgentAPIClient? = nil, featureFlags: PersonalAgentFeatureFlags? = nil) {
        self.client = client
        self.featureFlags = featureFlags
    }

    var body: some View {
        List {
            if loading {
                Section("Projects") {
                    ProgressView("Loading owner projects…").listRowBackground(OrkestrTheme.surface)
                }
            } else if loadFailed {
                Section("Projects") {
                    UnavailableNote(message: "Project list could not be loaded. Existing projects are not assumed to be absent.")
                        .listRowBackground(OrkestrTheme.surface)
                }
            } else if client == nil {
                Section {
                    UnavailableNote(message: "Project data requires an authenticated server connection. No sample projects are shown.")
                        .listRowBackground(OrkestrTheme.surface)
                } header: { Text("Projects") }
            } else if projects.isEmpty {
                Section("Projects") {
                    UnavailableNote(message: "No projects are returned for this owner.")
                        .listRowBackground(OrkestrTheme.surface)
                }
            } else {
                Section("Projects") {
                    ForEach(projects) { project in
                        NavigationLink {
                            ProjectDetailView(project: project, projectResourcesAvailable: featureFlags?.projectResources == true)
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(project.title).foregroundStyle(OrkestrTheme.text)
                                Text(project.state.capitalized).font(.caption).foregroundStyle(OrkestrTheme.muted)
                            }
                        }
                        .accessibilityHint("Opens this project's conversation and work panels")
                        .listRowBackground(OrkestrTheme.surface)
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(OrkestrTheme.background)
        .navigationTitle("Projects")
        .task { await loadProjects() }
    }

    @MainActor private func loadProjects() async {
        guard let client else { return }
        loading = true
        defer { loading = false }
        do {
            projects = try await client.projects().projects
            loadFailed = false
        } catch {
            loadFailed = true
        }
    }
}

struct ProjectDetailView: View {
    enum Panel: String, CaseIterable, Identifiable {
        case conversation = "Conversation"
        case tasks = "Tasks"
        case repository = "Repository"
        case data = "Data"
        case runs = "Runs"
        case activity = "Activity"
        case resources = "Provisioning"
        var id: String { rawValue }
    }

    let project: PersonalAgentProject
    var projectResourcesAvailable = false
    @State private var selectedPanel = Panel.conversation
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        VStack(spacing: 12) {
            Group {
                if horizontalSizeClass == .regular {
                    Picker("Project panel", selection: $selectedPanel) {
                        ForEach(Panel.allCases) { panel in Text(panel.rawValue).tag(panel) }
                    }
                    .pickerStyle(.segmented)
                } else {
                    Picker("Project panel", selection: $selectedPanel) {
                        ForEach(Panel.allCases) { panel in Text(panel.rawValue).tag(panel) }
                    }
                    .pickerStyle(.menu)
                }
            }
            .accessibilityLabel("Project sections")
            AgentPanel(title: selectedPanel.rawValue) {
                if selectedPanel == .resources {
                    ProjectResourcesPlaceholderView(featureAvailable: projectResourcesAvailable)
                } else {
                    UnavailableNote(message: "\(selectedPanel.rawValue) data for this project has not been loaded from the server.")
                }
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .background(OrkestrTheme.background)
        .navigationTitle(project.title)
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct ProjectResourcesPlaceholderView: View {
    let featureAvailable: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            UnavailableNote(message: featureAvailable
                ? "Project resource status is advertised, but this app is not connected to the read endpoint yet."
                : "Project resource status not available yet. This server has not advertised projectResources.")
            Text("Provisioning and health are separate contract fields; no project resource or state is inferred.")
                .font(.caption)
                .foregroundStyle(OrkestrTheme.muted)
        }
    }
}
