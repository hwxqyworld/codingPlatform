import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 发布流水线 —— main 分支被推送后执行:
 *   1. 读取 main 分支头部提交 sha(构建与提交绑定)
 *   2. 导出 main 分支快照(容器模式: 构建容器内部完成)
 *   3. 编译(容器模式: 构建容器池内执行, 排队/超时/扩容由 buildQueue 管理)
 *   4. 更新作品元数据(发布时间 / 发布提交 / 构建状态)
 *
 * 触发方式(两条通道都会走到这里, 保证行为一致):
 *   - git 命令行推送 main  -> 裸仓库 post-receive hook -> /api/internal/publish
 *   - 在线编辑器"发布"按钮 -> develop:main 推送(容器内) -> 平台直接触发
 *
 * 平台规则(构建与提交绑定):
 *   - 构建结果记录到 builds 表并绑定构建开始时的 main 头部提交
 *   - 构建成功时产物写入 artifacts/<id>/current —— 该目录始终是"最近一次有效构建",
 *     因此当最新提交构建失败时, 作品页自然回退到最近一次有效构建
 */
export function createPublisher({ cfg, db, git, compiler, buildQueue }) {
  const running = new Map(); // workId -> Promise(防止同一作品并发重复构建)
  const containerMode = cfg.buildMode === 'container';

  /** 触发发布(并发去重) */
  function publish(workId) {
    if (running.has(workId)) return running.get(workId);
    const task = doPublish(workId).finally(() => running.delete(workId));
    running.set(workId, task);
    return task;
  }

  async function doPublish(workId) {
    const work = db.getWork(workId);
    if (!work) return { ok: false, error: '作品不存在' };

    // 同步先置为中间状态: 调用方(/build 接口、webhook)不等任何 await 就能观察到,
    // 避免"上次终态"被误读为新构建的结果(竞态)。
    // 容器模式: 先进入排队状态(前端展示"服务器繁忙, 正在队伍第 N 位")
    db.setBuild(workId, null, containerMode ? 'queued' : 'building', '');

    if (containerMode) {
      // 构建任务进入容器池队列; sha 由任务在开始执行时读取并绑定
      const result = await buildQueue.enqueue(workId);
      const sha = result.sha || null;
      db.touchUpdate(workId, {
        sha,
        status: sha ? (result.ok ? 'success' : 'failed') : 'none',
        log: truncateLog(result.log || ''),
      });
      return result;
    }

    // ---------------- 本地模式(宿主机 emcc, 开发/降级) ----------------

    // 绑定构建到 main 分支头部提交(hook 在推送完成后回调, 此时 ref 已更新)
    let sha;
    try {
      sha = await git.headSha(workId, 'main');
    } catch {
      /* main 分支不存在(可能被删除) */
    }
    if (!sha) {
      // main 没有提交 -> 作品回到私有状态
      db.touchUpdate(workId, { sha: null, status: 'none', log: '' });
      return { ok: false, error: 'main 分支不存在' };
    }
    db.setBuild(workId, sha, 'building', '');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cppplay-build-'));
    try {
      const srcDir = path.join(root, 'src');
      await git.exportTree(workId, 'main', srcDir); // 物化 main 快照到临时目录

      const result = await compiler.compileDir(workId, srcDir);

      // 推送 main 即算一次更新(更新时间/发布提交/最终构建状态, 构建绑定该提交)
      db.touchUpdate(workId, {
        sha,
        status: result.ok ? 'success' : 'failed',
        log: truncateLog(result.log),
      });
      return result;
    } catch (err) {
      db.touchUpdate(workId, {
        sha,
        status: 'failed',
        log: truncateLog(String(err?.message || err)),
      });
      return { ok: false, error: String(err?.message || err) };
    } finally {
      // 清理临时构建目录
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }

  /** 构建日志可能很长, 截断保存 */
  function truncateLog(log) {
    if (!log) return '';
    return log.length > cfg.maxBuildLogBytes
      ? `${log.slice(0, cfg.maxBuildLogBytes)}\n...(日志过长已截断)`
      : log;
  }

  return { publish };
}
