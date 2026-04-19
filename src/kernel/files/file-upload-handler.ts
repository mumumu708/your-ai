import { Logger } from '../../shared/logging/logger';
import type { UserConfigLoader } from '../prompt/user-config-loader';

const MAX_FILE_SIZE = 100 * 1024; // 100KB
const ALLOWED_EXTENSIONS = ['.md', '.txt'];
const USER_PROFILE_NAMES = ['user.md', 'user.txt'];

/**
 * Handles user-uploaded files, specifically USER.md profile uploads.
 */
export class FileUploadHandler {
  private readonly logger = new Logger('FileUploadHandler');

  /** Check if the uploaded file is a user profile (USER.md / user.md / user.txt) */
  isUserProfileUpload(fileName: string): boolean {
    return USER_PROFILE_NAMES.includes(fileName.toLowerCase());
  }

  /** Process a USER.md upload: validate and write via UserConfigLoader */
  async processUserMdUpload(
    buffer: Buffer,
    fileName: string,
    userConfigLoader: UserConfigLoader,
  ): Promise<string> {
    // Validate extension
    const ext = this.getExtension(fileName);
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return `不支持的文件格式「${ext}」，请上传 .md 或 .txt 文件。`;
    }

    // Validate size
    if (buffer.length > MAX_FILE_SIZE) {
      return `文件过大（${(buffer.length / 1024).toFixed(1)}KB），最大允许 100KB。`;
    }

    // Validate non-empty
    const content = buffer.toString('utf-8').trim();
    if (!content) {
      return '文件内容为空，请上传有内容的 USER.md 文件。';
    }

    // Write via UserConfigLoader
    await userConfigLoader.writeConfig('USER.md', content);

    this.logger.info('USER.md 已更新', { fileName, size: buffer.length });
    return `USER.md 已更新成功！（${(buffer.length / 1024).toFixed(1)}KB）\n新的用户配置将在下次对话中生效。`;
  }

  private getExtension(fileName: string): string {
    const dot = fileName.lastIndexOf('.');
    return dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
  }
}
