import SwiftUI
import UniformTypeIdentifiers

/// Import one or more Splitwise group exports. Each CSV becomes one group; nothing is written
/// until the person reviews the preview, maps names and confirms.
struct SplitwiseImportView: View {
    /// Import into this group instead of creating new ones (from group settings).
    var target: ExpenseGroup? = nil

    @EnvironmentObject private var store: ExpenseStore
    @EnvironmentObject private var fx: FXStore
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss
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
                                .disabled(importing)
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
        store.groups.filter { !($0.archived ?? false) && $0.members.contains { $0.userID == session.userID && $0.removed != true } }
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
                if !detail.isEmpty { Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Step \(number). \(title). \(detail)")
    }

    private var privacyNote: some View {
        Label("Files are read on this device. Split saves the group and entries you confirm.", systemImage: "lock")
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
                .disabled(importing || pendingDrafts.isEmpty || pendingDrafts.contains { $0.conversion?.currency != fx.home || $0.blocker(groups: candidateGroups, userID: session.userID) != nil })
                .accessibilityIdentifier("splitwise-import-confirm")
                if let blocker = pendingDrafts.lazy.compactMap({ $0.blocker(groups: candidateGroups, userID: session.userID) }).first {
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
        var draft = ImportDraft(parsed: parsed, name: parsed.name, targetID: target?.id ?? existing?.id)
        draft.autoMap(groups: candidateGroups, userID: session.userID, myName: session.displayName)
        if existing != nil { draft.note = "You imported this file before. Importing again only adds entries that are missing." }
        drafts.append(draft)
    }

    private func runImport() async {
        let currency = fx.home
        importing = true
        defer { importing = false }
        for index in drafts.indices where drafts[index].result == nil {
            let draft = drafts[index]
            guard let conversion = draft.conversion, conversion.currency == currency else { continue }
            do {
                let request = try SplitwiseImportRequest.make(draft.parsed, name: draft.name, currency: currency, kind: "trip",
                                                              target: draft.targetID.flatMap { store.group($0) }, mapping: draft.mapping,
                                                              displayNames: draft.displayNames, conversion: conversion, userID: session.userID ?? "")
                let result = try await store.importSplitwise(request)
                drafts[index].result = result
                drafts[index].targetID = result.groupID
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
    var conversion: SplitwiseConversion?
    /// nil creates a new group.
    var targetID: String?
    var mapping: [String: MemberMapping] = [:]
    var displayNames: [String: String] = [:]
    var inviteEmails: [String: String] = [:]
    var result: ExpenseStore.SplitwiseResult?
    var error: String?
    var note: String?

    mutating func autoMap(groups: [ExpenseGroup], userID: String?, myName: String) {
        let group = targetID.flatMap { id in groups.first { $0.id == id } }
        let active = group?.members.filter { $0.removed != true } ?? []
        let mySeat = active.first { $0.userID == userID && userID != nil }
        let full = myName.lowercased()
        let first = full.split(separator: " ").first.map(String.init) ?? full
        let me = parsed.members.first { mapping[$0] == .me }
            ?? parsed.members.first { $0.lowercased() == mySeat?.name.lowercased() }
            ?? parsed.members.first { full != "you" && $0.lowercased() == full }
            ?? parsed.members.first { first != "you" && $0.lowercased() == first }
        let previous = mapping
        mapping = Dictionary(uniqueKeysWithValues: parsed.members.map { name in
            if name == me { return (name, .me) }
            if let choice = previous[name], case .account = choice { return (name, choice) }
            if let member = active.first(where: { $0.id != mySeat?.id && $0.name.lowercased() == name.lowercased() }) {
                return (name, .member(member.id))
            }
            return (name, .placeholder)
        })
    }

    func blocker(groups: [ExpenseGroup], userID: String?) -> String? {
        if targetID == nil {
            if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.utf16.count > 80 { return "Enter a group name of up to 80 characters." }
            if !mapping.values.contains(.me) { return "In \(name), choose which Splitwise name is you." }
        }
        let members = groups.first { $0.id == targetID }?.members ?? []
        let identities = mapping.values.compactMap { value -> String? in
            switch value {
            case .me: return userID.map { "user:" + $0 } ?? "me"
            case .account(let account): return "user:" + account.userID
            case .member(let id): return members.first { $0.id == id }?.userID.map { "user:" + $0 } ?? id
            case .placeholder: return nil
            }
        }
        if Set(identities).count != identities.count { return "In \(name), two names point to the same person." }
        return nil
    }

    mutating func assign(_ choice: MemberMapping, to source: String) {
        if choice == .me, let previous = mapping.first(where: { $0.key != source && $0.value == .me }) {
            mapping[previous.key] = .placeholder
        }
        mapping[source] = choice
    }
}

private struct ImportDraftCard: View {
    @Binding var draft: ImportDraft
    var target: ExpenseGroup?
    var groups: [ExpenseGroup]
    var myName: String
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var store: ExpenseStore
    @EnvironmentObject private var fx: FXStore
    @State private var showAll = false
    @State private var editing: String?
    @State private var rateRetry = 0
    @State private var rateError: String?

    private var targetGroup: ExpenseGroup? { draft.targetID.flatMap { id in groups.first { $0.id == id } ?? (target?.id == id ? target : nil) } }
    private var currency: String { draft.result == nil ? fx.home : draft.conversion?.currency ?? fx.home }
    private var conversion: SplitwiseConversion? { draft.conversion?.currency == currency ? draft.conversion : nil }
    private var members: [Person] { targetGroup?.members.filter { $0.userID != session.userID && $0.removed != true } ?? [] }

    var body: some View {
        Card(padding: 0) {
            VStack(alignment: .leading, spacing: 0) {
                header
                    .padding(14)
                RowDivider(inset: 0)
                reconciliation
                    .padding(14)
                RowDivider(inset: 0)
                if let result = draft.result {
                    resultRow(result).padding(14)
                    if !store.isDemo {
                        emailInvites(result).padding(.horizontal, 14)
                    }
                    RowDivider(inset: 0)
                } else {
                    people.padding(14)
                    RowDivider(inset: 0)
                }
                analytics.padding(14)
                RowDivider(inset: 0)
                preview
                    .padding(14)
                if let error = draft.error {
                    InlineError(text: error).padding(14)
                }
            }
        }
        .task(id: "\(currency):\(rateRetry)") { await prepareConversion() }
        .sheet(isPresented: Binding(get: { editing != nil }, set: { if !$0 { editing = nil } })) {
            if let source = editing {
                SplitwisePersonEditor(source: source, members: members, newGroup: draft.targetID == nil,
                                      mapping: draft.mapping[source] ?? .placeholder, displayName: draft.displayNames[source] ?? "",
                                      email: draft.inviteEmails[source] ?? "") { choice, name, email in
                    draft.assign(choice, to: source)
                    draft.displayNames[source] = name
                    draft.inviteEmails[source] = email
                }
            }
        }
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
                    if draft.targetID == nil && draft.result == nil {
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
            if target == nil && draft.result == nil {
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

        }
    }

    private var stats: String {
        var parts = ["\(draft.parsed.expenseCount) \(draft.parsed.expenseCount == 1 ? "expense" : "expenses")"]
        if draft.parsed.refundCount > 0 { parts.append("\(draft.parsed.refundCount) \(draft.parsed.refundCount == 1 ? "refund" : "refunds")") }
        if draft.parsed.paymentCount > 0 { parts.append("\(draft.parsed.paymentCount) \(draft.parsed.paymentCount == 1 ? "payment" : "payments")") }

        return parts.joined(separator: " · ")
    }

    @ViewBuilder private var reconciliation: some View {
        if !draft.parsed.mismatches.isEmpty {
            statusRow(symbol: "exclamationmark.triangle.fill", tint: Palette.coral, title: "Source balances differ from Splitwise’s totals",
                      detail: "Check the export if you expected the balances to match.")
        } else if draft.parsed.reconciled {
            statusRow(symbol: "checkmark.seal.fill", tint: Palette.positive, title: "Source balances match the Splitwise export", detail: "")
        }
    }

    @ViewBuilder private var analytics: some View {
        if let conversion {
            SplitwiseAnalyticsPreview(conversion: conversion, members: draft.parsed.members, mappedName: mappedName)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Text("Analytics preview in \(currency)").font(.subheadline.weight(.semibold))
                if let rateError {
                    InlineError(text: rateError)
                    Button("Retry exchange rates") { rateRetry += 1 }
                } else {
                    ProgressView("Loading historical exchange rates…")
                        .font(.caption)
                }
            }
        }
    }

    private func prepareConversion() async {
        guard draft.result == nil else { return }
        let targetCurrency = currency
        rateError = nil
        draft.conversion = nil
        do {
            let prepared = try await SplitwiseConversion.prepare(draft.parsed.rows, currency: targetCurrency, fx: fx)
            guard !Task.isCancelled, currency == targetCurrency else { return }
            draft.conversion = prepared
        } catch {
            guard !Task.isCancelled, currency == targetCurrency else { return }
            rateError = error.localizedDescription
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
                if !detail.isEmpty { Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var people: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("People").font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
            Text("Claim your history, link a Split account, or prepare an email invite.")
                .font(.caption).foregroundStyle(.secondary)
            ForEach(draft.parsed.members, id: \.self) { source in
                Button {
                    editing = source
                } label: {
                    HStack(spacing: 10) {
                        Avatar(name: source, size: 32)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(source).font(.subheadline.weight(.medium)).foregroundStyle(Palette.ink)
                            Text(mappingDetail(source)).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("Edit how this person imports")
            }
        }
    }

    private func mappingDetail(_ source: String) -> String {
        switch draft.mapping[source] ?? .placeholder {
        case .me: return "This is me · " + mappedName(source)
        case .member, .account: return "Linked to " + mappedName(source)
        case .placeholder:
            if let email = draft.inviteEmails[source], !email.isEmpty { return "Invite " + email }
            return mappedName(source) == source ? "Placeholder" : "Placeholder · " + mappedName(source)
        }
    }

    private func mappedName(_ source: String) -> String {
        let rename = draft.displayNames[source].flatMap { $0.isEmpty ? nil : $0 }
        switch draft.mapping[source] ?? .placeholder {
        case .me:
            if let name = targetGroup?.members.first(where: { $0.userID == session.userID })?.name { return name }
            return rename ?? (myName.isEmpty ? source : myName)
        case .member(let id):
            let member = members.first { $0.id == id }
            return (member?.userID == nil ? rename : nil) ?? member?.name ?? source
        case .account(let account): return members.first { $0.userID == account.userID }?.name ?? account.name
        case .placeholder: return rename ?? source
        }
    }

    @ViewBuilder private func emailInvites(_ result: ExpenseStore.SplitwiseResult) -> some View {
        let recipients = (result.people ?? []).filter { person in
            guard let email = draft.inviteEmails[person.name], !email.isEmpty else { return false }
            if let member = targetGroup?.members.first(where: { $0.id == person.memberID }) {
                return member.userID == nil && member.removed != true
            }
            return draft.mapping[person.name] == .placeholder
        }
        if !recipients.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("Email invites").font(.subheadline.weight(.semibold))
                ForEach(recipients, id: \.name) { person in
                    SplitwiseEmailInvite(groupID: result.groupID, memberID: person.memberID, name: mappedName(person.name),
                                         email: draft.inviteEmails[person.name] ?? "")
                }
            }
            .padding(.bottom, 14)
        }
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
            LazyVStack(alignment: .leading, spacing: 8) {
                ForEach(Array(draft.parsed.rows.prefix(showAll ? draft.parsed.rows.count : 4).enumerated()), id: \.offset) { index, row in
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
                            Text("\(FXQuote.shortDay(row.day)) · \(row.allPayers.map { mappedName($0.name) }.joined(separator: " & ")) \(row.refund == true ? "received a refund" : "paid")")
                                .font(.caption).foregroundStyle(.secondary)
                            Text((row.payment ? "Received by " : row.refund == true ? "Credited to " : "Split between ") + row.splits.map { mappedName($0.name) }.joined(separator: ", "))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 8)
                        let amount = conversion.map { (row.currency == currency ? "" : "≈ ") + Money.text($0.settled[index].amount, currency) }
                        Text(amount ?? "—").font(.splitAmount(14)).foregroundStyle(Palette.ink).lineLimit(1)
                    }
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
        if result.inserted == 0 { text = "All entries were already in Split." }
        else if result.duplicates > 0 { text = "Added \(result.inserted) entries. Skipped \(result.duplicates) already in Split." }
        else { text = "Added \(result.inserted) entries\(result.created ? " to a new group" : "")." }
        return Label(text, systemImage: "checkmark.circle.fill")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Palette.positive)
    }
}
