interface PermissionRow {
  userId: string;
  area: string;
  grantedAt?: Date;
}

const rows: PermissionRow[] = [];
const roles = new Map<string, string>();

export const db = {
  async insertPermission(row: PermissionRow) {
    rows.push(row);
  },
  async deletePermission(row: PermissionRow) {
    const i = rows.findIndex((r) => r.userId === row.userId && r.area === row.area);
    if (i >= 0) rows.splice(i, 1);
  },
  async permissionExists(row: PermissionRow) {
    return rows.some((r) => r.userId === row.userId && r.area === row.area);
  },
  async setRole(userId: string, role: string) {
    roles.set(userId, role);
  },
};
