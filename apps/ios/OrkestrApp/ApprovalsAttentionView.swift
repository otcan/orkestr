import SwiftUI

struct ApprovalsAttentionView: View {
    var body: some View {
        List {
            Section("Approvals") {
                UnavailableNote(message: "Pending approvals are not loaded. Decisions remain server-authorized and are never inferred from this screen.")
            }
            Section("Needs attention") {
                UnavailableNote(message: "Blocked tasks and provider status are not loaded.")
            }
        }
        .scrollContentBackground(.hidden)
        .background(OrkestrTheme.background)
        .navigationTitle("Approvals & Attention")
    }
}
