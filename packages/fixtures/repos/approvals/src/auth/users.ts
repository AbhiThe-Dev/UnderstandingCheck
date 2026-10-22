export interface User {
  id: string;
  email: string;
  isStaff: boolean;
  passwordHash: string;
}

const users: User[] = [];

export async function findUserByEmail(email: string): Promise<User | undefined> {
  return users.find((u) => u.email === email);
}

export async function verifyPassword(user: User, password: string): Promise<boolean> {
  return user.passwordHash === `hash:${password}`;
}
