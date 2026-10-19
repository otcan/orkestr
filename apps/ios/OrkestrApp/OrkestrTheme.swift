import SwiftUI

enum OrkestrTheme {
    // Values mirror apps/web/src/app-interface.css design tokens.
    static let background = Color(red: 17 / 255, green: 23 / 255, blue: 25 / 255)
    static let surface = Color(red: 29 / 255, green: 39 / 255, blue: 40 / 255)
    static let raised = Color(red: 38 / 255, green: 49 / 255, blue: 51 / 255)
    static let text = Color(red: 237 / 255, green: 242 / 255, blue: 239 / 255)
    static let muted = Color(red: 175 / 255, green: 191 / 255, blue: 186 / 255)
    static let accent = Color(red: 142 / 255, green: 216 / 255, blue: 194 / 255)
    static let border = Color(red: 61 / 255, green: 74 / 255, blue: 75 / 255)
    static let focus = Color(red: 245 / 255, green: 209 / 255, blue: 138 / 255)
}

struct AgentPanel<Content: View>: View {
    let title: String
    let content: Content

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline).foregroundStyle(OrkestrTheme.text)
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(OrkestrTheme.surface, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(OrkestrTheme.border, lineWidth: 1))
    }
}

struct UnavailableNote: View {
    let message: String
    var body: some View {
        Label(message, systemImage: "exclamationmark.circle")
            .font(.subheadline)
            .foregroundStyle(OrkestrTheme.muted)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .combine)
    }
}
