import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export type PickOption = { value: string; label: string; icon?: ReactNode };

export function Picker({
  label, value, options, onChange, search, disabled,
}: {
  label: string;
  value: string;
  options: PickOption[];
  onChange: (value: string) => void;
  search?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const expanded = open && !disabled;
  const current = options.find((option) => option.value === value);
  const matches = options.filter((option) => option.label.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    if (!expanded) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const focusTarget = search ? panel.current?.querySelector("input")
      : panel.current?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? panel.current?.querySelector("button");
    focusTarget?.focus();
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [expanded, search]);

  return (
    <div className="picker" ref={root}
      onBlur={(event) => {
        // Safari can blur a search field without focusing the option being clicked.
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (!expanded) {
          if (event.key === "ArrowDown" && !disabled) {
            event.preventDefault();
            setQuery("");
            setOpen(true);
          }
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          trigger.current?.focus({ preventScroll: true });
          setOpen(false);
        } else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          panel.current?.querySelector("button")?.click();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const choices = Array.from(panel.current?.querySelectorAll<HTMLElement>("input, button") ?? []);
          if (!choices.length) return;
          const index = choices.indexOf(document.activeElement as HTMLElement);
          const next = index < 0 ? 0 : (index + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length;
          event.preventDefault();
          choices[next].focus();
        }
      }}>
      <button type="button" className="picker-trigger" ref={trigger} disabled={disabled}
        aria-label={label + ": " + (current?.label ?? value)}
        aria-expanded={expanded} aria-controls={expanded ? id : undefined}
        onClick={() => { setQuery(""); setOpen(!expanded); }}>
        {current?.icon}<span>{current?.label ?? value}</span><i aria-hidden="true" />
      </button>
      {expanded && (
        <div className="picker-panel" id={id} ref={panel} role="group" aria-label={label}>
          {search && (
            <input type="search" value={query} aria-label={"Search " + label.toLowerCase().replace(/^filter by /, "")}
              placeholder="Search…" onChange={(event) => setQuery(event.target.value)} />
          )}
          <div className="picker-options">
            {matches.map((option) => (
              <button key={option.value} type="button" aria-pressed={option.value === value}
                onClick={() => {
                  trigger.current?.focus({ preventScroll: true });
                  setOpen(false);
                  onChange(option.value);
                }}>
                {option.icon}<span>{option.label}</span>
                {option.value === value && <b aria-hidden="true">✓</b>}
              </button>
            ))}
            {matches.length === 0 && (
              <p className="muted">No matches</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
