import {
  fieldsSchema,
  type HydroFieldSource,
  type HydroMappingField,
  type HydroMappableField,
} from '@contest-center/contracts';

export function hydroMappingFields(
  forms: { version: number; fields: unknown }[],
  currentVersion: number,
): HydroMappingField[] {
  const seen = new Set<string>();
  const result: HydroMappingField[] = [];
  for (const form of [...forms].sort((a, b) => b.version - a.version)) {
    for (const field of fieldsSchema.parse(form.fields)) {
      const identity = `${field.scope}:${field.key}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (field.type === 'file' || field.type === 'photo') continue;
      result.push({
        scope: field.scope,
        key: field.key,
        label: field.label,
        type: field.type,
        historical: form.version !== currentVersion,
      });
    }
  }
  return result;
}

interface MappingRow {
  number: number | null;
  teamName: string;
  teamEnglishName: string;
  organization: unknown;
  answers: unknown;
  people: { name: string; answers: unknown }[];
  coaches: { user: { name: string }; answers: unknown }[];
  examSite: { name: string } | null;
}
export type HydroDefaults = {
  displayName: string;
  school: string;
  members: string[];
  coach: string;
  seat: string;
};
// Only scalar form values and scalar arrays may enter the platform file. In
// particular, attachment objects and arbitrary object paths are never exported.
function values(value: unknown): string[] {
  if (Array.isArray(value))
    return value.flatMap((item) => (Array.isArray(item) ? [] : values(item)));
  if (typeof value === 'boolean') return [value ? '是' : '否'];
  if (typeof value === 'number') return Number.isFinite(value) ? [String(value)] : [];
  return typeof value === 'string' && value.trim() ? [value.trim()] : [];
}
function answer(answers: unknown, key: string) {
  return answers &&
    typeof answers === 'object' &&
    !Array.isArray(answers) &&
    Object.hasOwn(answers, key)
    ? (answers as Record<string, unknown>)[key]
    : undefined;
}
export function resolveHydroMapping<K extends HydroMappableField>(
  field: K,
  source: HydroFieldSource | undefined,
  row: MappingRow,
  defaults: HydroDefaults,
): { value: HydroDefaults[K]; fallback: boolean; usesDefault: boolean } {
  if (!source) return { value: defaults[field], fallback: false, usesDefault: true };
  let raw: unknown;
  let partialFallback = false;
  if (source.type === 'BUILTIN') {
    const builtins = {
      PERSON_NAME: row.people[0]?.name,
      TEAM_NAME: row.teamName,
      TEAM_ENGLISH_NAME: row.teamEnglishName,
      MEMBER_NAMES: defaults.members,
      ORGANIZATION: answer(row.organization, 'name'),
      COACH_NAMES: defaults.coach,
      SEAT: defaults.seat,
      REGISTRATION_NUMBER: row.number,
      EXAM_SITE: row.examSite?.name,
    };
    raw = builtins[source.key];
  } else if (source.scope === 'PERSON') {
    raw =
      field === 'members'
        ? row.people.flatMap((person) => {
            const mapped = values(answer(person.answers, source.key));
            if (mapped.length) return mapped;
            partialFallback = true;
            return values(person.name);
          })
        : answer(row.people[0]?.answers, source.key);
  } else if (source.scope === 'COACH') {
    raw = row.coaches.flatMap((coach) => values(answer(coach.answers, source.key)));
  } else {
    raw = answer(
      answer(row.answers, source.scope === 'TEAM' ? 'team' : 'registration'),
      source.key,
    );
  }
  const mapped = values(raw);
  if (!mapped.length) return { value: defaults[field], fallback: true, usesDefault: true };
  return {
    value: (field === 'members' ? mapped : mapped.join('、')) as HydroDefaults[K],
    fallback: partialFallback,
    usesDefault: source.type === 'BUILTIN' && source.key === 'SEAT' && field === 'seat',
  };
}
