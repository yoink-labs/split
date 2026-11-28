import SwiftUI

struct SplitwisePersonEditor: View {
    private enum Choice: Hashable { case placeholder, me, member(String), account }

    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.dismiss) private var dismiss
    var source: String
    var members: [Person]
    var newGroup: Bool
    var save: (MemberMapping, String, String) -> Void
    @State private var choice: Choice
    @State private var name: String
    @State private var email: String
    @State private var account: SplitUser?
    @State private var query = ""
    @State private var matches: [SplitUser]?
    @State private var searching = false
    @State private var error: String?

    init(source: String, members: [Person], newGroup: Bool, mapping: MemberMapping, displayName: String, email: String,
         save: @escaping (MemberMapping, String, String) -> Void) {
        self.source = source
        self.members = members
        self.newGroup = newGroup
        self.save = save
        let choice: Choice
        var account: SplitUser?
        switch mapping {
        case .placeholder: choice = .placeholder
        case .me: choice = .me
        case .member(let id): choice = .member(id)
        case .account(let user):
            choice = .account
            account = user
        }
        _choice = State(initialValue: choice)
        _name = State(initialValue: displayName)
        _email = State(initialValue: email)
        _account = State(initialValue: account)
    }

    private var member: Person? {
        if case .member(let id) = choice { return members.first { $0.id == id } }
        return nil
    }

    private var placeholder: Bool { choice == .placeholder || (member != nil && member?.userID == nil) }

    var body: some View {
        NavigationStack {
            Form {
                Picker("Import as", selection: $choice) {
                    Text("Placeholder").tag(Choice.placeholder)
                    Text("This is me").tag(Choice.me)
                    ForEach(members) { Text($0.name).tag(Choice.member($0.id)) }
                    if !store.isDemo { Text("Link a Split account").tag(Choice.account) }
                }
                if placeholder || (choice == .me && newGroup) {
                    TextField("Name in Split", text: $name, prompt: Text(member?.name ?? source)).textContentType(.name)
                }
                if placeholder && !store.isDemo {
                    Section {
                        TextField("Invite email (optional)", text: $email)
                            .textContentType(.emailAddress).keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    } footer: { Text("Prepare a personal invite after importing.") }
                }
                if choice == .account {
                    accountSearch
                }
                if let error { InlineError(text: error) }
            }
            .navigationTitle(source)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply", action: apply).disabled(choice == .account && account == nil)
                }
            }
        }
    }

    @ViewBuilder private var accountSearch: some View {
        if let account {
            Section {
                LabeledContent("Split account", value: account.name)
                Button("Change account") {
                    self.account = nil
                    matches = nil
                }
            } footer: { Text("This account can access the group after import.") }
        } else {
            Section {
                TextField("Full email or first 3 letters of a name", text: $query)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .submitLabel(.search).onSubmit(search)
                Button("Search Split", action: search)
                    .disabled(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || searching)
                if searching { ProgressView() }
                if matches?.isEmpty == true { Text("No Split accounts found.").foregroundStyle(.secondary) }
                ForEach(matches ?? []) { user in
                    Button {
                        account = user
                    } label: {
                        Label(user.name, systemImage: "person.crop.circle")
                    }
                }
            }
        }
    }

    private func search() {
        let submitted = query
        guard !searching, !submitted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        searching = true
        matches = nil
        error = nil
        Task {
            defer { searching = false }
            do {
                let found = try await store.search(submitted)
                if query == submitted { matches = found }
            } catch {
                if query == submitted { self.error = error.localizedDescription }
            }
        }
    }

    private func apply() {
        let mapping: MemberMapping
        switch choice {
        case .placeholder: mapping = .placeholder
        case .me: mapping = .me
        case .member(let id): mapping = .member(id)
        case .account:
            guard let account else { return }
            mapping = .account(account)
        }
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !(placeholder || (choice == .me && newGroup)) || cleanName.utf16.count <= 60 else {
            error = "Enter a name of up to 60 characters."
            return
        }
        save(mapping, cleanName, email.trimmingCharacters(in: .whitespacesAndNewlines))
        dismiss()
    }
}

struct SplitwiseAnalyticsPreview: View {
    var conversion: SplitwiseConversion
    var members: [String]
    var mappedName: (String) -> String

    var body: some View {
        let expenses = conversion.settled.filter { !$0.payment }
        let payments = conversion.settled.filter(\.payment)
        let balances = SplitwiseGroup.balances(conversion.settled)[conversion.currency] ?? [:]
        let categories = Dictionary(grouping: expenses) { $0.category ?? "General" }
            .mapValues { $0.reduce(0) { $0 + $1.amount } }
            .sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }
        VStack(alignment: .leading, spacing: 8) {
            Text("Analytics preview in \(conversion.currency)").font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
            if conversion.estimated {
                Text("Estimates use published rates for each transaction’s date, or the previous available rate.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            metric("Expenses (\(expenses.count))", amount(expenses.reduce(0) { $0 + $1.amount }))
            metric("Payments (\(payments.count))", amount(payments.reduce(0) { $0 + $1.amount }))
            DisclosureGroup("Spending by category and balances") {
                VStack(alignment: .leading, spacing: 8) {
                    if !categories.isEmpty {
                        Text("Spending by category").font(.caption.weight(.semibold))
                        ForEach(categories, id: \.key) { category in metric(category.key, amount(category.value)) }
                    }
                    Text("Balances after these entries").font(.caption.weight(.semibold))
                    ForEach(members, id: \.self) { source in
                        let net = balances[source] ?? 0
                        let person = mappedName(source)
                        metric(person == source ? person : "\(person) (\(source))",
                               net == 0 ? "Settled" : (net > 0 ? "Gets back " : "Owes ") + amount(abs(net)))
                    }
                }
                .padding(.vertical, 8)
            }
        }
    }

    private func amount(_ value: Int64) -> String {
        (conversion.estimated ? "≈ " : "") + Money.text(value, conversion.currency)
    }

    private func metric(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label).font(.subheadline.weight(.medium))
            Spacer(minLength: 4)
            Text(value).font(.caption.monospacedDigit()).foregroundStyle(.secondary).multilineTextAlignment(.trailing)
        }
        .accessibilityElement(children: .combine)
    }
}

struct SplitwiseEmailInvite: View {
    @EnvironmentObject private var store: ExpenseStore
    var groupID: String
    var memberID: String
    var name: String
    @State var email: String
    @State private var link: URL?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Invite \(name)").font(.subheadline.weight(.medium))
            if let link, let draft = mailURL(link) {
                Link("Open email draft", destination: draft)
                ShareLink(item: link)
            } else {
                TextField("Email", text: $email)
                    .textContentType(.emailAddress).keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .disabled(busy)
                Button(busy ? "Preparing…" : "Prepare email invite", action: prepare)
                    .disabled(busy || email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if let error { InlineError(text: error) }
            }
        }
    }

    private func prepare() {
        busy = true
        error = nil
        email = email.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            defer { busy = false }
            do { link = try await store.invite(groupID: groupID, memberID: memberID, email: email) }
            catch { self.error = error.localizedDescription }
        }
    }

    private func mailURL(_ link: URL) -> URL? {
        var components = URLComponents()
        components.scheme = "mailto"
        components.percentEncodedPath = email.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "@.-_"))) ?? ""
        components.queryItems = [
            URLQueryItem(name: "subject", value: "Your Split invite"),
            URLQueryItem(name: "body", value: "Hi \(name),\n\nJoin our group on Split to claim your imported history.\n\n\(link.absoluteString)")
        ]
        return components.url
    }
}
