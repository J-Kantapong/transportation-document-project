// Wire shape only — every field arrives as unvalidated JSON, so each is typed `unknown`
// rather than `string` to force the runtime checks in CustomersService before use.
export interface CreateCustomerDto {
  name: unknown;
  company: unknown;
  branch: unknown;
  address: unknown;
  taxId: unknown;
  phone: unknown;
  email: unknown;
}
