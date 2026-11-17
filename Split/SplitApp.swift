import SwiftUI
import ClerkKit
@main struct SplitApp: App {
    @StateObject private var session = SessionStore()
    @StateObject private var store = ExpenseStore()
    @Environment(\.scenePhase) private var phase
    init() { Clerk.configure(publishableKey: "pk_live_Y2xlcmsueW9pbmtsYWJzLmRldiQ") }
    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(session).environmentObject(store)
                .tint(Palette.green)
                .task { await session.restore() }
                .task(id: session.userID) { await store.activate(userID: session.userID, demo: session.isDemo) }
                .onOpenURL { store.receive($0) }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { if let url = $0.webpageURL { store.receive(url) } }
                .onChange(of: phase) { _, new in if new == .active { Task { await store.sync() } } }
        }
    }
}
