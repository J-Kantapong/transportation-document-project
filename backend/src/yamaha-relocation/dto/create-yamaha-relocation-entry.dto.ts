// Wire shape only — the form arrives as multipart/form-data (text fields + 2 files), so every
// text field is a string or missing and is typed `unknown` to force the runtime checks in
// YamahaRelocationService (count arrives as the string "3", not the number 3).
export interface CreateYamahaRelocationEntryDto {
  date: unknown;
  size: unknown;
  count: unknown;
}
