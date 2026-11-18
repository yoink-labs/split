import SwiftUI

enum AppTab: Hashable {
    case home, groups, friends, activity, you
}

struct MainView: View {
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var store: ExpenseStore
    @State private var tab: AppTab = .home

    var body: some View {
        TabView(selection: $tab) {
            Tab("Home", systemImage: "house", value: AppTab.home) {
                DashboardView()
            }
            Tab("Groups", systemImage: "person.3", value: AppTab.groups) {
                GroupsView()
            }
            Tab("Friends", systemImage: "person.2", value: AppTab.friends) {
                FriendsView()
            }
            Tab("Activity", systemImage: "clock.arrow.circlepath", value: AppTab.activity) {
                ActivityFeedView()
            }
            Tab("You", systemImage: "person.crop.circle", value: AppTab.you) {
                AccountView()
            }
        }
        .tint(Palette.evergreen)
        .onChange(of: store.joinedGroupID) { _, id in
            if id != nil { tab = .groups }
        }
    }
}
