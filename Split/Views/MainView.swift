import SwiftUI

enum AppTab: Hashable {
    case home, groups, friends, analytics, activity, you
}

struct MainView: View {
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var store: ExpenseStore
    @State private var tab: AppTab = .home
    @Environment(\.horizontalSizeClass) private var size

    var body: some View {
        TabView(selection: $tab) {
            Tab("Home", systemImage: "house", value: AppTab.home) {
                DashboardView()
            }
            .badge((store.state.snapshot.disputes ?? []).filter(\.canResolve).count)
            Tab("Groups", systemImage: "person.3", value: AppTab.groups) {
                GroupsView()
            }
            .badge(store.invitationCount)
            Tab("Friends", systemImage: "person.2", value: AppTab.friends) {
                FriendsView()
            }
            Tab("Analytics", systemImage: "chart.bar.xaxis", value: AppTab.analytics) {
                AnalyticsTab()
            }
            // Six tabs overflow into More on a phone, so compact widths reach
            // Activity from Home instead. iPad and the iPhone Duo inner display keep it.
            Tab("Activity", systemImage: "clock.arrow.circlepath", value: AppTab.activity) {
                ActivityFeedView()
            }
            .hidden(size == .compact)
            Tab("You", systemImage: "person.crop.circle", value: AppTab.you) {
                AccountView()
            }
        }
        .tint(Palette.evergreen)
        .onChange(of: size) { _, size in
            if size == .compact && tab == .activity { tab = .home }
        }
        .onChange(of: store.joinedGroupID) { _, id in
            if id != nil { tab = .groups }
        }
    }
}
