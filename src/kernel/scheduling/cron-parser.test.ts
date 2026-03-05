import { describe, expect, test } from 'bun:test';
import { CronParser } from './cron-parser';

describe('CronParser', () => {
  describe('parse', () => {
    test('应该解析 * * * * * 为全范围', () => {
      const fields = CronParser.parse('* * * * *');
      expect(fields.minutes.length).toBe(60); // 0-59
      expect(fields.hours.length).toBe(24); // 0-23
      expect(fields.daysOfMonth.length).toBe(31); // 1-31
      expect(fields.months.length).toBe(12); // 1-12
      expect(fields.daysOfWeek.length).toBe(7); // 0-6
    });

    test('应该解析步长 */30 * * * *', () => {
      const fields = CronParser.parse('*/30 * * * *');
      expect(fields.minutes).toEqual([0, 30]);
    });

    test('应该解析范围 0 9 * * 1-5', () => {
      const fields = CronParser.parse('0 9 * * 1-5');
      expect(fields.minutes).toEqual([0]);
      expect(fields.hours).toEqual([9]);
      expect(fields.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    });

    test('应该解析列表 0,15,30,45 * * * *', () => {
      const fields = CronParser.parse('0,15,30,45 * * * *');
      expect(fields.minutes).toEqual([0, 15, 30, 45]);
    });

    test('应该解析范围加步长 0 0-12/3 * * *', () => {
      const fields = CronParser.parse('0 0-12/3 * * *');
      expect(fields.hours).toEqual([0, 3, 6, 9, 12]);
    });

    test('应该将 day of week 7 规范化为 0', () => {
      const fields = CronParser.parse('0 0 * * 7');
      expect(fields.daysOfWeek).toEqual([0]);
    });

    test('应该在字段数量不正确时抛出错误', () => {
      expect(() => CronParser.parse('* * *')).toThrow('expected 5 fields');
      expect(() => CronParser.parse('* * * * * *')).toThrow('expected 5 fields');
    });

    test('应该在值越界时抛出错误', () => {
      expect(() => CronParser.parse('60 * * * *')).toThrow('out of range');
      expect(() => CronParser.parse('* 25 * * *')).toThrow('out of range');
    });
  });

  describe('nextRun', () => {
    test('应该计算 "0 9 * * *" 的下次运行时间', () => {
      // After 2024-01-15 08:00:00 → next is 2024-01-15 09:00:00
      const after = new Date('2024-01-15T08:00:00');
      const next = CronParser.nextRun('0 9 * * *', after);
      expect(next).not.toBeNull();
      expect(next?.getHours()).toBe(9);
      expect(next?.getMinutes()).toBe(0);
    });

    test('应该在当天时间已过时跳到次日', () => {
      // After 2024-01-15 10:00:00 → next is 2024-01-16 09:00:00
      const after = new Date('2024-01-15T10:00:00');
      const next = CronParser.nextRun('0 9 * * *', after);
      expect(next).not.toBeNull();
      expect(next?.getDate()).toBe(16);
      expect(next?.getHours()).toBe(9);
    });

    test('应该正确处理每30分钟', () => {
      const after = new Date('2024-01-15T08:10:00');
      const next = CronParser.nextRun('*/30 * * * *', after);
      expect(next).not.toBeNull();
      expect(next?.getMinutes()).toBe(30);
    });

    test('应该正确处理工作日', () => {
      // 2024-01-13 is Saturday
      const after = new Date('2024-01-13T08:00:00');
      const next = CronParser.nextRun('0 9 * * 1-5', after);
      expect(next).not.toBeNull();
      // Should be Monday Jan 15
      expect(next?.getDay()).toBeGreaterThanOrEqual(1);
      expect(next?.getDay()).toBeLessThanOrEqual(5);
    });

    test('应该正确处理每月1号', () => {
      const after = new Date('2024-01-15T00:00:00');
      const next = CronParser.nextRun('0 0 1 * *', after);
      expect(next).not.toBeNull();
      expect(next?.getDate()).toBe(1);
      expect(next?.getMonth()).toBe(1); // February
    });
  });

  describe('validate', () => {
    test('有效表达式应该返回 null', () => {
      expect(CronParser.validate('0 9 * * *')).toBeNull();
      expect(CronParser.validate('*/30 * * * *')).toBeNull();
      expect(CronParser.validate('0 18 * * 1-5')).toBeNull();
    });

    test('无效表达式应该返回错误信息', () => {
      expect(CronParser.validate('invalid')).toContain('expected 5 fields');
      expect(CronParser.validate('60 * * * *')).toContain('out of range');
    });
  });
});
