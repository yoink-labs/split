export const tripPhases = ['pre', 'during', 'post'] as const;
export type TripPhase = typeof tripPhases[number];

export const tripPhaseLabels: Record<TripPhase, string> = {
  pre: 'Pre-trip',
  during: 'During trip',
  post: 'Post-trip',
};

export interface GroupSchedule {
  kind?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

export function groupKind(group: GroupSchedule): string {
  return group.kind || (group.startDate || group.endDate ? 'trip' : 'home');
}

export function defaultTripPhase(group: GroupSchedule, date: string): TripPhase | undefined {
  if (groupKind(group) !== 'trip') return undefined;
  const day = date.slice(0, 10);
  if (group.startDate && day < group.startDate) return 'pre';
  if (group.endDate && day > group.endDate) return 'post';
  return 'during';
}

export function expenseTripPhase(group: GroupSchedule, entry: { kind: string; createdAt: string; phase?: TripPhase }): TripPhase | undefined {
  if (entry.kind !== 'expense' || groupKind(group) !== 'trip') return undefined;
  return entry.phase ?? defaultTripPhase(group, entry.createdAt);
}
