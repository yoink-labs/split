import { Picker } from "./picker";
import { useState } from "react";
import { Form } from "./context";
import type { PaymentMethod, Person } from "./data";

const platforms = [
  ["zelle", "Zelle", "Email or phone number"],
  ["venmo", "Venmo", "Username or profile link"],
  ["paypal", "PayPal", "PayPal.Me username, link, or email"],
  ["cashapp", "Cash App", "$Cashtag or profile link"],
  ["applecash", "Apple Cash", "Email or phone number"],
  ["wise", "Wise", "Wisetag or payment link"],
  ["revolut", "Revolut", "Revtag or payment link"],
  ["mercado", "Mercado Pago", "Payment link or handle", "mercadopago"],
  ["alias", "Argentine alias / CVU", "Alias or CVU"],
  ["pix", "Pix", "Pix key"],
  ["interac", "Interac e-Transfer", "Email or phone number"],
  ["bank", "Bank transfer", "Transfer details"],
  ["sepa", "SEPA transfer", "IBAN or payment details"],
  ["upi", "UPI", "UPI ID"],
  ["googlepay", "Google Pay", "UPI ID, email, or phone number"],
  ["phonepe", "PhonePe", "UPI ID or phone number"],
  ["paytm", "Paytm", "UPI ID or phone number"],
  ["alipay", "Alipay", "Account ID or phone number"],
  ["wechat", "WeChat Pay", "WeChat ID"],
  ["gcash", "GCash", "Phone number or username"],
  ["payid", "PayID", "Email or phone number"],
  ["tikkie", "Tikkie", "Payment link"],
  ["mobilepay", "MobilePay", "Phone number or payment link"],
  ["swish", "Swish", "Phone number"],
  ["m-pesa", "M-PESA", "Phone number"],
  ["bizum", "Bizum", "Phone number"],
  ["promptpay", "PromptPay", "PromptPay ID"],
  ["paynow", "PayNow", "PayNow ID"],
  ["kakaopay", "Kakao Pay", "Account or phone number"],
] as const;

const logos = import.meta.glob("../../Split/Resources/Assets.xcassets/Payment-*.imageset/logo.svg", {
  eager: true, query: "?url", import: "default",
}) as Record<string, string>;

function platformInfo(id: string) {
  return platforms.find(([key]) => key === id);
}

type Draft = PaymentMethod & { id: string; choice: string };

function drafts(methods: PaymentMethod[]): Draft[] {
  return methods.map((method) => ({ ...method, id: crypto.randomUUID(), choice: platformInfo(method.platform) ? method.platform : "" }));
}

export function PaymentEditor({ initial, defaults, save, shareWithFriends }: {
  initial?: PaymentMethod[];
  defaults?: PaymentMethod[];
  save: (methods: PaymentMethod[] | null, shareWithFriends?: boolean) => Promise<void>;
  shareWithFriends?: boolean;
}) {
  const group = defaults !== undefined;
  const [inherit, setInherit] = useState(group && initial === undefined);
  const [rows, setRows] = useState(() => drafts(initial ?? defaults ?? []));
  const [sharing, setSharing] = useState(shareWithFriends ?? false);
  const [saved, setSaved] = useState(false);

  function edit(id: string, change: Partial<Draft>) {
    setSaved(false);
    setRows((current) => current.map((row) => row.id === id ? { ...row, ...change } : row));
  }

  return (
    <Form label="Save payment methods" submit={async () => {
      setSaved(false);
      await save(inherit ? null : rows.map(({ platform, handle, preferred }) => ({
        platform: platform.trim(), handle: handle.trim(), ...(preferred ? { preferred } : {}),
      })), group ? undefined : sharing);
      setSaved(true);
    }}>
      <p className="muted">{group
        ? "Choose what this group sees in member profiles and when settling up."
        : "Active members of your groups can see these details. You can change what you share in each group."}</p>
      {!group && <label className="check-row">
        <input type="checkbox" checked={sharing} onChange={(event) => {
          setSharing(event.target.checked);
          setSaved(false);
        }} />
        <span>Share my profile payment methods with accepted friends</span>
      </label>}
      {group && (
        <label>
          <input type="checkbox" checked={inherit} onChange={(e) => { setInherit(e.target.checked); setSaved(false); }} />
          {" "}Use my profile payment methods
        </label>
      )}
      {!inherit && (
        <>
          {rows.map((row, index) => (
            <div className="payment-editor-row form-stack" key={row.id}>
              <div className="form-row">
                <div className="field">
                  Platform
                  <Picker label="Platform" value={row.choice} search onChange={(choice) => edit(row.id, { choice, platform: choice })} options={[{ value: "", label: "Custom platform" }, ...platforms.map(([value, label]) => ({ value, label }))]} />
                </div>
                {!row.choice && (
                  <label className="field">
                    Platform name
                    <input required maxLength={60} value={row.platform} onChange={(e) => edit(row.id, { platform: e.target.value })} />
                  </label>
                )}
                <label className="field">
                  Payment handle
                  <input required maxLength={500} value={row.handle} autoCapitalize="none" spellCheck={false}
                    placeholder={platformInfo(row.choice)?.[2] ?? "Username, ID, or payment link"}
                    onChange={(e) => edit(row.id, { handle: e.target.value })} />
                </label>
              </div>
              <div className="payment-editor-actions">
                <label>
                  <input type="checkbox" checked={row.preferred === true} onChange={(e) => {
                    setSaved(false);
                    setRows(rows.map((method) => ({ ...method, preferred: e.target.checked && method.id === row.id })));
                  }} />
                  {" "}Preferred
                </label>
                <button type="button" className="btn btn-xs" aria-label={`Remove payment method ${index + 1}`}
                  onClick={() => { setRows(rows.filter((method) => method.id !== row.id)); setSaved(false); }}>Remove</button>
              </div>
            </div>
          ))}
          {group && rows.length === 0 && <p className="muted">No payment methods will be shared in this group.</p>}
          <div>
            <button type="button" className="btn btn-sm" disabled={rows.length >= 20} onClick={() => {
              setRows([...rows, { id: crypto.randomUUID(), choice: "zelle", platform: "zelle", handle: "" }]);
              setSaved(false);
            }}>Add payment method</button>
          </div>
        </>
      )}
      {saved && <p className="ok-banner" role="status">Payment methods saved.</p>}
    </Form>
  );
}

export function personPaymentMethods(person: Person): PaymentMethod[] {
  if (person.removed) return [];
  return person.paymentMethods ?? Object.entries(person.payment ?? {}).map(([platform, handle]) => ({ platform, handle }));
}

function paymentURL({ platform, handle }: PaymentMethod, amount?: number, currency?: string) {
  const domains: Record<string, string[]> = {
    venmo: ["venmo.com", "www.venmo.com"],
    paypal: ["paypal.me", "www.paypal.me", "paypal.com", "www.paypal.com"],
    cashapp: ["cash.app"],
    wise: ["wise.com", "www.wise.com"],
    revolut: ["revolut.me"],
    mercado: ["link.mercadopago.com.ar", "mpago.la", "mpago.ar", "link.mercadopago.com.br"],
    tikkie: ["tikkie.me", "www.tikkie.me"],
  };
  try {
    const url = new URL(handle);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port &&
        Object.hasOwn(domains, platform) && domains[platform].includes(url.hostname)) return url.href;
  } catch {
    // A bare handle can be used with supported profile-link formats.
  }
  if (platform === "venmo" && /^@?[\w-]+$/.test(handle)) return "https://venmo.com/u/" + handle.replace(/^@/, "");
  if (platform === "paypal" && /^[a-z\d]+$/i.test(handle)) {
    const suffix = amount && currency ? `/${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, "0")}${currency}` : "";
    return "https://paypal.me/" + handle + suffix;
  }
  if (platform === "cashapp" && /^\$[a-z\d]+$/i.test(handle)) return "https://cash.app/" + handle;
}

export function PaymentOptions({ person, methods, amount, currency }: (
  { person: Person; methods?: never } | { person?: never; methods: PaymentMethod[] }
) & { amount?: number; currency?: string }) {
  const ordered = [...(person ? personPaymentMethods(person) : methods)].sort((a, b) => Number(!!b.preferred) - Number(!!a.preferred));
  const [copyStatus, setCopyStatus] = useState("");
  if (ordered.length === 0) return null;
  return (
    <div className="payment-options">
      {ordered.map((method, index) => {
        const info = platformInfo(method.platform);
        const label = info?.[1] ?? method.platform;
        const icon = info?.[3] ?? method.platform;
        const logo = Object.hasOwn(logos, `../../Split/Resources/Assets.xcassets/Payment-${icon}.imageset/logo.svg`)
          ? logos[`../../Split/Resources/Assets.xcassets/Payment-${icon}.imageset/logo.svg`] : undefined;
        const link = paymentURL(method, amount, currency);
        return (
          <div className="payment-option" key={index}>
            {logo && <img className="payment-logo" src={logo} alt="" />}
            <div className="payment-handle">
              <strong>{label}</strong>{method.preferred && <span className="tag">Preferred</span>}
              <div className="muted">{method.handle}</div>
            </div>
            {link && <a className="btn btn-xs" href={link} target="_blank" rel="noreferrer" aria-label={`Open ${label}`}>Open</a>}
            <button className="btn btn-xs" type="button" aria-label={`Copy ${label} handle`} onClick={async () => {
              try {
                await navigator.clipboard.writeText(method.handle);
                setCopyStatus(`${label} handle copied.`);
              } catch {
                setCopyStatus("Couldn’t copy. Select the handle to copy it.");
              }
            }}>Copy</button>
          </div>
        );
      })}
      {copyStatus && <div className="muted" role="status">{copyStatus}</div>}
    </div>
  );
}
