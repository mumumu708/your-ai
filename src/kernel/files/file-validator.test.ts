import { describe, expect, test } from 'bun:test';
import { FileValidator } from './file-validator';

describe('FileValidator', () => {
  const validator = new FileValidator();

  describe('extension blocking', () => {
    test('should block executable extensions', () => {
      expect(validator.checkExtension('malware.exe').valid).toBe(false);
      expect(validator.checkExtension('script.bat').valid).toBe(false);
      expect(validator.checkExtension('hack.sh').valid).toBe(false);
      expect(validator.checkExtension('trojan.dll').valid).toBe(false);
      expect(validator.checkExtension('danger.vbs').valid).toBe(false);
    });

    test('should allow safe extensions', () => {
      expect(validator.checkExtension('photo.jpg').valid).toBe(true);
      expect(validator.checkExtension('report.pdf').valid).toBe(true);
      expect(validator.checkExtension('data.csv').valid).toBe(true);
      expect(validator.checkExtension('doc.txt').valid).toBe(true);
      expect(validator.checkExtension('archive.zip').valid).toBe(true);
    });

    test('should be case insensitive', () => {
      expect(validator.checkExtension('file.EXE').valid).toBe(false);
      expect(validator.checkExtension('file.Bat').valid).toBe(false);
    });
  });

  describe('channel limits', () => {
    test('should enforce feishu 20MB limit', () => {
      const result = validator.checkChannelLimits('big.pdf', 25 * 1024 * 1024, 'feishu');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('feishu');
      expect(result.reason).toContain('20MB');
    });

    test('should allow feishu files under limit', () => {
      expect(validator.checkChannelLimits('small.pdf', 10 * 1024 * 1024, 'feishu').valid).toBe(
        true,
      );
    });

    test('should enforce telegram 50MB limit', () => {
      expect(validator.checkChannelLimits('big.zip', 60 * 1024 * 1024, 'telegram').valid).toBe(
        false,
      );
      expect(validator.checkChannelLimits('ok.zip', 40 * 1024 * 1024, 'telegram').valid).toBe(true);
    });

    test('should enforce web 100MB limit', () => {
      expect(validator.checkChannelLimits('huge.bin', 150 * 1024 * 1024, 'web').valid).toBe(false);
      expect(validator.checkChannelLimits('ok.bin', 80 * 1024 * 1024, 'web').valid).toBe(true);
    });

    test('should allow unknown channels', () => {
      expect(validator.checkChannelLimits('file.txt', 1000, 'unknown').valid).toBe(true);
    });
  });

  describe('full validation', () => {
    test('should pass valid files', () => {
      expect(validator.validate('photo.jpg', 1024, 'web').valid).toBe(true);
      expect(validator.validate('report.pdf', 5 * 1024 * 1024, 'feishu').valid).toBe(true);
    });

    test('should fail blocked extensions first', () => {
      const result = validator.validate('hack.exe', 100, 'web');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('.exe');
    });

    test('should fail on channel size limits', () => {
      const result = validator.validate('valid.pdf', 25 * 1024 * 1024, 'feishu');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('feishu');
    });
  });

  describe('categorize', () => {
    test('should categorize images', () => {
      expect(validator.categorize('photo.jpg')).toBe('images');
      expect(validator.categorize('icon.png')).toBe('images');
      expect(validator.categorize('anim.gif')).toBe('images');
      expect(validator.categorize('logo.svg')).toBe('images');
    });

    test('should categorize documents', () => {
      expect(validator.categorize('report.pdf')).toBe('documents');
      expect(validator.categorize('data.csv')).toBe('documents');
      expect(validator.categorize('readme.md')).toBe('documents');
      expect(validator.categorize('config.json')).toBe('documents');
    });

    test('should put others in temp', () => {
      expect(validator.categorize('archive.zip')).toBe('temp');
      expect(validator.categorize('data.bin')).toBe('temp');
      expect(validator.categorize('noext')).toBe('temp');
    });
  });

  describe('getExtension', () => {
    test('should extract extension', () => {
      expect(validator.getExtension('file.txt')).toBe('.txt');
      expect(validator.getExtension('archive.tar.gz')).toBe('.gz');
      expect(validator.getExtension('noext')).toBe('');
      expect(validator.getExtension('UPPER.PDF')).toBe('.pdf');
    });
  });
});
