import { tripPhaseLabels, tripPhases } from "../../worker/src/tripPhases";
import { Picker } from "./picker";

export const phaseOptions = tripPhases.map((phase) => ({ value: phase, label: tripPhaseLabels[phase] }));

export function GroupTypePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="field">
      <span>Group type</span>
      <Picker label="Group type" value={value} onChange={onChange}
        options={[{ value: "trip", label: "Trip" }, { value: "home", label: "Long-term / Home" }]} />
    </div>
  );
}
