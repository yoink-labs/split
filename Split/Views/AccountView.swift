import SwiftUI
import UniformTypeIdentifiers

/// The account tab: profile, preferences, data export, sync and sign out.
struct AccountView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.horizontalSizeClass) private var size
    @AppStorage("split.appearance") private var appearance = "system"
    @AppStorage("split.balanceReminders") private var balanceReminders = true
    @AppStorage("split.defaultCurrency") private var defaultCurrency = "USD"
    @State private var confirmSignOut = false
    @State private var exporting = false
    @State private var exportText = ""
    @State private var exportError: String?

    private var activeGroups: [ExpenseGroup] {
        store.groups.filter { !($0.archived ?? false) }
    }

    private var peopleCount: Int {
        Set(activeGroups.flatMap { $0.members.map(Analytics.key) }).count
    }

    private var entryCount: Int {
        activeGroups.reduce(0) { $0 + store.entries(in: $1).count }
    }

    private var version: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? ""
        let build = info?["CFBundleVersion"] as? String ?? ""
        return "Split \(version) (\(build))"
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if size == .regular {
                        HStack(alignment: .top, spacing: 18) {
                            profileLink.frame(maxWidth: .infinity)
                            freeCard.frame(maxWidth: 300, maxHeight: .infinity, alignment: .topLeading)
                        }
                        .fixedSize(horizontal: false, vertical: true)
                    } else {
                        profileLink
                        freeCard
                    }
                    if size == .regular {
                        HStack(alignment: .top, spacing: 18) {
                            VStack(alignment: .leading, spacing: 18) {
                                preferences
                                syncSection
                            }
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                            VStack(alignment: .leading, spacing: 18) {
                                dataSection
                                exploreSection
                                signOutSection
                            }
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                        }
                    } else {
                        preferences
                        dataSection
                        exploreSection
                        syncSection
                        signOutSection
                    }
                    Text(version)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 2)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 16)
                .frame(maxWidth: 900)
                .frame(maxWidth: .infinity)
            }
            .background(AppBackground())
            .ledgerDestinations()
            .navigationTitle("You")
            .confirmationDialog(
                session.isDemo ? "Leave the sample preview?" : "Sign out?",
                isPresented: $confirmSignOut,
                titleVisibility: .visible
            ) {
                Button(session.isDemo ? "Leave preview" : "Sign out", role: .destructive) {
                    Task { await session.signOut() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(store.pending > 0
                     ? "\(store.pending) unsynced \(store.pending == 1 ? "change" : "changes") will stay on this device for this account. Sign back in to upload them."
                     : "Your shared expenses will be here when you return.")
            }
            .fileExporter(
                isPresented: $exporting,
                document: CSVFile(exportText),
                contentType: .commaSeparatedText,
                defaultFilename: "Split data"
            ) { result in
                if case .failure(let error) = result { exportError = error.localizedDescription }
            }
        }
    }

    private var profileLink: some View {
        NavigationLink(value: LedgerRoute.account(session.userID ?? "")) { profile }
            .buttonStyle(.plain)
            .accessibilityHint("Opens your charges by group")
    }

    private var profile: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 14) {
                Avatar(name: session.displayName, size: 56, tint: Palette.lime)
                VStack(alignment: .leading, spacing: 3) {
                    Text(session.displayName)
                        .font(.splitDisplay(24))
                        .foregroundStyle(Palette.onHero)
                        .lineLimit(2)
                        .minimumScaleFactor(0.8)
                    Text(session.isDemo ? "Sample preview · changes stay on this device" : "Your Yoink account")
                        .font(.caption)
                        .foregroundStyle(Palette.lime.opacity(0.62))
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Palette.lime.opacity(0.5))
            }
            HStack(spacing: 0) {
                stat("\(activeGroups.count)", label: "Groups")
                statDivider
                stat("\(peopleCount)", label: "People")
                statDivider
                stat("\(entryCount)", label: "Entries")
            }
            .padding(.vertical, 10)
            .background(Palette.onHero.opacity(0.06), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(activeGroups.count) groups, \(peopleCount) people, \(entryCount) entries")
        }
        .padding(18)
        .background(
            LinearGradient(colors: [Palette.hero, Palette.hero.opacity(0.94)], startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: Radius.header)
        )
        .overlay(RoundedRectangle(cornerRadius: Radius.header).stroke(Palette.lime.opacity(0.16), lineWidth: 1))
        .accessibilityElement(children: .combine)
    }

    private var freeCard: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                Image(systemName: "heart.fill")
                    .font(.subheadline)
                    .foregroundStyle(Palette.evergreen)
                    .accessibilityHidden(true)
                Text("Free. Every feature.")
                    .font(.headline)
                    .foregroundStyle(Palette.ink)
            }
            Text("Search, charts, currency conversion, receipts, reminders and exports are included. No Pro tier, no ads, no paywall.")
                .font(.subheadline)
                .foregroundStyle(Palette.ink.opacity(0.78))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.mint)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Palette.evergreen.opacity(0.16), lineWidth: 1))
        .accessibilityElement(children: .combine)
    }

    private func stat(_ value: String, label: String) -> some View {
        VStack(spacing: 3) {
            Text(value)
                .font(.splitDisplay(22))
                .foregroundStyle(Palette.lime)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .contentTransition(.numericText())
            Text(label)
                .font(.caption)
                .foregroundStyle(Palette.onHero.opacity(0.6))
        }
        .frame(maxWidth: .infinity)
        .accessibilityHidden(true)
    }

    private var statDivider: some View {
        Rectangle()
            .fill(Palette.lime.opacity(0.16))
            .frame(width: 1, height: 32)
            .accessibilityHidden(true)
    }

    private var preferences: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Preferences", subtitle: "How Split looks and reminds you")
            Card(padding: 0) {
                VStack(spacing: 0) {
                    settingsRow(
                        icon: "circle.lefthalf.filled",
                        title: "Appearance",
                        subtitle: "Match the system or choose a look"
                    ) {
                        Picker("Appearance", selection: $appearance) {
                            Text("System").tag("system")
                            Text("Light").tag("light")
                            Text("Dark").tag("dark")
                        }
                        .pickerStyle(.menu)
                        .labelsHidden()
                    }
                    rowDivider
                    settingsRow(
                        icon: "bell.badge",
                        title: "Remind me about balances",
                        subtitle: "Show open balances while you use Split"
                    ) {
                        Toggle("Remind me about balances", isOn: $balanceReminders)
                            .labelsHidden()
                    }
                    if balanceReminders, !store.dashboard.people.isEmpty {
                        reminderNote
                    }
                    rowDivider
                    settingsRow(
                        icon: "banknote",
                        title: "Default currency",
                        subtitle: "Used when you start something new"
                    ) {
                        Picker("Default currency", selection: $defaultCurrency) {
                            ForEach(Money.currencies, id: \.self) { code in
                                Text(code).tag(code)
                            }
                        }
                        .pickerStyle(.menu)
                        .labelsHidden()
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var reminderNote: some View {
        let count = store.dashboard.people.count
        HStack(spacing: 8) {
            Image(systemName: "bell.badge.fill")
                .font(.caption)
                .foregroundStyle(Palette.evergreen)
                .accessibilityHidden(true)
            Text("\(count) \(count == 1 ? "person has" : "people have") an open balance.")
                .font(.caption)
                .foregroundStyle(Palette.evergreen)
            Spacer(minLength: 0)
        }
        .padding(.leading, 60)
        .padding(.trailing, 14)
        .padding(.bottom, 12)
        .accessibilityElement(children: .combine)
    }

    private func settingsRow<Content: View>(
        icon: String,
        title: String,
        subtitle: String?,
        @ViewBuilder trailing: () -> Content
    ) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .semibold))
                .frame(width: 34, height: 34)
                .background(Palette.raised)
                .foregroundStyle(Palette.evergreen)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            trailing()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(minHeight: 56)
    }

    private var rowDivider: some View {
        Divider().overlay(Palette.line).padding(.leading, 60)
    }

    private var dataSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Your data", subtitle: "Everything, in a spreadsheet")
            Card(padding: 0) {
                VStack(spacing: 0) {
                    Button {
                        prepareExport()
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "square.and.arrow.up")
                                .font(.system(size: 15, weight: .semibold))
                                .frame(width: 34, height: 34)
                                .background(Palette.raised)
                                .foregroundStyle(Palette.evergreen)
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Export all data")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(Palette.ink)
                                Text("\(store.groups.count) \(store.groups.count == 1 ? "group" : "groups") as CSV, one section each")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                        .frame(minHeight: 56)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Creates a CSV file with every group and entry")
                    if let exportError {
                        Divider().overlay(Palette.line)
                        InlineError(text: exportError)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                    }
                }
            }
        }
    }

    private var exploreSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Explore", subtitle: "Every feature, included")
            Card(padding: 0) {
                VStack(spacing: 0) {
                    NavigationLink { SearchView(showsClose: false) } label: {
                        navigationLabel(icon: "magnifyingglass", title: "Search", subtitle: "Groups, people and expenses")
                    }
                    .buttonStyle(.plain)
                    rowDivider
                    NavigationLink { InsightsView() } label: {
                        navigationLabel(icon: "chart.bar.xaxis", title: "Insights", subtitle: "Spending by month, category and person")
                    }
                    .buttonStyle(.plain)
                    if !session.isDemo {
                        rowDivider
                        NavigationLink { DeviceAccessView() } label: {
                            navigationLabel(icon: "desktopcomputer", title: "Connected computers", subtitle: "Approve and revoke device access")
                        }
                        .buttonStyle(.plain)
                    }
                    rowDivider
                    NavigationLink { ThirdPartyNoticesView() } label: {
                        navigationLabel(icon: "doc.text", title: "Third-party notices", subtitle: "Licenses for the work Split builds on")
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func navigationLabel(icon: String, title: String, subtitle: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .semibold))
                .frame(width: 34, height: 34)
                .background(Palette.raised)
                .foregroundStyle(Palette.evergreen)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(minHeight: 56)
        .contentShape(Rectangle())
    }

    private var syncSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Sync", subtitle: "Your ledger on every device")
            Card {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 9) {
                        Label(syncTitle, systemImage: syncSymbol)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(syncTint)
                        Spacer(minLength: 8)
                        if store.syncing {
                            ProgressView()
                                .controlSize(.small)
                                .accessibilityLabel("Syncing")
                        }
                    }
                    Text(syncDetail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let error = store.error {
                        InlineError(text: error)
                    }
                    if !session.isDemo {
                        Button {
                            Task { await store.sync() }
                        } label: {
                            Label(store.syncing ? "Syncing…" : "Sync now", systemImage: "arrow.triangle.2.circlepath")
                        }
                        .buttonStyle(GhostButton())
                        .disabled(store.syncing || !store.online)
                    }
                }
            }
        }
    }

    private var syncTitle: String {
        if session.isDemo { return "Sample data" }
        if !store.online { return "Offline" }
        if store.syncing { return "Syncing" }
        if store.error != nil { return "Sync needs attention" }
        if store.pending > 0 { return "\(store.pending) waiting to sync" }
        return "Up to date"
    }

    private var syncDetail: String {
        if session.isDemo { return "Changes stay on this device. Sign in to sync real groups and expenses." }
        if !store.online { return "New changes are saved here and upload when you reconnect." }
        if store.syncing { return "Uploading pending changes, then refreshing your ledger." }
        if store.error != nil { return "Your changes are safe on this device. Try again when you are ready." }
        if store.pending > 0 { return "Saved on this device. Split uploads them in order." }
        return "Everything is on the server."
    }

    private var syncSymbol: String {
        if session.isDemo { return "sparkles" }
        if !store.online { return "wifi.slash" }
        if store.syncing { return "arrow.triangle.2.circlepath" }
        if store.error != nil { return "exclamationmark.circle" }
        if store.pending > 0 { return "arrow.triangle.2.circlepath" }
        return "checkmark.circle"
    }

    private var syncTint: Color {
        if session.isDemo { return .secondary }
        if !store.online { return Palette.amber }
        if store.error != nil { return Palette.negative }
        if store.syncing || store.pending > 0 { return Palette.amber }
        return Palette.evergreen
    }

    private var signOutSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let error = session.error {
                InlineError(text: error)
            }
            Card(padding: 0) {
                Button(role: .destructive) {
                    confirmSignOut = true
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "rectangle.portrait.and.arrow.right")
                            .font(.system(size: 15, weight: .semibold))
                            .frame(width: 34, height: 34)
                            .background(Palette.negative.opacity(0.12))
                            .foregroundStyle(Palette.negative)
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .accessibilityHidden(true)
                        Text(session.isDemo ? "Leave preview and sign in" : "Sign out")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Palette.negative)
                        Spacer(minLength: 8)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .frame(minHeight: 56)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func prepareExport() {
        exportError = nil
        var parts: [String] = ["# Split data", "# Exported \(ISO8601DateFormatter().string(from: Date()))"]
        if store.groups.isEmpty {
            let placeholder = ExpenseGroup(name: "Split", kind: "group", currency: defaultCurrency, members: [])
            parts.append(LedgerCSV.export([], group: placeholder))
        } else {
            for group in store.groups.sorted(by: { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }) {
                let name = group.name
                    .replacingOccurrences(of: "\r", with: " ")
                    .replacingOccurrences(of: "\n", with: " ")
                parts.append("# Group: \(name)")
                parts.append(LedgerCSV.export(store.entries(in: group), group: group))
            }
        }
        exportText = parts.joined(separator: "\r\n") + "\r\n"
        exporting = true
    }
}

private struct ThirdPartyNoticesView: View {
    private let notices: [(title: String, resource: String)] = [
        ("ManaWG", "manawg"),
        ("ShareTab", "sharetab"),
        ("Spliit", "spliit"),
        ("Split Pro", "split-pro")
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Card {
                    Text("Split adapts permissively licensed work. The linked license files retain the upstream notices.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Card(padding: 0) {
                    VStack(spacing: 0) {
                        ForEach(Array(notices.enumerated()), id: \.offset) { index, notice in
                            NavigationLink {
                                LicenseTextView(title: notice.title, text: Self.license(notice.resource))
                            } label: {
                                HStack(spacing: 12) {
                                    Text(notice.title)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(Palette.ink)
                                    Spacer(minLength: 8)
                                    Image(systemName: "chevron.right")
                                        .font(.caption2.weight(.bold))
                                        .foregroundStyle(.tertiary)
                                }
                                .padding(.horizontal, 14)
                                .padding(.vertical, 12)
                                .frame(minHeight: 52)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            if index < notices.count - 1 {
                                Divider().overlay(Palette.line).padding(.leading, 14)
                            }
                        }
                    }
                }
                if let url = URL(string: "https://yoinklabs.dev") {
                    Link("Visit Yoink Labs", destination: url)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Palette.evergreen)
                        .frame(minHeight: 44)
                }
            }
            .padding(16)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .background(AppBackground())
        .navigationTitle("Third-party notices")
        .navigationBarTitleDisplayMode(.inline)
    }

    private static func license(_ project: String) -> String {
        guard let url = Bundle.main.url(forResource: project, withExtension: "txt", subdirectory: "licenses"),
              let text = try? String(contentsOf: url, encoding: .utf8) else {
            return "License unavailable."
        }
        return text
    }
}

private struct LicenseTextView: View {
    var title: String
    var text: String

    var body: some View {
        ScrollView {
            Text(verbatim: text)
                .font(.footnote)
                .textSelection(.enabled)
                .padding(18)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(AppBackground())
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }
}
