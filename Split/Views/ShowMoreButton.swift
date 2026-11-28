import SwiftUI

/// Page size for long lists that grow on request instead of rendering everything.
enum BoundedList {
    static let page = 50
}

/// "Show more" under a bounded list. Hidden once every row is visible.
struct ShowMoreButton: View {
    var shown: Int
    var total: Int
    var action: () -> Void

    var body: some View {
        if shown < total {
            Button(action: action) {
                Label("Show \(Swift.min(BoundedList.page, total - shown)) more of \(total - shown)", systemImage: "chevron.down")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(GhostButton())
            .accessibilityHint("\(shown) of \(total) shown")
        }
    }
}
