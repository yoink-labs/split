import SwiftUI

struct CreateGroupView: View {
    var friend: Bool
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var store: ExpenseStore
    @Environment(\.dismiss) var dismiss
    @State private var name = ""
    @State private var people: [MemberDraft] = []
    @State private var choosing = false
    @State private var kind = "trip"
    @AppStorage("split.defaultCurrency") private var preferredCurrency = "USD"
    @State private var currency = ""
    @State private var error: String?
    @State private var saving = false

    private var cleanName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canCreate: Bool {
        !cleanName.isEmpty && cleanName.count <= 80 && people.count <= 49 && people.allSatisfy { $0.name.count <= 60 }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Card {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(friend ? "Who’s the tab with?" : "What are you sharing?")
                                .font(.headline)
                                .foregroundStyle(Palette.ink)
                            TextField(friend ? "Friend’s name" : "Group name", text: $name)
                                .font(.splitDisplay(22))
                                .textInputAutocapitalization(.words)
                                .accessibilityIdentifier("group-name")
                            if !friend {
                                Picker("Type", selection: $kind) {
                                    Text("Trip").tag("trip")
                                    Text("Home").tag("home")
                                }
                                .pickerStyle(.segmented)
                            }
                            Picker("Currency", selection: $currency) {
                                ForEach(Money.currencies, id: \.self) { Text($0).tag($0) }
                            }
                            .accessibilityLabel("Group currency")
                        }
                    }

                    Card {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                Text("People").font(.headline).foregroundStyle(Palette.ink)
                                Spacer()
                                Text("\(people.count + 1) including you").font(.caption).foregroundStyle(.secondary)
                            }
                            HStack(spacing: 10) {
                                Avatar(name: session.displayName, size: 38)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("You").font(.subheadline.weight(.semibold))
                                    Text("You can change the split on every expense").font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                            ForEach(people, id: \.id) { person in
                                HStack(spacing: 10) {
                                    Avatar(name: person.name, size: 36)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(person.name).font(.subheadline.weight(.medium))
                                        if let email = person.email, !email.isEmpty {
                                            Text(email).font(.caption).foregroundStyle(.secondary)
                                        } else if let phone = person.phone, !phone.isEmpty {
                                            Text(phone).font(.caption).foregroundStyle(.secondary)
                                        } else if person.userID != nil {
                                            Text("Split account").font(.caption).foregroundStyle(.secondary)
                                        } else {
                                            Text("Placeholder · can claim later").font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer()
                                    Button(role: .destructive) { people.removeAll { $0.id == person.id } } label: {
                                        Image(systemName: "minus.circle")
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel("Remove \(person.name)")
                                }
                            }
                            Button { choosing = true } label: {
                                Label(friend ? "Choose friend" : "Add person", systemImage: "person.badge.plus")
                            }
                            .buttonStyle(GhostButton())
                            Text(friend ? "Choose a Split user, or enter a name to invite them later." : "People can join later with a link or code. Placeholders keep the math moving now.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }

                    if let error { InlineError(text: error) }
                    Button { save() } label: {
                        Label(saving ? "Creating…" : (friend ? "Create tab" : "Create group"), systemImage: "checkmark")
                    }
                    .buttonStyle(SolidButton())
                    .disabled(!canCreate || saving)
                }
                .padding(16)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .background(AppBackground())
            .navigationTitle(friend ? "New friend" : "New group")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .onAppear {
                guard currency.isEmpty else { return }
                let localeCurrency = Locale.current.currency?.identifier ?? ""
                currency = Money.currencies.contains(preferredCurrency) ? preferredCurrency : (Money.currencies.contains(localeCurrency) ? localeCurrency : "USD")
            }
            .sheet(isPresented: $choosing) {
                MemberEditor { draft in
                    if let id = draft.userID, people.contains(where: { $0.userID == id }) {
                        throw LedgerError.invalid("This person is already included.")
                    }
                    people.append(draft)
                    if friend { name = draft.name }
                }
            }
        }
    }

    private func save() {
        let clean = cleanName
        let participants = friend && people.isEmpty ? [MemberDraft(name: clean)] : people
        guard !clean.isEmpty, clean.count <= 80, participants.count <= 49, participants.allSatisfy({ $0.name.count <= 60 }), let id = session.userID else {
            error = "Use a shorter name and up to 49 other people."; return
        }
        saving = true; error = nil
        do {
            try store.create(name: clean, kind: friend ? "friend" : kind, currency: currency, people: participants, userID: id, displayName: session.displayName)
            dismiss()
        } catch {
            saving = false
            self.error = error.localizedDescription
        }
    }
}
