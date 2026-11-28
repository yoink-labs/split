import SwiftUI

struct DailyCostsView: View {
    var scope: AnalyticsScope
    var initialPerson: String? = nil
    var from = ""
    var to = ""
    @State private var useHome = false
    @EnvironmentObject private var fx: FXStore
    @State private var selection: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let person = scope.members.first { $0.key == selection }
            ?? scope.members.first { $0.key == initialPerson }
            ?? scope.members.first
        let relevant = scope.entries.filter { entry in
            entry.isSpending && entry.splits.contains { scope.personKey(entry.groupID, $0.memberID) == person?.key }
        }
        let projected = useHome ? relevant.compactMap(fx.homeEntry) : relevant
        let days = person.map {
            DailyCost.report(projected, person: $0.key, key: scope.personKey).filter { day in
                (from.isEmpty || day.day >= from) && (to.isEmpty || day.day <= to)
            }
        } ?? []
        NavigationStack {
            List {
                if let person {
                    Picker("Person", selection: Binding(get: { person.key }, set: { selection = $0 })) {
                        ForEach(scope.members) { member in
                            Text(member.name).tag(member.key)
                        }
                    }
                }
                Toggle("Show home currency (\(fx.home))", isOn: $useHome)
                if useHome {
                    Text("Foreign costs use exchange rates or the recorded card charge.")
                        .font(.caption)
                    if projected.count < relevant.count {
                        Text("\(relevant.count - projected.count) expenses omitted because a rate is unavailable.")
                    }
                }
                if days.isEmpty {
                    ContentUnavailableView("No daily costs", systemImage: "calendar")
                }
                ForEach(days) { day in
                    Section {
                        ForEach(day.lines) { line in
                            LabeledContent(line.title, value: Money.text(line.amount, day.currency))
                        }
                    } header: {
                        LabeledContent(
                            ExpenseSpread.localDate(day.day)?.formatted(date: .abbreviated, time: .omitted) ?? day.day,
                            value: Money.text(day.amount, day.currency)
                        )
                    }
                }
            }
            .navigationTitle("Daily costs")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
