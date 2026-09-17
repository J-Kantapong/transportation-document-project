// Wire shape only — every field arrives as unvalidated JSON, so each is typed `unknown`
// rather than a concrete type to force the runtime checks in YamahaRelocationService.
export interface CreateYamahaRelocationEntryDto {
  date: unknown;
  size: unknown;
  count: unknown;
}
