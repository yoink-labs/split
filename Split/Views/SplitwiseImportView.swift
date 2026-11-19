import SwiftUI
import UniformTypeIdentifiers

/// Import one or more Splitwise group exports. Each CSV becomes one group; nothing is written
/// until the person reviews the preview, maps names and confirms.
struct SplitwiseImportView: View {
    /// Import into this group instead of creating new ones (from group settings).
    var target: ExpenseGroup? = nil

    @EnvironmentObject private var store: ExpenseStore
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var size
    @State private var drafts: [ImportDraft] = []
    @State private var failures: [String] = []
    @State private var choosing = false
    @State private var importing = false
    @State private var finished = false

    private var pendingDrafts: [ImportDraft] { drafts.filter { $0.result == nil } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.section) {
                    if drafts.isEmpty {
                        intro
                        steps
                        ActionBar {
                            SplitActionButton(title: "Choose CSV files", symbol: "doc.badge.plus", prominent: true) { choosing = true }
                        }
                        privacyNote
                    } else {
                        summaryHeader
                        ForEach($drafts) { $draft in
                            ImportDraftCard(draft: $draft, target: target, groups: candidateGroups, myName: session.displayName)
                        }
                    }
                    ForEach(failures, id: \.self) { InlineError(text: $0) }
                }
                .padding(.horizontal, Spacing.page)
                .padding(.vertical, Spacing.m)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .safeAreaInset(edge: .bottom) {
                if !drafts.isEmpty { bottomBar }
            }
            .background(AppBackground())
            .navigationTitle("Import from Splitwise")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(finished ? "Done" : "Cancel") { dismiss() }.disabled(importing)
                }
                if !drafts.isEmpty, !finished {
                    ToolbarItem(placement: .primaryAction) {
                        Button { choosing = true } label: { Label("Add files", systemImage: "doc.badge.plus") }
                            .disabled(importing)
                    }
                }
            }
            .fileImporter(isPresented: $choosing, allowedContentTypes: [.commaSeparatedText, .plainText, .text], allowsMultipleSelection: true) { result in
                switch result {
                case .success(let urls): load(urls)
                case .failure(let error): failures = [error.localizedDescription]
                }
            }
            .interactiveDismissDisabled(importing)
            .onAppear(perform: loadDebugFixtures)
        }
    }

    private var candidateGroups: [ExpenseGroup] {
        store.groups.filter { !($0.archived ?? false) && $0.members.contains { $0.userID == session.userID } }
    }

    // MARK: - Intro

    private var intro: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            Image(systemName: "arrow.down.doc")
                .font(.system(size: 22, weight: .semibold))
                .frame(width: 52, height: 52)
                .background(Palette.lime.opacity(0.45))
                .foregroundStyle(Palette.ink)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .accessibilityHidden(true)
            Text("Bring your groups over")
                .font(.splitDisplay(30))
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
            Text("Every expense, payment and person comes with you. Split checks the result against Splitwise’s own totals, to the cent. Free, like everything here.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var steps: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Export from Splitwise", subtitle: "One spreadsheet per group, about a minute each")
            Card(padding: 0) {
                VStack(spacing: 0) {
                    step(1, "Open the group in Splitwise", "On splitwise.com, choose the group from the left side. In the Splitwise app, open the group.")
                    RowDivider(inset: 60)
                    step(2, "Choose Export as spreadsheet", "Website: select the gear (group settings), then Export as spreadsheet. App: scroll the buttons under the group name to the end and tap Export.")
                    RowDivider(inset: 60)
                    step(3, "Save it, then pick it here", "Save the CSV to Files or iCloud Drive. Select several files to bring several groups at once.")
                }
            }
            Text("Splitwise names the columns in your account’s language. Split reads them either way.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func step(_ number: Int, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(number)")
                .font(.subheadline.weight(.bold))
                .frame(width: 34, height: 34)
                .background(Palette.raised)
                .foregroundStyle(Palette.evergreen)
                .clipShape(Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
                Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Step \(number). \(title). \(detail)")
    }

    private var privacyNote: some View {
        Label("Files are read on this device. Only the expenses you confirm are sent to your Split account.", systemImage: "lock")
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - Review

    private var summaryHeader: some View {
        let rows = drafts.reduce(0) { $0 + $1.parsed.rows.count }
        let matched = drafts.filter { $0.parsed.reconciled }.count
        return VStack(alignment: .leading, spacing: 4) {
            Text(finished ? "Import complete" : "Review \(drafts.count) \(drafts.count == 1 ? "group" : "groups")")
                .font(.title3.weight(.semibold))
                .foregroundStyle(Palette.ink)
            Text("\(rows) entries · \(matched) of \(drafts.count) match Splitwise’s totals")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var bottomBar: some View {
        VStack(spacing: 8) {
            if finished {
                SplitActionButton(title: "Done", symbol: "checkmark", prominent: true) { dismiss() }
            } else {
                Button { Task { await runImport() } } label: {
                    if importing {
                        HStack(spacing: 8) { ProgressView().tint(Palette.paper); Text("Importing…") }
                    } else {
                        Label(pendingDrafts.count == 1 ? "Import group" : "Import \(pendingDrafts.count) groups", systemImage: "arrow.down.circle")
                    }
                }
                .buttonStyle(.splitPrimary)
                .disabled(importing || pendingDrafts.isEmpty || pendingDrafts.contains { $0.blocker(target: target) != nil })
                .accessibilityIdentifier("splitwise-import-confirm")
                if let blocker = pendingDrafts.lazy.compactMap({ $0.blocker(target: target) }).first {
                    Text(blocker).font(.caption).foregroundStyle(Palette.coral)
                }
            }
        }
        .padding(.horizontal, Spacing.page)
        .padding(.vertical, 10)
        .frame(maxWidth: 760)
        .frame(maxWidth: .infinity)
        .background(.bar)
    }

    // MARK: - Actions

    private func load(_ urls: [URL]) {
        failures = []
        for url in urls {
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            do {
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size <= 2_000_000 else { throw LedgerError.invalid("\(url.lastPathComponent) is larger than 2 MB.") }
                let data = try Data(contentsOf: url)
                guard let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .utf16) ?? String(data: data, encoding: .isoLatin1) else {
                    throw LedgerError.invalid("\(url.lastPathComponent) isn’t a text file.")
                }
                add(try SplitwiseCSV.parse(text, fileName: url.lastPathComponent))
            } catch {
                failures.append(error.localizedDescription)
            }
        }
    }

    private func add(_ parsed: SplitwiseGroup) {
        guard !drafts.contains(where: { $0.id == parsed.fingerprint }) else {
            failures.append("\(parsed.name) is already in this list.")
            return
        }
        let existing = store.groups.first { $0.id == SplitwiseImportRequest.groupID(fingerprint: parsed.fingerprint, userID: session.userID ?? "") }
        var draft = ImportDraft(parsed: parsed, name: parsed.name, currency: parsed.mainCurrency, targetID: target?.id ?? existing?.id)
        draft.autoMap(groups: candidateGroups, userID: session.userID, myName: session.displayName)
        if existing != nil { draft.note = "You imported this file before. Importing again only adds entries that are missing." }
        drafts.append(draft)
    }

    private func runImport() async {
        importing = true
        defer { importing = false }
        for index in drafts.indices where drafts[index].result == nil {
            let draft = drafts[index]
            do {
                let request = try SplitwiseImportRequest.make(draft.parsed, name: draft.name, currency: draft.currency, kind: "trip",
                                                              target: draft.targetID.flatMap { store.group($0) }, mapping: draft.mapping, userID: session.userID ?? "")
                drafts[index].result = try await store.importSplitwise(request)
                drafts[index].error = nil
            } catch {
                drafts[index].error = error.localizedDescription
            }
        }
        finished = drafts.allSatisfy { $0.result != nil }
    }

    /// Debug builds accept `-splitImportFixtures path1,path2` so simulator QA can skip the Files picker.
    private func loadDebugFixtures() {
        #if DEBUG
        guard drafts.isEmpty, let paths = UserDefaults.standard.string(forKey: "splitImportFixtures"), !paths.isEmpty else { return }
        load(paths.split(separator: ",").map { URL(fileURLWithPath: String($0)) })
        #endif
    }
}

struct ImportDraft: Identifiable {
    var id: String { parsed.fingerprint }
    var parsed: SplitwiseGroup
    var name: String
    var currency: String
    /// nil creates a new group.
    var targetID: String?
    var mapping: [String: MemberMapping] = [:]
    var result: ExpenseStore.SplitwiseResult?
    var error: String?
    var note: String?

    mutating func autoMap(groups: [ExpenseGroup], userID: String?, myName: String) {
        let group = targetID.flatMap { id in groups.first { $0.id == id } }
        var next: [String: MemberMapping] = [:]
        let mine = myName.lowercased()
        for name in parsed.members {
            let key = name.lowercased()
            if let group, let member = group.members.first(where: { $0.name.lowercased() == key }) {
                next[name] = member.userID == userID && userID != nil ? .me : .member(member.id)
            } else {
                next[name] = .placeholder
            }
        }
        if !next.values.contains(.me), mine != "you", !mine.isEmpty {
            let first = mine.split(separator: " ").first.map(String.init) ?? mine
            if let name = parsed.members.first(where: { $0.lowercased() == mine || $0.lowercased() == first || $0.lowercased().hasPrefix(first + " ") }) {
                next[name] = .me
            }
        }
        mapping = next
    }

    func blocker(target: ExpenseGroup?) -> String? {
        if targetID == nil {
            if name.trimmingCharacters(in: .whitespaces).isEmpty { return "Name every new group." }
            if !mapping.values.contains(.me) { return "In \(name), choose which Splitwise name is you." }
        }
        if mapping.values.filter({ $0 == .me }).count > 1 { return "In \(name), choose yourself once." }
        let members = mapping.values.compactMap { value -> String? in if case .member(let id) = value { return id } else { return nil } }
        if Set(members).count != members.count { return "In \(name), two names point to the same person." }
        return nil
    }
}

private struct ImportDraftCard: View {
    @Binding var draft: ImportDraft
    var target: ExpenseGroup?
    var groups: [ExpenseGroup]
    var myName: String
    @EnvironmentObject private var session: SessionStore
    @State private var showAll = false

    private var targetGroup: ExpenseGroup? { draft.targetID.flatMap { id in groups.first { $0.id == id } ?? (target?.id == id ? target : nil) } }
    private var mismatches: [SplitwiseGroup.Mismatch] { draft.parsed.mismatches }

    var body: some View {
        Card(padding: 0) {
            VStack(alignment: .leading, spacing: 0) {
                header
                    .padding(14)
                RowDivider(inset: 0)
                reconciliation
                    .padding(14)
                RowDivider(inset: 0)
                people
                    .padding(14)
                RowDivider(inset: 0)
                preview
                    .padding(14)
                if let result = draft.result {
                    RowDivider(inset: 0)
                    resultRow(result).padding(14)
                }
                if let error = draft.error {
                    InlineError(text: error).padding(14)
                }
            }
        }
        .disabled(draft.result != nil)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: "airplane")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(width: 40, height: 40)
                    .background(Palette.lime.opacity(0.4))
                    .foregroundStyle(Palette.ink)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    if draft.targetID == nil {
                        TextField("Group name", text: $draft.name)
                            .font(.headline)
                            .foregroundStyle(Palette.ink)
                            .accessibilityLabel("Group name")
                    } else {
                        Text(targetGroup?.name ?? draft.name).font(.headline).foregroundStyle(Palette.ink)
                    }
                    Text(stats).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            if let note = draft.note {
                Label(note, systemImage: "info.circle").font(.caption).foregroundStyle(.secondary)
            }
            if target == nil {
                HStack {
                    Text("Import into").font(.subheadline).foregroundStyle(Palette.ink)
                    Spacer()
                    Picker("Import into", selection: Binding(get: { draft.targetID ?? "" }, set: { value in
                        draft.targetID = value.isEmpty ? nil : value
                        draft.autoMap(groups: groups, userID: session.userID, myName: myName)
                    })) {
                        Text("A new group").tag("")
                        ForEach(groups.filter { !$0.isFriend }) { Text($0.name).tag($0.id) }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                }
            }
            if draft.targetID == nil {
                HStack {
                    Text("Group currency").font(.subheadline).foregroundStyle(Palette.ink)
                    Spacer()
                    Picker("Group currency", selection: $draft.currency) {
                        ForEach(Money.currencies, id: \.self) { Text($0).tag($0) }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                }
                if draft.parsed.currencies.count > 1 {
                    Text("Entries keep their original currency, just like in Splitwise. Convert any of them later.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private var stats: String {
        var parts = ["\(draft.parsed.expenseCount) \(draft.parsed.expenseCount == 1 ? "expense" : "expenses")"]
        if draft.parsed.paymentCount > 0 { parts.append("\(draft.parsed.paymentCount) \(draft.parsed.paymentCount == 1 ? "payment" : "payments")") }
        parts.append(draft.parsed.currencies.joined(separator: ", "))
        return parts.joined(separator: " · ")
    }

    @ViewBuilder private var reconciliation: some View {
        if draft.parsed.totals.isEmpty {
            statusRow(symbol: "questionmark.circle", tint: Palette.amber, title: "No Total balance row", detail: "This file has no Splitwise totals to check against. Compare the balances after importing.")
        } else if mismatches.isEmpty {
            statusRow(symbol: "checkmark.seal.fill", tint: Palette.positive, title: "Matches Splitwise to the cent", detail: "Balances after import equal the Total balance \(draft.parsed.totals.count == 1 ? "row" : "rows") in the file.")
        } else {
            VStack(alignment: .leading, spacing: 8) {
                statusRow(symbol: "exclamationmark.triangle.fill", tint: Palette.coral, title: "Doesn’t match Splitwise’s totals", detail: "The file may have been edited. You can still import, then fix the difference with a payment.")
                ForEach(mismatches.prefix(4), id: \.member) { miss in
                    HStack {
                        Text(miss.member).font(.caption.weight(.medium))
                        Spacer()
                        Text("Splitwise \(Money.text(miss.expected, miss.currency, signed: true)) · Split \(Money.text(miss.imported, miss.currency, signed: true))")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    .padding(.leading, 44)
                }
            }
        }
    }

    private func statusRow(symbol: String, tint: Color, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 32)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
                Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var people: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("People").font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
            ForEach(draft.parsed.members, id: \.self) { name in
                HStack(alignment: .center, spacing: 10) {
                    Avatar(name: name, size: 32)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(name).font(.subheadline.weight(.medium)).foregroundStyle(Palette.ink)
                        if let total = net(name) {
                            Text(total).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    Picker(name, selection: Binding(get: { draft.mapping[name] ?? .placeholder }, set: { draft.mapping[name] = $0 })) {
                        Text("Me").tag(MemberMapping.me)
                        if let group = targetGroup {
                            ForEach(group.members.filter { $0.userID != session.userID }) { member in
                                Text(member.name).tag(MemberMapping.member(member.id))
                            }
                        }
                        Text("Placeholder").tag(MemberMapping.placeholder)
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                    .fixedSize()
                    .accessibilityLabel("\(name) becomes")
                }
            }
            Text("Placeholders keep their history and can claim it later with an invite.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func net(_ name: String) -> String? {
        let parts = draft.parsed.totals.keys.sorted().compactMap { currency -> String? in
            guard let value = draft.parsed.totals[currency]?[name], value != 0 else { return nil }
            return (value > 0 ? "gets back " : "owes ") + Money.text(abs(value), currency)
        }
        return parts.isEmpty ? "settled" : parts.joined(separator: " · ")
    }

    private var preview: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Entries").font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
                Spacer()
                if draft.parsed.rows.count > 4 {
                    Button(showAll ? "Show fewer" : "Show all \(draft.parsed.rows.count)") { showAll.toggle() }
                        .font(.caption.weight(.semibold))
                }
            }
            ForEach(Array(draft.parsed.rows.prefix(showAll ? 200 : 4).enumerated()), id: \.offset) { _, row in
                HStack(spacing: 10) {
                    Image(systemName: row.payment ? "arrow.left.arrow.right" : CategoryMeta.named(row.category ?? "General").symbol)
                        .font(.caption.weight(.semibold))
                        .frame(width: 28, height: 28)
                        .background(Palette.raised)
                        .foregroundStyle(Palette.evergreen)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(row.title).font(.subheadline).foregroundStyle(Palette.ink).lineLimit(1)
                        Text("\(FXQuote.shortDay(row.day)) · \(row.allPayers.map(\.name).joined(separator: " & ")) paid").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    Text(Money.text(row.amount, row.currency)).font(.splitAmount(14)).foregroundStyle(Palette.ink).lineLimit(1)
                }
            }
            if !draft.parsed.skipped.isEmpty {
                Text("Left out: " + draft.parsed.skipped.joined(separator: "; "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func resultRow(_ result: ExpenseStore.SplitwiseResult) -> some View {
        let text: String
        if result.inserted == 0 { text = "Already imported. Nothing new to add." }
        else if result.duplicates > 0 { text = "Added \(result.inserted) entries. Skipped \(result.duplicates) already in Split." }
        else { text = "Added \(result.inserted) entries\(result.created ? " to a new group" : "")." }
        return Label(text, systemImage: "checkmark.circle.fill")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Palette.positive)
    }
}
