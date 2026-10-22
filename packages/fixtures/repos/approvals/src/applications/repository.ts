import type { Application } from './types';

const applications = new Map<string, Application>();

export async function findApplication(id: string): Promise<Application> {
  const app = applications.get(id);
  if (!app) throw new Error(`Application ${id} not found`);
  return { ...app };
}

export async function saveApplication(app: Application): Promise<void> {
  applications.set(app.id, { ...app });
}

export async function listApplicationsByStatus(status: Application['status']): Promise<Application[]> {
  return [...applications.values()].filter((a) => a.status === status);
}
