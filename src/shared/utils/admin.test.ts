import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isAdminUser } from './admin';

describe('isAdminUser', () => {
  const originalEnv = process.env.ADMIN_USER_IDS;

  beforeEach(() => {
    process.env.ADMIN_USER_IDS = undefined;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ADMIN_USER_IDS = originalEnv;
    } else {
      process.env.ADMIN_USER_IDS = undefined;
    }
  });

  test('should return true for admin user', () => {
    process.env.ADMIN_USER_IDS = 'feishu:admin1,telegram:admin2';
    expect(isAdminUser('feishu:admin1')).toBe(true);
    expect(isAdminUser('telegram:admin2')).toBe(true);
  });

  test('should return false for non-admin user', () => {
    process.env.ADMIN_USER_IDS = 'feishu:admin1';
    expect(isAdminUser('feishu:regular')).toBe(false);
  });

  test('should return false when env var is not set', () => {
    expect(isAdminUser('feishu:admin1')).toBe(false);
  });

  test('should return false when env var is empty', () => {
    process.env.ADMIN_USER_IDS = '';
    expect(isAdminUser('feishu:admin1')).toBe(false);
  });

  test('should handle whitespace in env var', () => {
    process.env.ADMIN_USER_IDS = ' feishu:admin1 , telegram:admin2 ';
    expect(isAdminUser('feishu:admin1')).toBe(true);
    expect(isAdminUser('telegram:admin2')).toBe(true);
  });
});
