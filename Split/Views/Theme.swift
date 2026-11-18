import SwiftUI
enum Palette {
    static let green = Color(light: UIColor(red:0.12,green:0.30,blue:0.24,alpha:1), dark: UIColor(red:0.58,green:0.85,blue:0.70,alpha:1))
    static let background = Color(light: UIColor(red:0.97,green:0.97,blue:0.95,alpha:1), dark: UIColor(red:0.06,green:0.08,blue:0.07,alpha:1))
    static let card = Color(light: .white, dark: UIColor(red:0.11,green:0.14,blue:0.12,alpha:1))
    static let muted = Color.secondary
    static let lime = Color(red:0.80,green:0.93,blue:0.53)
    static let ink = Color(red:0.09,green:0.22,blue:0.17)
}
extension Color {
    init(light: UIColor, dark: UIColor) { self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? dark : light }) }
}
struct SolidButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.headline).frame(maxWidth:.infinity).padding(.vertical,9).frame(minHeight:44).background(Palette.green).foregroundStyle(Palette.background).clipShape(RoundedRectangle(cornerRadius:12)).opacity(configuration.isPressed ? 0.7 : 1)
    }
}
struct Avatar: View {
    var name: String; var size: CGFloat = 40
    var body: some View { Text(String(name.prefix(1)).uppercased()).font(.system(size:size*0.38,weight:.semibold,design:.rounded)).frame(width:size,height:size).background(Palette.green.opacity(0.10)).foregroundStyle(Palette.green).clipShape(Circle()).accessibilityHidden(true) }
}
struct Card<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View { VStack(alignment: .leading, spacing: 0) { content }.padding(14).frame(maxWidth:.infinity,alignment:.leading).background(Palette.card).clipShape(RoundedRectangle(cornerRadius:15)) }
}
struct ErrorText: View { var text: String; var body: some View { Label(text,systemImage:"exclamationmark.circle").font(.subheadline).foregroundStyle(.red).fixedSize(horizontal:false,vertical:true).accessibilityIdentifier("error-message") } }
