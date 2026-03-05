# 第10章 文件管理系统
> **本章目标**：设计安全、隔离的文件管理系统，支持多通道文件上传下载、配额管理和 Agent 文件操作。
## 10.1 文件系统架构
```plaintext
user-space/{userId}/workspace/
├── uploads/
│   ├── images/
│   ├── documents/
│   └── temp/
├── outputs/
│   ├── generated/
│   └── exports/
└── CLAUDE.md
```

## 10.2 文件操作接口
```typescript
export class FileManager {
  constructor(private readonly userId: string) {}

  async readFile(path: string): Promise<string> {
    this.validatePath(path);
    return Bun.file(this.resolve(path)).text();
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.validatePath(path);
    await this.checkQuota(content.length);
    await Bun.write(this.resolve(path), content);
  }

  async listDirectory(path: string): Promise<FileEntry[]> {
    this.validatePath(path);
    const entries = await readdir(this.resolve(path), { withFileTypes: true });
    return entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : 'file',
      size: e.isFile() ? statSync(this.resolve(`${path}/${e.name}`)).size : 0,
    }));
  }

  private validatePath(path: string): void {
    const resolved = resolve(this.basePath, path);
    if (!resolved.startsWith(this.basePath)) {
      throw new Error('PATH_TRAVERSAL_BLOCKED');
    }
  }

  private resolve(path: string): string {
    return `user-space/<equation>{this.userId}/workspace/</equation>{path}`;
  }
}
```

## 10.3 多通道文件处理


| 通道 | 上传方式 | 大小限制 | 支持格式 |
| --- | --- | --- | --- |
| 飞书 | 消息附件 | 20MB | 图片/文档/PDF |
| Telegram | 消息附件 | 50MB | 任意格式 |
| Web | 拖拽上传 | 100MB | 任意格式 |


## 10.4 文件配额管理


| 用户类型 | 存储配额 | 单文件限制 | 文件数限制 |
| --- | --- | --- | --- |
| 免费用户 | 1GB | 20MB | 1000 |
| 专业用户 | 10GB | 100MB | 10000 |
| 企业用户 | 100GB | 500MB | 无限制 |


## 10.5 文件安全
- 路径穿越防护：所有路径解析后必须在用户工作空间内
- 文件类型白名单：禁止可执行文件上传
- 病毒扫描：上传文件自动扫描
- 内容审查：敏感内容检测
---
