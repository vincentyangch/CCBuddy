export type UserRole = 'admin' | 'trusted' | 'chat' | 'system';

export interface User {
  name: string;
  role: UserRole;
  platformIds: Record<string, string>;
}
