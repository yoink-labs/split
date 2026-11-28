import Foundation

struct PaymentMethod: Codable, Hashable {
    var platform: String
    var handle: String
    var preferred: Bool? = nil

    var info: PaymentPlatform? { PaymentPlatform.catalog.first { $0.id == platform } }
    var name: String { info?.name ?? platform }

    func url(amount: Int64? = nil, currency: String? = nil) -> URL? {
        let domains: [String: Set<String>] = [
            "venmo": ["venmo.com", "www.venmo.com"],
            "paypal": ["paypal.me", "www.paypal.me", "paypal.com", "www.paypal.com"],
            "cashapp": ["cash.app"],
            "wise": ["wise.com", "www.wise.com"],
            "revolut": ["revolut.me"],
            "mercado": ["link.mercadopago.com.ar", "mpago.la", "mpago.ar", "link.mercadopago.com.br"],
            "tikkie": ["tikkie.me", "www.tikkie.me"]
        ]
        if let url = URL(string: handle), url.scheme?.lowercased() == "https",
           url.user == nil, url.password == nil, url.port == nil,
           let host = url.host?.lowercased(), domains[platform]?.contains(host) == true {
            return url
        }
        switch platform {
        case "venmo" where handle.wholeMatch(of: #/@?[A-Za-z0-9_-]+/#) != nil:
            return URL(string: "https://venmo.com/u/" + (handle.hasPrefix("@") ? String(handle.dropFirst()) : handle))
        case "paypal" where handle.wholeMatch(of: #/[A-Za-z0-9]+/#) != nil:
            let suffix: String
            if let amount, amount > 0, let currency, Money.currencies.contains(currency) {
                suffix = "/\(amount / 100)." + String(format: "%02lld", amount % 100) + currency
            } else {
                suffix = ""
            }
            return URL(string: "https://paypal.me/" + handle + suffix)
        case "cashapp" where handle.wholeMatch(of: #/\$[A-Za-z0-9]+/#) != nil:
            return URL(string: "https://cash.app/" + handle)
        default:
            return nil
        }
    }
}

struct PaymentPlatform: Identifiable {
    let id: String
    let name: String
    let prompt: String
    var logo: String? = nil

    static let catalog: [PaymentPlatform] = [
        .init(id: "zelle", name: "Zelle", prompt: "Email or phone number", logo: "Payment-zelle"),
        .init(id: "venmo", name: "Venmo", prompt: "Username or profile link", logo: "Payment-venmo"),
        .init(id: "paypal", name: "PayPal", prompt: "PayPal.Me username, link, or email", logo: "Payment-paypal"),
        .init(id: "cashapp", name: "Cash App", prompt: "$Cashtag or profile link", logo: "Payment-cashapp"),
        .init(id: "applecash", name: "Apple Cash", prompt: "Email or phone number"),
        .init(id: "wise", name: "Wise", prompt: "Wisetag or payment link", logo: "Payment-wise"),
        .init(id: "revolut", name: "Revolut", prompt: "Revtag or payment link", logo: "Payment-revolut"),
        .init(id: "mercado", name: "Mercado Pago", prompt: "Payment link or handle", logo: "Payment-mercadopago"),
        .init(id: "alias", name: "Argentine alias / CVU", prompt: "Alias or CVU"),
        .init(id: "pix", name: "Pix", prompt: "Pix key", logo: "Payment-pix"),
        .init(id: "interac", name: "Interac e-Transfer", prompt: "Email or phone number"),
        .init(id: "bank", name: "Bank transfer", prompt: "Transfer details"),
        .init(id: "sepa", name: "SEPA transfer", prompt: "IBAN or payment details"),
        .init(id: "upi", name: "UPI", prompt: "UPI ID"),
        .init(id: "googlepay", name: "Google Pay", prompt: "UPI ID, email, or phone number", logo: "Payment-googlepay"),
        .init(id: "phonepe", name: "PhonePe", prompt: "UPI ID or phone number", logo: "Payment-phonepe"),
        .init(id: "paytm", name: "Paytm", prompt: "UPI ID or phone number", logo: "Payment-paytm"),
        .init(id: "alipay", name: "Alipay", prompt: "Account ID or phone number", logo: "Payment-alipay"),
        .init(id: "wechat", name: "WeChat Pay", prompt: "WeChat ID", logo: "Payment-wechat"),
        .init(id: "gcash", name: "GCash", prompt: "Phone number or username"),
        .init(id: "payid", name: "PayID", prompt: "Email or phone number"),
        .init(id: "tikkie", name: "Tikkie", prompt: "Payment link"),
        .init(id: "mobilepay", name: "MobilePay", prompt: "Phone number or payment link"),
        .init(id: "swish", name: "Swish", prompt: "Phone number"),
        .init(id: "m-pesa", name: "M-PESA", prompt: "Phone number"),
        .init(id: "bizum", name: "Bizum", prompt: "Phone number"),
        .init(id: "promptpay", name: "PromptPay", prompt: "PromptPay ID"),
        .init(id: "paynow", name: "PayNow", prompt: "PayNow ID"),
        .init(id: "kakaopay", name: "Kakao Pay", prompt: "Account or phone number"),
    ]
}
