import { GroupTypePicker } from "./tripFields";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Form, useLedger, value } from "./context";
import type { Group } from "./data";
import { rateE8, rateInput, rateText } from "./fx";
import { CurrencySelect } from "./fxui";
import { PaymentEditor } from "./paymentMethods";

export function SettingsCard({ id, title, description, children }: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="card settings-card" id={id} aria-labelledby={id + "-title"}>
      <header>
        <h3 id={id + "-title"}>{title}</h3>
        {description && <p className="muted">{description}</p>}
      </header>
      <div className="settings-card-body">{children}</div>
    </section>
  );
}

function TripRates({ group, canEdit }: { group: Group; canEdit: boolean }) {
  const { save } = useLedger();
  const [currency, setCurrency] = useState(() => Object.keys(group.tripRates ?? {})[0] ?? (group.currency === "USD" ? "EUR" : "USD"));
  const rates = Object.entries(group.tripRates ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const current = group.tripRates?.[currency];

  return (
    <SettingsCard
      id="exchange-rates" title="Exchange rates"
      description={`Set default rates into ${group.currency} for new expenses. Saved expenses keep the rate they used.`}
    >
      {canEdit && (
        <Form
          key={currency + "|" + (current ?? "")}
          label="Save trip rate"
          submit={async (form) => {
            const input = value(form, "rate");
            const rate = rateE8(input);
            if (input && !rate) throw new Error("Enter a positive exchange rate.");
            await save(`/v1/groups/${group.id}/trip-rate`, { currency, target: group.currency, rateE8: rate });
          }}
        >
          <div className="settings-rate-fields">
            <CurrencySelect label="Expense currency" value={currency} onChange={setCurrency} exclude={group.currency} />
            <label className="field">
              {group.currency} per 1 {currency}
              <input type="text" name="rate" inputMode="decimal"
                defaultValue={current ? rateInput(current) : ""} />
              <small>Clear the rate and save to use published rates again.</small>
            </label>
          </div>
        </Form>
      )}
      {rates.length === 0 ? <p className="muted">No custom rates saved.</p> : (
        <ul className="trip-rate-list">
          {rates.map(([code, rate]) => (
            <li key={code} className="num">
              {canEdit ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCurrency(code)} aria-label={`Edit ${code} trip rate`}>
                1 {code} = {rateText(rate)} {group.currency}
              </button> : <>1 {code} = {rateText(rate)} {group.currency}</>}
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}

export function GroupSettings({ g, showRates }: { g: Group; showRates: boolean }) {
  const { data, user, save } = useLedger();
  const navigate = useNavigate();
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const me = g.members.find((m) => m.userID === user);
  const [kind, setKind] = useState(g.kind === "trip" ? "trip" : "home");
  const [settingsSaved, setSettingsSaved] = useState(false);

  useEffect(() => {
    if (showRates) document.getElementById("exchange-rates")?.scrollIntoView();
  }, [showRates]);

  return (
    <section className="group-settings" aria-labelledby="group-settings-title">
      <header className="workspace-section-head">
        <h2 id="group-settings-title">Settings</h2>
        <p className="muted">Manage this group and how you settle up.</p>
      </header>
      <nav className="settings-links" aria-label="Settings sections">
        <a href="#group-details">Group details</a>
        {g.kind === "trip" && <a href="#exchange-rates">Exchange rates</a>}
        {me && !me.removed && <a href="#payment-handles">Payment methods</a>}
        {g.canDelete && <a href="#delete-group">Delete group</a>}
      </nav>
      <div className="settings-grid">
        <SettingsCard id="group-details" title="Group details" description="Edit the name, type, description, and dates.">
          <Form
            label="Save group details"
            submit={async (f) => {
              if (kind === "trip" && value(f, "endDate") && value(f, "endDate") < value(f, "startDate"))
                throw new Error("End date must be on or after the start date.");
              await save(`/v1/groups/${g.id}/update`, {
                kind: g.kind === "friend" ? undefined : kind,
                name: value(f, "name"),
                description: value(f, "description"),
                startDate: kind === "trip" ? value(f, "startDate") || null : undefined,
                endDate: kind === "trip" ? value(f, "endDate") || null : undefined,
              });
              setSettingsSaved(true);
              setTimeout(() => setSettingsSaved(false), 2000);
            }}
          >
            <label className="field">
              Name
              <input type="text" name="name" defaultValue={g.name} required maxLength={80} />
            </label>
            <label className="field">
              Description
              <textarea name="description" defaultValue={g.description ?? ""} maxLength={400} placeholder="Notes about this trip or household…" />
            </label>
            {g.kind !== "friend" && <GroupTypePicker value={kind} onChange={setKind} />}
            {kind === "trip" && <div className="form-row">
              <label className="field">
                Start date
                <input type="date" name="startDate" required={g.kind !== "trip"} defaultValue={g.startDate ?? ""} />
              </label>
              <label className="field">
                End date
                <input type="date" name="endDate" required={g.kind !== "trip"} defaultValue={g.endDate ?? ""} />
              </label>
            </div>}
            {settingsSaved && <p className="ok-banner">Saved group details</p>}
          </Form>
        </SettingsCard>
        {g.kind === "trip" && <TripRates group={g} canEdit={!!me && !me.removed} />}
        {me && !me.removed && (
          <SettingsCard id="payment-handles" title="Your payment methods">
            <PaymentEditor initial={me.paymentOverride} defaults={data.paymentMethods ?? []}
              save={(methods) => save(`/v1/groups/${g.id}/payment-profile`, { methods })} />
          </SettingsCard>
        )}
        {g.canDelete && (
          <SettingsCard id="delete-group" title="Delete group"
            description="Permanently remove the group, its expenses, receipts, and payments for everyone.">
            <div>
              <button className="btn btn-danger" type="button" onClick={() => deleteDialog.current?.showModal()}>
                Delete group
              </button>
            </div>
            <dialog ref={deleteDialog} className="modal group-delete-dialog" aria-labelledby="delete-group-confirmation">
              <Form label="Delete group" destructive cancel={() => deleteDialog.current?.close()} submit={async () => {
                await save(`/v1/groups/${g.id}/delete`, {});
                navigate("/", { replace: true });
              }}>
                <h2 id="delete-group-confirmation">Delete {g.name}?</h2>
                <p>This permanently removes the group, its expenses, receipts, and payments for everyone.</p>
              </Form>
            </dialog>
          </SettingsCard>
        )}
      </div>

    </section>
  );
}
