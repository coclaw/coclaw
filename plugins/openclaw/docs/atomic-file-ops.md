# 原子文件操作基础设施

## 背景

插件需要安全地读写 JSON/JSONL 等状态文件。存在两类风险：

1. **崩溃损坏**：`fs.writeFile` 写到一半进程崩溃，文件变为残缺数据
2. **并发交错**：多个 async read-modify-write 操作交错执行，导致 lost update

## 方案

采用两层防护，均为零外部依赖的自有实现：

### 磁盘原子性：`atomicWriteFile` / `atomicWriteJsonFile`

- 位于 `src/utils/atomic-write.js`
- 参照 OpenClaw `writeTextAtomic` 实现
- 原理：写入同目录 `<文件名>.<uuid>.tmp` 临时文件，再 `fs.rename()` 覆盖目标（POSIX 原子操作）
- `finally` 块确保临时文件不残留
- `atomicWriteJsonFile` 使用 2 空格缩进 + 尾部换行

### 进程内并发保护：`createMutex`

- 位于 `src/utils/mutex.js`
- 参照 OpenClaw `createAsyncLock` 实现
- 原理：基于 Promise 链的 FIFO 队列，每次 `withLock(fn)` 排队等待前一个完成后再执行
- 异常不阻塞队列（`finally` 释放锁），异常原样抛给调用侧

### 使用模式

```js
import { createMutex } from './utils/mutex.js';
import { atomicWriteJsonFile } from './utils/atomic-write.js';

const topicsMutex = createMutex();

// read-modify-write 在锁内完成
async function addTopic(topic) {
  return topicsMutex.withLock(async () => {
    const data = JSON.parse(await fs.readFile(TOPICS_PATH, 'utf8'));
    data.topics.push(topic);
    await atomicWriteJsonFile(TOPICS_PATH, data);
    return data;
  });
}

// fire-and-forget 必须 catch
topicsMutex.withLock(async () => { ... }).catch(err => {
  logger.error?.({ err }, 'topic write failed');
});
```

### 注意事项

- 每个需要保护的文件独立一把锁
- 禁止在 `withLock(fn)` 内嵌套同一把锁（死锁）
- fn 应尽量短，避免长时间持锁
- 纯只读（不基于结果做写入）可不加锁

## TODO

- **Windows 兼容性**：当前 `atomicWriteFile` 的 `fs.rename` 在 POSIX 上是原子操作，在 Windows (NTFS) 上 Node.js/libuv 通过 `MoveFileExW` + `MOVEFILE_REPLACE_EXISTING` 也基本支持原子替换。但 Windows 存在边界问题：目标文件被其他进程占用（如杀毒软件扫描）时 rename 会返回 `EPERM`/`EEXIST`。OpenClaw 在更高层（`configIO`）通过 `copyFile` 降级处理此场景。当前插件仅运行在 Linux gateway 上，暂不处理；若未来需支持 Windows，需增加 rename 失败时的 `copyFile` 降级逻辑。

## 不引入外部依赖的决策

- 插件目标是零外部依赖，避免依赖链带来的未知限制
- `atomicWriteFile`（~20 行）和 `createMutex`（~15 行）实现简单，无需 `write-file-atomic` 或 `async-mutex`
- 方案参照 OpenClaw 生产代码，经过验证
