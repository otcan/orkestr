import SwiftUI

enum ServerReadiness {
    case loading
    case offline
    case stale(Date)
    case disabled(String)
    case storageUnavailable
    case ready

    var title: String {
        switch self {
        case .loading: return "Checking server"
        case .offline: return "Offline / not connected"
        case .stale: return "Showing stale data"
        case .disabled: return "Personal Agent disabled"
        case .storageUnavailable: return "Storage unavailable"
        case .ready: return "Connected"
        }
    }

    var featureVisible: Bool {
        switch self {
        case .storageUnavailable, .ready, .stale:
            return true
        case .loading, .offline, .disabled:
            return false
        }
    }

    var canAcceptMessages: Bool {
        switch self {
        case .ready: return true
        default: return false
        }
    }

    var detail: String {
        switch self {
        case .loading: return "Checking the authenticated server capability."
        case .offline: return "No authenticated server connection is configured. No live data is shown."
        case .stale(let date): return "Last verified update: \(date.formatted(date: .abbreviated, time: .shortened)). Refresh before relying on this information."
        case .disabled(let reason): return reason
        case .storageUnavailable: return "The Personal Agent storage prerequisites are unavailable. Work and memory are not assumed to be empty."
        case .ready: return "Owner-scoped server data is available."
        }
    }

    var symbol: String {
        switch self {
        case .loading: return "arrow.trianglehead.2.clockwise.rotate.90"
        case .offline, .storageUnavailable: return "wifi.slash"
        case .stale: return "clock.badge.exclamationmark"
        case .disabled: return "pause.circle"
        case .ready: return "checkmark.circle"
        }
    }
}

struct ServerReadinessView: View {
    let state: ServerReadiness
    var onRetry: (() async -> Void)? = nil

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 4) {
                Text(state.title).font(.subheadline.weight(.semibold))
                Text(state.detail).font(.caption).fixedSize(horizontal: false, vertical: true)
                if let onRetry {
                    Button("Retry connection") { Task { await onRetry() } }
                        .font(.caption.weight(.semibold))
                }
            }
        } icon: {
            Image(systemName: state.symbol).accessibilityHidden(true)
        }
        .foregroundStyle(OrkestrTheme.text)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(OrkestrTheme.raised, in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(state.title). \(state.detail)")
    }
}
