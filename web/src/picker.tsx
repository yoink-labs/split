import { useId, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Link } from "react-router-dom";

export type PickOption = { value: string; label: string; icon?: ReactNode };
type MenuLink = { to: string; label: string; hint?: string };

type PickerProps = {
  label: string;
  value: string;
  options: PickOption[];
  onChange: (value: string) => void;
  search?: boolean;
  disabled?: boolean;
  name?: string;
  required?: boolean;
};

type NavigationMenuProps = {
  label: string;
  trigger: ReactNode;
  links: MenuLink[];
  current: string;
  onNavigate: () => void;
};

export function Picker(props: PickerProps) {
  return <Dropdown {...props} />;
}

export function NavigationMenu(props: NavigationMenuProps) {
  return <Dropdown {...props} />;
}

function Dropdown(props: PickerProps | NavigationMenuProps) {
  const picker = "options" in props ? props : undefined;
  const navigation = "links" in props ? props : undefined;
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [invalid, setInvalid] = useState(false);
  const expanded = open && !picker?.disabled;
  const current = picker?.options.find((option) => option.value === picker.value);
  const matches = picker?.options.filter((option) => option.label.toLowerCase().includes(query.trim().toLowerCase()));

  useLayoutEffect(() => {
    if (!expanded || !panel.current || !trigger.current) return;
    const popup = panel.current;
    const button = trigger.current;
    popup.showPopover?.();

    function position() {
      if (window.matchMedia("(max-width: 640px)").matches) return;
      const anchor = button.getBoundingClientRect();
      const width = Math.min(Math.max(anchor.width, 218), window.innerWidth - 24);
      const left = Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12));
      popup.style.setProperty("--picker-left", left + "px");
      popup.style.setProperty("--picker-width", width + "px");
      const below = window.innerHeight - anchor.bottom;
      const above = anchor.top;
      const height = popup.getBoundingClientRect().height;
      const top = below >= height + 12 || below >= above ? anchor.bottom + 6 : anchor.top - height - 6;
      popup.style.setProperty("--picker-top", Math.max(8, top) + "px");
    }

    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const focusTarget = picker?.search && !window.matchMedia("(pointer: coarse)").matches ? popup.querySelector("input")
      : popup.querySelector<HTMLElement>('[aria-pressed="true"], [aria-current="page"]')
        ?? popup.querySelector<HTMLElement>("button, a");
    position();
    focusTarget?.focus({ preventScroll: true });
    const observer = new ResizeObserver(position);
    observer.observe(popup);
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      popup.hidePopover?.();
      observer.disconnect();
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [expanded, picker?.search]);

  function close() {
    trigger.current?.focus({ preventScroll: true });
    setOpen(false);
  }

  const display = current?.label ?? picker?.value;
  return (
    <div className="picker" ref={root}
      onBlur={(event) => {
        // Safari can blur a search field without focusing the option being clicked.
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (!expanded) {
          if ((event.key === "ArrowDown" || event.key === "ArrowUp") && event.target === trigger.current && !picker?.disabled) {
            event.preventDefault();
            setQuery("");
            setOpen(true);
          }
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          panel.current?.querySelector("button")?.click();
        } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) &&
          (!(event.target instanceof HTMLInputElement) || event.key.startsWith("Arrow"))) {
          const choices = Array.from(panel.current?.querySelectorAll<HTMLElement>("input, button, a") ?? []);
          if (!choices.length) return;
          const index = choices.indexOf(document.activeElement as HTMLElement);
          const next = event.key === "Home" ? (picker?.search ? 1 : 0) : event.key === "End" ? choices.length - 1
            : index < 0 ? 0 : (index + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length;
          event.preventDefault();
          choices[next]?.focus();
        }
      }}>
      {picker?.required
        ? <input className="picker-validation" aria-hidden="true" tabIndex={-1} name={picker.name}
            value={picker.value} onChange={() => {}} required disabled={picker.disabled}
            onInvalid={(event) => {
              event.preventDefault();
              setInvalid(true);
              trigger.current?.focus();
            }} />
        : picker?.name && <input type="hidden" name={picker.name} value={picker.value} disabled={picker.disabled} />}
      <button type="button" className={navigation ? "picker-trigger user-pill" : "picker-trigger"}
        ref={trigger} disabled={picker?.disabled} aria-label={display ? props.label + ": " + display : props.label}
        aria-invalid={invalid || undefined} aria-describedby={invalid ? id + "-error" : undefined}
        aria-expanded={expanded} aria-controls={expanded ? id : undefined}
        onClick={() => { setQuery(""); setOpen(!expanded); }}>
        {navigation?.trigger ?? <>{current?.icon}<span>{display}</span></>}<i aria-hidden="true" />
      </button>
      {invalid && <small id={id + "-error"} role="alert">Choose an option.</small>}
      {expanded && (
        <div className="picker-panel" id={id} ref={panel} popover="manual" role="group" aria-label={props.label}>
          {picker?.search && (
            <input type="search" value={query} aria-label={"Search " + props.label.toLowerCase().replace(/^filter by /, "")}
              placeholder="Search…" onChange={(event) => setQuery(event.target.value)} />
          )}
          <div className="picker-options">
            {matches?.map((option) => (
              <button key={option.value} type="button" aria-pressed={option.value === picker?.value}
                onClick={() => {
                  close();
                  setInvalid(false);
                  picker?.onChange(option.value);
                }}>
                {option.icon}<span>{option.label}</span>
                {option.value === picker?.value && <b aria-hidden="true">✓</b>}
              </button>
            ))}
            {matches?.length === 0 && <p className="muted">No matches</p>}
            {navigation?.links.map((link) => <Link key={link.to} to={link.to}
              aria-current={link.to === navigation.current ? "page" : undefined}
              onClick={() => { close(); navigation.onNavigate(); }}>
              <strong>{link.label}</strong><small className="muted">{link.hint}</small>
            </Link>)}
          </div>
        </div>
      )}
    </div>
  );
}

export function FormPicker({ defaultValue, ...props }: Omit<ComponentProps<typeof Picker>, "value" | "onChange"> & {
  defaultValue: string;
}) {
  const [value, setValue] = useState(defaultValue);
  const selected = props.options.some((option) => option.value === value) ? value : defaultValue;
  return <Picker {...props} value={selected} onChange={setValue} />;
}
