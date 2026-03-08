import { describe, expect, test } from 'bun:test';
import { nlToCron } from './nl-to-cron';

describe('nlToCron', () => {
  describe('每分钟/每小时', () => {
    test('每分钟', () => {
      const result = nlToCron('每分钟');
      expect(result.cron).toBe('* * * * *');
      expect(result.confidence).toBeGreaterThan(0);
    });

    test('每小时', () => {
      const result = nlToCron('每小时');
      expect(result.cron).toBe('0 * * * *');
    });

    test('每时', () => {
      const result = nlToCron('每时');
      expect(result.cron).toBe('0 * * * *');
    });

    test('every minute', () => {
      const result = nlToCron('every minute');
      expect(result.cron).toBe('* * * * *');
    });

    test('every hour', () => {
      const result = nlToCron('every hour');
      expect(result.cron).toBe('0 * * * *');
    });

    test('不干扰 每2小时', () => {
      const result = nlToCron('每2小时');
      expect(result.cron).toBe('0 */2 * * *');
    });

    test('不干扰 每隔30分钟', () => {
      const result = nlToCron('每隔30分钟');
      expect(result.cron).toBe('*/30 * * * *');
    });
  });

  describe('中文模式', () => {
    test('每天上午9点', () => {
      const result = nlToCron('每天上午9点');
      expect(result.cron).toBe('0 9 * * *');
      expect(result.confidence).toBeGreaterThan(0);
    });

    test('每天早上8点30', () => {
      const result = nlToCron('每天早上8点30');
      expect(result.cron).toBe('30 8 * * *');
    });

    test('每天下午3点', () => {
      const result = nlToCron('每天下午3点');
      expect(result.cron).toBe('0 15 * * *');
    });

    test('每隔30分钟', () => {
      const result = nlToCron('每隔30分钟');
      expect(result.cron).toBe('*/30 * * * *');
    });

    test('每半小时', () => {
      const result = nlToCron('每半小时');
      expect(result.cron).toBe('*/30 * * * *');
    });

    test('每2小时', () => {
      const result = nlToCron('每2小时');
      expect(result.cron).toBe('0 */2 * * *');
    });

    test('每周一上午10点', () => {
      const result = nlToCron('每周一上午10点');
      expect(result.cron).toBe('0 10 * * 1');
    });

    test('每星期五9点', () => {
      const result = nlToCron('每星期五9点');
      expect(result.cron).toBe('0 9 * * 5');
    });

    test('工作日早上9点', () => {
      const result = nlToCron('工作日早上9点');
      expect(result.cron).toBe('0 9 * * 1-5');
    });

    test('每个工作日18点', () => {
      const result = nlToCron('每个工作日18点');
      expect(result.cron).toBe('0 18 * * 1-5');
    });

    test('每月1号', () => {
      const result = nlToCron('每月1号');
      expect(result.cron).toBe('0 0 1 * *');
    });

    test('每月15号上午10点', () => {
      const result = nlToCron('每月15号上午10点');
      expect(result.cron).toBe('0 10 15 * *');
    });

    test('每月第一天', () => {
      const result = nlToCron('每月第一天');
      expect(result.cron).toBe('0 0 1 * *');
    });
  });

  describe('英文模式', () => {
    test('every day at 9:00', () => {
      const result = nlToCron('every day at 9:00');
      expect(result.cron).toBe('0 9 * * *');
    });

    test('daily at 14:30', () => {
      const result = nlToCron('daily at 14:30');
      expect(result.cron).toBe('30 14 * * *');
    });

    test('every 15 minutes', () => {
      const result = nlToCron('every 15 minutes');
      expect(result.cron).toBe('*/15 * * * *');
    });

    test('every half hour', () => {
      const result = nlToCron('every half hour');
      expect(result.cron).toBe('*/30 * * * *');
    });

    test('every Monday at 10:00', () => {
      const result = nlToCron('every Monday at 10:00');
      expect(result.cron).toBe('0 10 * * 1');
    });

    test('every Friday at 17:00', () => {
      const result = nlToCron('every Friday at 17:00');
      expect(result.cron).toBe('0 17 * * 5');
    });

    test('weekday at 9:00', () => {
      const result = nlToCron('weekday at 9:00');
      expect(result.cron).toBe('0 9 * * 1-5');
    });

    test('every 3 hours', () => {
      const result = nlToCron('every 3 hours');
      expect(result.cron).toBe('0 */3 * * *');
    });
  });

  describe('taskContent 提取', () => {
    test('从调度命令中提取任务内容', () => {
      const result = nlToCron('创建一个定时任务，每分钟，给我发送一条消息，内容是你好');
      expect(result.cron).toBe('* * * * *');
      expect(result.taskContent).toBe('给我发送一条消息，内容是你好');
    });

    test('纯调度表达式时 taskContent 保留原文', () => {
      const result = nlToCron('每分钟');
      expect(result.taskContent).toBe('每分钟');
    });

    test('设置定时任务前缀也能去除', () => {
      const result = nlToCron('设置定时任务每天上午9点提醒我开会');
      expect(result.cron).toBe('0 9 * * *');
      expect(result.taskContent).toBe('提醒我开会');
    });

    test('无法识别时 taskContent 回退为原文', () => {
      const result = nlToCron('明天帮我买菜');
      expect(result.taskContent).toBe('明天帮我买菜');
    });
  });

  describe('未识别模式', () => {
    test('无法识别的文本应该返回 null cron', () => {
      const result = nlToCron('明天帮我买菜');
      expect(result.cron).toBeNull();
      expect(result.confidence).toBe(0);
    });
  });
});
