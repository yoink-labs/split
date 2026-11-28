import SwiftUI
import UniformTypeIdentifiers

struct GroupPDFExportView: View {
    let groupID: String

    @EnvironmentObject private var store: ExpenseStore
    @EnvironmentObject private var fx: FXStore
    @State private var sections = GroupSummaryPDF.Sections()
    @State private var layout: GroupSummaryPDF.Layout = .receipts
    @State private var exporting = false
    @State private var document: LedgerExportFile?
    @State private var filename = ""
    @State private var error: String?

    var body: some View {
        Form {
            Section("Report sections") {
                Toggle("Expense totals", isOn: $sections.totals)
                Toggle("Balances and suggested payments", isOn: $sections.balances)
                Toggle("Transaction history", isOn: $sections.history)
                if sections.history {
                    Picker("History detail", selection: $layout) {
                        ForEach(GroupSummaryPDF.Layout.allCases, id: \.self) { option in
                            Text(option.rawValue).tag(option)
                        }
                    }
                }
            }
            Section {
                Toggle("By category", isOn: $sections.categories)
                Toggle("By month", isOn: $sections.months)
                Toggle("By person", isOn: $sections.people)
            } header: {
                Text("Spending breakdowns")
            } footer: {
                Text("Breakdowns use the recorded currencies. The person breakdown shows how much each person paid and their share.")
            }
            Section {
                Button("Export PDF", systemImage: "square.and.arrow.up", action: export)
                    .disabled(sections.isEmpty || store.group(groupID) == nil)
            }
            if let error { Section { InlineError(text: error) } }
        }
        .scrollContentBackground(.hidden)
        .background(AppBackground())
        .navigationTitle("Export PDF")
        .navigationBarTitleDisplayMode(.inline)
        .fileExporter(isPresented: $exporting, document: document, contentType: .pdf, defaultFilename: filename) { result in
            if case .failure(let error) = result { self.error = error.localizedDescription }
        }
    }

    private func export() {
        guard let group = store.group(groupID) else { return }
        error = nil
        do {
            let data = try GroupSummaryPDF.render(group: group, entries: store.entries(in: group), fx: fx,
                                                  layout: layout, sections: sections)
            document = LedgerExportFile(data: data)
            filename = "\(group.name) – \(sections.history ? layout.rawValue : "Group report")"
            exporting = true
        } catch {
            self.error = error.localizedDescription
        }
    }
}
