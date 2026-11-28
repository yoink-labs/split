import SwiftUI

struct DailyCostsView: View {
    var scope: AnalyticsScope
    var initialPerson: String? = nil
    var from: String? = nil
    var to: String? = nil
    @State private var selection: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let person = scope.members.first { $0.key == selection }
            ?? scope.members.first { $0.key == initialPerson }
            ?? scope.members.first
        let days = person.map {
            DailyCost.report(scope.entries, person: $0.key, key: scope.personKey).filter { day in
                (from.map { day.day >= $0 } ?? true) && (to.map { day.day <= $0 } ?? true)
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
