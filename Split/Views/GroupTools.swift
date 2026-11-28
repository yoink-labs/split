import SwiftUI
import UniformTypeIdentifiers

struct LedgerExportFile: FileDocument {
    static var readableContentTypes: [UTType] { [.commaSeparatedText, .plainText, .pdf] }
    var data: Data
    init(_ text: String) { data = Data(text.utf8) }
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}

struct GroupTools: View {
    var group: ExpenseGroup
    @EnvironmentObject var store: ExpenseStore
    @EnvironmentObject var session: SessionStore
    @Environment(\.dismiss) var dismiss
    @State private var name = ""
    @State private var currency = ""
    @State private var simplify = true
    @State private var description = ""
    @State private var start: Date?
    @State private var end: Date?
    @State private var weights: [String: String] = [:]
    @State private var choose = false
    @State private var exporting = false
    @State private var export: (file: LedgerExportFile, type: UTType, name: String)?
    @State private var busy = false
    @State private var pending: [CSVExpense] = []
    @State private var message: String?
    @State private var error: String?
    @State private var confirmLeave = false
    @State private var confirmDelete = false
    @State private var confirmArchive = false
    @State private var initialized = false

    private var current: ExpenseGroup { store.group(group.id) ?? group }
    private var entries: [LedgerEntry] { store.entries(in: current) }
    private var isArchived: Bool { current.archived == true }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Group name", text: $name)
                        .accessibilityIdentifier("group-settings-name")
                    Picker("Currency", selection: $currency) {
                        ForEach(Money.currencies, id: \.self) { Text($0).tag($0) }
                    }
                    .disabled(!entries.isEmpty)
                    GroupMetadataFields(description: $description, start: $start, end: $end, isTrip: current.kind == "trip")
                    Toggle("Simplify payments", isOn: $simplify)
                    Button {
                        run {
                            try await store.updateGroup(current, name: name, currency: currency, simplify: simplify, description: description, start: start, end: end)
                            message = "Group details saved."
                        }
                    } label: {
                        HStack {
                            Spacer()
                            Label("Save changes", systemImage: "checkmark")
                                .font(.subheadline.weight(.semibold))
                                .padding(.horizontal, 14)
                                .frame(minHeight: 44)
                                .foregroundStyle(Palette.ink)
                                .glassCapsule(tint: Palette.card.opacity(0.40))
                        }
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                } header: {
                    Text("Group details")
                } footer: {
                    Text(entries.isEmpty ? "You can change the currency until the first expense lands." : "The currency is locked once the group has expenses. Simplify matches opposite balances before suggesting payments.")
                }

                Section {
                    ForEach(current.members) { member in
                        LabeledContent(member.userID == session.userID ? "You" : member.name) {
                            TextField("1", text: Binding(get: { weights[member.id] ?? "" }, set: { weights[member.id] = $0 }))
                                .multilineTextAlignment(.trailing)
                                .keyboardType(.numberPad)
                                .accessibilityLabel(member.name + " default shares")
                        }
                    }
                    Button("Save default split") {
                        run {
                            var values: [String: Int] = [:]
                            for member in current.members {
                                guard let raw = weights[member.id], !raw.isEmpty else { continue }
                                guard let value = Int(raw), (0...1000).contains(value) else {
                                    throw LedgerError.invalid("Enter a whole number from 0 to 1000.")
                                }
                                if value > 0 { values[member.id] = value }
                            }
                            guard !values.isEmpty else { throw LedgerError.invalid("Include at least one person.") }
                            let flat = values.count == current.members.count && values.values.allSatisfy { $0 == 1 }
                            _ = try await store.groupAction(current.id, "default-split", ["weights": flat ? [:] : values])
                            message = "Default split saved."
                        }
                    }
                } header: {
                    Text("Default shares")
                } footer: {
                    Text("Use 2 shares for a couple or 0 to exclude someone. You can change the split on each expense.")
                }

                if let me = current.members.first(where: { $0.userID == session.userID && $0.removed != true }) {
                    Section {
                        NavigationLink {
                            PaymentSettings(groupID: current.id, initial: me.paymentOverride,
                                            defaults: store.state.snapshot.paymentMethods ?? [])
                        } label: {
                            Label("Your payment methods", systemImage: "creditcard")
                        }
                    } footer: {
                        Text(me.paymentOverride == nil ? "Using your profile payment methods." : "Using payment methods set for this group.")
                    }
                }

                if current.kind == "trip" {
                    TripRatesSection(
                        group: current,
                        canEdit: current.members.contains { $0.userID == session.userID && $0.removed != true },
                        run: { work in run { try await work(); message = "Exchange rate saved." } }
                    )
                }

                Section {
                    Button("Import CSV") { choose = true }
                    Button("Export CSV") {
                        export = (LedgerExportFile(LedgerCSV.export(entries, group: current)), .commaSeparatedText, current.name + " expenses")
                        exporting = true
                    }
                    if !pending.isEmpty {
                        let names = Set(pending.flatMap { [$0.payer] + $0.splits.map(\.name) })
                        let new = names.filter { name in !current.members.contains { $0.name.caseInsensitiveCompare(name) == .orderedSame } }.sorted()
                        Text("\(pending.count) entries · \(new.isEmpty ? "All members matched" : "New placeholders: " + new.joined(separator: ", "))")
                        ForEach(Array(pending.prefix(5).enumerated()), id: \.offset) { _, row in
                            LabeledContent(row.title, value: Money.text(row.amount, row.currency)).font(.caption)
                        }
                        Button("Confirm import") {
                            run {
                                let data = try await store.groupAction(current.id, "import", ["rows": try JSONSerialization.jsonObject(with: JSONEncoder().encode(pending))])
                                struct Result: Decodable { var inserted: Int }
                                let result = try JSONDecoder().decode(Result.self, from: data)
                                message = "Imported \(result.inserted) entries. Skipped \(pending.count - result.inserted) duplicates."
                                pending = []
                            }
                        }
                        Button("Discard preview", role: .cancel) { pending = [] }
                    }
                } header: {
                    Text("Ledger CSV")
                } footer: {
                    Text("Import up to 80 expenses or payments. Unmatched names become placeholders. Review the preview before applying.")
                }

                Section {
                    NavigationLink {
                        GroupPDFExportView(groupID: current.id)
                    } label: {
                        Label("Export PDF", systemImage: "doc.richtext")
                    }
                } footer: {
                    Text("Choose which sections and spending breakdowns to include.")
                }

                Section {
                    Button(isArchived ? "Unarchive group" : "Archive group") { confirmArchive = true }
                    Button("Leave group", role: .destructive) { confirmLeave = true }
                    if current.canDelete == true || store.isDemo {
                        Button("Delete group", role: .destructive) { confirmDelete = true }
                    }
                } footer: {
                    Text(isArchived ? "This group is archived and hidden from your lists." : "Archiving hides the group without deleting its history. Leaving removes your access.")
                }

                if let error { Section { InlineError(text: error) } }
                if let message { Section { Label(message, systemImage: "checkmark.circle.fill").foregroundStyle(Palette.evergreen) } }
            }
            .scrollContentBackground(.hidden)
            .background(AppBackground())
            .navigationTitle("Group settings")
            .navigationBarTitleDisplayMode(.inline)
            .disabled(busy)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onAppear(perform: load)
            .confirmationDialog("Archive this group?", isPresented: $confirmArchive, titleVisibility: .visible) {
                Button(isArchived ? "Unarchive" : "Archive") {
                    run {
                        try await store.setArchived(current, archived: !isArchived)
                        message = isArchived ? "Group restored." : "Group archived."
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(isArchived ? "It will return to your groups list." : "You can restore it from the archived list later.")
            }
            .confirmationDialog("Leave this group?", isPresented: $confirmLeave, titleVisibility: .visible) {
                Button("Leave group", role: .destructive) {
                    run { try await store.leaveGroup(current); dismiss() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("You will lose access to its expenses. The group keeps its history for everyone else.")
            }
            .confirmationDialog("Delete \(current.name)?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete group", role: .destructive) {
                    run { try await store.deleteGroup(current); dismiss() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This permanently removes the group, its expenses, receipts, and payments for everyone.")
            }
            .fileExporter(isPresented: $exporting, document: export?.file, contentType: export?.type ?? .commaSeparatedText, defaultFilename: export?.name) {
                if case .failure(let error) = $0 { self.error = error.localizedDescription }
            }
            .fileImporter(isPresented: $choose, allowedContentTypes: [.commaSeparatedText, .plainText]) { result in
                do {
                    pending = []; error = nil; message = nil
                    let url = try result.get(), access = url.startAccessingSecurityScopedResource()
                    defer { if access { url.stopAccessingSecurityScopedResource() } }
                    guard let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 512000 else {
                        throw LedgerError.invalid("Choose a file under 500 KiB.")
                    }
                    let data = try Data(contentsOf: url)
                    guard let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .utf16) else {
                        throw LedgerError.invalid("Choose a UTF-8 or UTF-16 CSV file.")
                    }
                    pending = try LedgerCSV.parse(text, defaultCurrency: current.currency)
                } catch { self.error = error.localizedDescription }
            }
        }
    }

    private func load() {
        guard !initialized else { return }
        initialized = true
        name = current.name
        description = current.description ?? ""
        start = current.startDate.flatMap(Exchange.date(fromDay:))
        end = current.endDate.flatMap(Exchange.date(fromDay:))
        currency = current.currency
        simplify = current.simplify ?? true
        let defaults = current.defaultWeights ?? [:]
        weights = Dictionary(uniqueKeysWithValues: current.members.map { ($0.id, String(defaults.isEmpty ? 1 : defaults[$0.id] ?? 0)) })
    }

    private func run(_ work: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true; error = nil; message = nil
        Task {
            defer { busy = false }
            do { try await work() }
            catch { self.error = error.localizedDescription }
        }
    }
}

struct PaymentActions: View {
    var member: Person
    var currency: String
    var amount: String

    var body: some View {
        let methods = member.availablePaymentMethods
        if !methods.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Divider()
                Text("Pay \(member.name)").font(.subheadline.weight(.semibold))
                PaymentOptions(methods: methods, amount: Money.parse(amount), currency: currency)
                Text("Confirm the recipient and \(currency) \(amount) in your payment app. Return here to record the completed payment.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
