import SwiftUI

struct GroupMetadataFields: View {
    @Binding var description: String
    @Binding var start: Date?
    @Binding var end: Date?
    var isTrip: Bool

    var body: some View {
        TextField("Group description", text: $description, axis: .vertical)
            .lineLimit(2...4)
            .onChange(of: description) { _, value in
                if value.count > 400 { description = String(value.prefix(400)) }
            }
        if isTrip {
            dateField("Start date", selection: $start)
            dateField("End date", selection: $end)
        }
    }

    @ViewBuilder private func dateField(_ title: String, selection: Binding<Date?>) -> some View {
        if let value = selection.wrappedValue {
            DatePicker(title, selection: Binding(get: { selection.wrappedValue ?? value },
                                                  set: { selection.wrappedValue = $0 }), displayedComponents: .date)
            Button("Clear " + title.lowercased()) { selection.wrappedValue = nil }
                .font(.footnote)
        } else {
            Button("Add " + title.lowercased(), systemImage: "calendar.badge.plus") {
                selection.wrappedValue = Date()
            }
        }
    }
}
