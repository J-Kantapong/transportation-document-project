import { request } from './api';
import type { AuthUser, UserRole, UserStatus } from './auth';

// ดู backend/src/auth (register/login/me), backend/src/admin-users, backend/src/portal

export type StaffRegisterInput = {
  kind: 'STAFF';
  name: string;
  displayName: string;
  email: string;
  phone: string;
  password: string;
  confirmPassword: string;
  requestedRole: UserRole;
};

export type CustomerRegisterInput = {
  kind: 'CUSTOMER';
  name: string;
  company: string;
  email: string;
  phone: string;
  password: string;
  confirmPassword: string;
};

export type PortalStepState = 'DONE' | 'CURRENT' | 'PENDING' | 'FAILED';

export interface PortalStep {
  key: string;
  title: string;
  state: PortalStepState;
  date: string | null;
  note: string | null;
}

export interface PortalVehicle {
  id: string;
  date: string;
  chassis: string;
  brandName: string;
  color: string | null;
  body: string | null;
  registrationProvince: string | null;
  plate: string | null;
  steps: PortalStep[];
  currentStep: string;
  deliveredDate: string | null;
  plateDeliveredDate: string | null;
  deliveryConfirmedAt: string | null;
}

export const authApi = {
  register: (data: StaffRegisterInput | CustomerRegisterInput) =>
    request<{ user: AuthUser }>('/api/auth/register', { method: 'POST', body: JSON.stringify(data) }),
  login: (email: string, password: string) =>
    request<{ token: string; user: AuthUser }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  me: () => request<{ user: AuthUser }>('/api/auth/me'),
  changePassword: (data: { currentPassword: string; password: string; confirmPassword: string }) =>
    request<{ ok: true }>('/api/auth/change-password', { method: 'POST', body: JSON.stringify(data) }),

  // Admin
  listUsers: (status?: UserStatus) => request<{ users: AuthUser[] }>(`/api/admin/users${status ? `?status=${status}` : ''}`),
  updateUser: (id: string, data: { status?: UserStatus; roles?: UserRole[]; customerId?: string | null }) =>
    request<{ user: AuthUser }>(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Portal ลูกค้า
  portalCompany: () =>
    request<{ customer: { id: string; name: string; company: string | null; branch: string | null } }>('/api/portal/company'),
  portalVehicles: () => request<{ vehicles: PortalVehicle[] }>('/api/portal/vehicles'),
  portalConfirmDelivery: (vehicleId: string) =>
    request<{ vehicle: PortalVehicle }>(`/api/portal/vehicles/${vehicleId}/confirm-delivery`, { method: 'POST' }),
};
