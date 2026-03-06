export function isAdminUser(userId: string): boolean {
  const adminIds = (process.env.ADMIN_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return adminIds.includes(userId);
}
