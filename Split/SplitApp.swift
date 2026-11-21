import SwiftUI
import ClerkKit
@main struct SplitApp: App {
    @StateObject private var session = SessionStore()
    @StateObject private var store = ExpenseStore()
    @StateObject private var fx = FXStore()
    @AppStorage("split.appearance") private var appearance = "system"
    @Environment(\.scenePhase) private var phase
    init() {
        Clerk.configure(publishableKey: "pk_live_Y2xlcmsueW9pbmtsYWJzLmRldiQ")
        // Finish tips StoreKit delivers outside the purchase sheet (Ask to
        // Buy approvals, or a tip left unfinished by a previous launch).
        Task { @MainActor in TipJarStore.shared.startObservingTransactions() }
    }
    private var scheme: ColorScheme? {
        switch appearance { case "light": .light; case "dark": .dark; default: nil }
    }
    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(session).environmentObject(store).environmentObject(fx)
                .tint(Palette.evergreen)
                .preferredColorScheme(scheme)
                .task { await session.restore() }
                .task(id: session.userID) { await store.activate(userID: session.userID, demo: session.isDemo) }
                .onOpenURL { store.receive($0) }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { if let url = $0.webpageURL { store.receive(url) } }
                .onChange(of: phase) { _, new in if new == .active { Task { await store.sync() } } }
        }
    }
}
