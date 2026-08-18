import fs from 'node:fs';
import path from 'node:path';
import tar from 'tar-stream';

/**
 * 构建容器池 + 任务队列 —— 容器模式下的构建调度中心。
 *
 * 池规格(与用户约定一致):
 *   - 容器资源限制: 1 核 / 2GB 内存 / 256 进程 / 禁网 / 丢弃全部能力
 *   - 后台热备 1 个(池 < 2 且无空闲时自动补建)
 *   - 上限 3 个; 排队任务超过 5 个触发扩容
 *   - 队空持续 300 秒触发缩容(销毁空闲容器, 回到 1 个热备)
 *   - 正在构建的作品之间使用不同容器(同一时刻一个容器只服务一个作品)
 *
 * 任务流(作品间零共享挂载, 数据全部经 docker cp 进出):
 *   1. 读取 main 头部 sha(容器内 git, 构建与提交绑定)
 *   2. 裸仓库经 tar 拷入容器(只含该作品数据, 无任何宿主机挂载)
 *   3. 容器内: git 导出 main 快照 -> 解析 compile.json -> emcc 编译
 *   4. 产物经 tar 拷出 -> 去符号链接 -> 原子替换 artifacts/<id>/current
 *   5. 清理容器工作区(含独立缓存副本), 容器回到空闲
 *
 * 超时: 构建步骤 60 秒(脚本内自超时 + 容器管理器兜底强杀),
 *       容器被杀后视为不健康, 销毁并补建。
 *
 * 任务结束清扫(未持久化部分全部清除, 安全要求):
 *   - 宿主 .staging-* 临时产物目录: 仅在原子替换为 current 后才保留,
 *     其余任何路径(提取失败/无状态文件/构建失败/异常)一律删除
 *   - 容器内工作区(源码副本/独立缓存/临时文件/构建输出): 每次任务后 rm -rf;
 *     清理失败则物理销毁整个容器, 绝不复用一个带残留数据的容器
 *   - 失败任务(构建失败/超时/异常)的容器: 容器内执行过用户代码,
 *     直接销毁重建, 杜绝跨任务污染
 *   - 常驻容器日志轮转(见 dockerClient.js LogConfig)
 *   - 启动时: 清理上次进程残留的孤儿构建容器与 .staging-* 目录
 */
export function createBuildQueue({ cfg, db, git, docker }) {
  const workers = new Map(); // id -> { id, handle, busy: taskId|null, dead }
  const tasks = new Map(); // taskId -> task
  const pending = []; // 排队中的 taskId(FIFO)
  const byWork = new Map(); // workId -> taskId(去重)
  let creating = 0; // 正在创建的容器数
  let stopped = false;
  let seq = 0;
  let scaleDownTimer = null;

  const poolSize = () => workers.size + creating;
  const idleWorkers = () => [...workers.values()].filter((w) => !w.busy && !w.dead);

  // ---------------- 对外接口 ----------------

  /**
   * 入队一个构建任务(同一作品去重: 已排队/运行中则复用)。
   * @returns {Promise<{ok:boolean, log:string, sha:string|null}>}
   */
  function enqueue(workId) {
    const existing = byWork.get(workId);
    if (existing) return tasks.get(existing).promise;
    const id = 't' + (++seq);
    let resolve;
    const promise = new Promise((res) => {
      resolve = res;
    });
    const task = { id, workId, state: 'queued', promise, resolve };
    tasks.set(id, task);
    byWork.set(workId, id);
    pending.push(id);
    maybeScaleUp();
    scheduleScaleDownCheck();
    drain();
    return promise;
  }

  /** 排队位置(1 基); 未排队/已开始/不存在返回 null */
  function queuePositionOf(workId) {
    const tid = byWork.get(workId);
    if (!tid) return null;
    const t = tasks.get(tid);
    if (!t || t.state !== 'queued') return null;
    return pending.indexOf(tid) + 1;
  }

  /** 启动: 清理上次进程残留的孤儿容器, 再拉起热备容器 */
  async function start() {
    // 进程被强杀时 stop() 不会执行, 孤儿构建容器会带着旧任务数据永久残留 —— 启动时清除
    try {
      const orphans = await docker.listWorkers();
      for (const id of orphans) await docker.removeWorker(id);
      if (orphans.length) console.log(`[build-queue] 清理上次进程残留的构建容器 ${orphans.length} 个`);
    } catch (err) {
      console.error('[build-queue] 清理残留容器失败:', err?.message || err);
    }
    await spawnWorker();
  }

  /** 停止: 取消缩容定时器并销毁全部容器(优雅退出/测试清理) */
  async function stop() {
    stopped = true;
    clearTimeout(scaleDownTimer);
    const all = [...workers.values()];
    workers.clear();
    creating = 0;
    await Promise.allSettled(all.map((w) => w.handle.remove()));
  }

  /** 池状态(测试/诊断用) */
  function stats() {
    return {
      workers: workers.size,
      creating,
      pending: pending.length,
      idle: idleWorkers().length,
      running: [...workers.values()].filter((w) => w.busy).length,
    };
  }

  // ---------------- 池管理 ----------------

  async function spawnWorker() {
    if (stopped) return null;
    creating++;
    try {
      const handle = await docker.createWorker({
        image: cfg.buildImage,
        cpus: cfg.workerCpus,
        memoryMb: cfg.workerMemoryMb,
        pidsLimit: cfg.workerPidsLimit,
      });
      const w = { id: handle.id, handle, busy: null, dead: false };
      workers.set(w.id, w);
      drain(); // 新容器就绪: 派发等待中的任务(热备容器会随即补建)
      return w;
    } catch (err) {
      console.error('[build-queue] 创建构建容器失败:', err.message);
      return null;
    } finally {
      creating--;
    }
  }

  /** 热备维护: 池 < 2 且没有空闲容器时补建 1 个(后台热备) */
  function maintainStandby() {
    if (stopped) return;
    if (poolSize() >= 2) return;
    if (idleWorkers().length > 0) return;
    if (creating > 0) return;
    spawnWorker();
  }

  /** 扩容: 排队任务超过阈值 -> 补建容器直到池上限 */
  function maybeScaleUp() {
    if (stopped) return;
    if (pending.length <= cfg.scaleUpQueueLen) return;
    const need = Math.max(0, cfg.poolMax - poolSize());
    for (let i = 0; i < need; i++) spawnWorker();
  }

  /** 缩容: 队空持续 scaleDownIdleMs -> 销毁空闲容器, 保留 poolMin 个热备 */
  function scheduleScaleDownCheck() {
    clearTimeout(scaleDownTimer);
    if (stopped) return;
    if (pending.length > 0) return;
    scaleDownTimer = setTimeout(() => {
      if (stopped || pending.length > 0) return; // 期间又来了任务
      const idle = idleWorkers();
      let toRemove = workers.size - cfg.poolMin;
      for (const w of idle) {
        if (toRemove <= 0) break;
        destroyWorker(w);
        toRemove--;
      }
      scheduleScaleDownCheck(); // 继续监听下一轮空闲
    }, cfg.scaleDownIdleMs);
    if (typeof scaleDownTimer.unref === 'function') scaleDownTimer.unref();
  }

  function destroyWorker(w) {
    w.dead = true;
    workers.delete(w.id);
    w.handle.remove().catch(() => {});
  }

  // ---------------- 任务调度 ----------------

  function drain() {
    if (stopped) return;
    while (pending.length > 0) {
      const w = idleWorkers()[0];
      if (!w) {
        maybeScaleUp();
        break;
      }
      const tid = pending.shift();
      const t = tasks.get(tid);
      if (!t) continue;
      w.busy = tid;
      t.state = 'running';
      runTask(w, t); // 异步执行, 不阻塞调度
    }
    maintainStandby();
  }

  async function runTask(w, t) {
    let result;
    try {
      result = await buildInWorker(w, t.workId);
    } catch (err) {
      result = { ok: false, log: `构建异常: ${err?.message || err}`, sha: null };
    } finally {
      tasks.delete(t.id);
      byWork.delete(t.workId);
      w.busy = null;
      if (!result.ok) {
        // 失败/超时/异常任务: 容器内执行过用户代码(可能恶意), 不复用 —— 销毁并补建
        destroyWorker(w);
      } else if (w.dead) {
        workers.delete(w.id);
      }
      t.resolve(result);
      scheduleScaleDownCheck();
      drain();
    }
  }

  // ---------------- 任务驱动(容器内构建) ----------------

  async function buildInWorker(w, workId) {
    const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const wk = `/work/${runId}`;
    const repo = `${wk}/repo`;
    const src = `${wk}/src`;
    const out = `${wk}/out`;
    const cache = `${wk}/cache`;
    const home = `${wk}/home`;
    const exec = (cmd, opts = {}) => w.handle.exec({ cmd, ...opts });
    const timeoutS = Math.round(cfg.buildTimeoutMs / 1000);

    // 1. 读取 main 头部 sha(绑定构建; 容器内 git)
    let sha = null;
    try {
      sha = await git.headSha(workId, 'main');
    } catch {
      /* main 不存在 */
    }
    if (!sha) return { ok: false, log: 'main 分支不存在', sha: null };

    // 任务真正开始执行: 进入"构建中"状态(与排队区分, 绑定 sha)
    db.setBuild(workId, sha, 'building', '');

    let staging = null; // 宿主临时产物目录(仅在原子替换为 current 后保留, 其余路径一律清除)

    try {
      // 2. 准备工作区: 目录 + 独立缓存副本(任务间零共享可变状态, 恶意构建无法污染后续构建)
      await exec(['sh', '-c', `mkdir -p ${wk} ${home} && cp -a /opt/pristine-cache ${cache}`], {
        user: 'root',
        timeoutMs: 120000,
      });

      // 3. 把该作品裸仓库拷入容器(仅本作品数据可见)
      await putRepoInto(w, workId, wk);

      // 4. 属主改为非特权构建用户
      await exec(['chown', '-R', 'builder:builder', wk], { user: 'root', timeoutMs: 60000 });

      // 5. 导出快照 + 编译(容器内 git + emcc; 60s 超时: 脚本自超时 + 此处兜底强杀)
      const buildEnv = [
        `EM_CACHE=${cache}`,
        `HOME=${home}`,
        `TMPDIR=${wk}`,
        `BUILD_TIMEOUT_MS=${cfg.buildTimeoutMs}`,
      ];
      const r = await exec(
        ['sh', '-c', `node /opt/platform/build.js ${repo} ${src} ${out}`],
        { user: 'builder', env: buildEnv, timeoutMs: cfg.buildTimeoutMs + 15000 },
      );

      // 构建超时(容器已被强杀): 直接失败并附上已捕获的输出
      if (r.timedOut) {
        const partial = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
        return { ok: false, log: `构建超时(超过 ${timeoutS} 秒)\n${partial}`.trim(), sha };
      }

      // 6. 取出产物(含 status.json)
      staging = path.join(cfg.artifactsDir, workId, `.staging-${runId}`);
      fs.mkdirSync(staging, { recursive: true });
      let status = null;
      try {
        const stream = await w.handle.getTar(out);
        await extractTarToDir(stream, staging);
        status = readStatusJson(staging);
      } catch (err) {
        return { ok: false, log: `读取构建产物失败: ${err?.message || err}`, sha };
      }

      if (!status) {
        // 脚本异常退出但未写状态文件
        const partial = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
        return { ok: false, log: `构建失败(未生成状态文件)\n${partial}`.trim(), sha };
      }
      if (!status.ok) {
        return { ok: false, log: status.log, sha };
      }

      // 7. 安装产物: 去掉状态文件与符号链接, 原子替换 current
      fs.rmSync(path.join(staging, 'status.json'), { force: true });
      sanitizeSymlinks(staging);
      const target = path.join(cfg.artifactsDir, workId, 'current');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      fs.renameSync(staging, target);
      staging = null; // 已持久化(atomic rename 为 current), 不再清理
      return { ok: true, log: status.log, sha };
    } catch (err) {
      // 保留 sha(构建与提交绑定不因异常丢失)
      return { ok: false, log: `构建异常: ${err?.message || err}`, sha };
    } finally {
      // 8. 清除所有未持久化部分(安全要求):
      //    - 宿主 .staging-* 临时产物目录(未原子替换为 current 的一切内容)
      if (staging) {
        try {
          fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {
          /* 尽力而为 */
        }
      }
      //    - 容器内工作区(源码副本/独立缓存/临时文件/构建输出)
      try {
        await exec(['rm', '-rf', wk], { user: 'root', timeoutMs: 30000 });
      } catch {
        // 清理失败说明容器不健康: 物理销毁, 绝不复用带残留数据的容器
        w.dead = true;
        w.handle.remove().catch(() => {});
      }
    }
  }

  /** 把作品裸仓库打成 tar 拷入容器(条目统一加 repo/ 前缀) */
  async function putRepoInto(w, workId, wk) {
    const repoHost = path.join(cfg.reposDir, `${workId}.git`);
    const pack = tar.pack();
    const walk = (dir, rel) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, ent.name);
        const name = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isSymbolicLink()) continue; // 裸仓库不应含符号链接, 跳过
        if (ent.isDirectory()) {
          pack.entry({ name: `repo/${name}`, type: 'directory' });
          walk(abs, name);
        } else if (ent.isFile()) {
          const st = fs.statSync(abs);
          pack.entry(
            {
              name: `repo/${name}`,
              size: st.size,
              mode: (st.mode & 0o7777) || 0o644,
              mtime: st.mtime,
            },
            fs.readFileSync(abs),
          );
        }
      }
    };
    walk(repoHost, '');
    pack.finalize();
    await w.handle.putTar(pack, { path: wk });
  }

  /** 读取容器产物中的 status.json */
  function readStatusJson(staging) {
    try {
      const raw = fs.readFileSync(path.join(staging, 'status.json'), 'utf8');
      const s = JSON.parse(raw);
      return { ok: !!s.ok, log: typeof s.log === 'string' ? s.log : '' };
    } catch {
      return null;
    }
  }

  return {
    enqueue,
    queuePositionOf,
    start,
    stop,
    stats,
  };
}

// ---------------- tar 工具(容器产物取出) ----------------

/** 把容器 tar 流解包到本地目录(路径安全 + 跳过符号链接) */
export async function extractTarToDir(stream, destDir) {
  await new Promise((resolve, reject) => {
    const extract = tar.extract();
    extract.on('entry', (header, entryStream, next) => {
      const name = String(header.name || '').replace(/^\.?\//, '');
      if (
        !name ||
        name.split('/').includes('..') ||
        path.isAbsolute(name) ||
        header.type === 'symlink' ||
        header.type === 'link'
      ) {
        entryStream.resume();
        return next();
      }
      const abs = path.join(destDir, name);
      if (header.type === 'directory') {
        fs.mkdirSync(abs, { recursive: true });
        entryStream.resume();
        return next();
      }
      if (header.type === 'file' || !header.type) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const out = fs.createWriteStream(abs);
        entryStream.on('error', reject);
        out.on('error', reject);
        out.on('close', next); // close 在 fd 真正释放后触发(Windows rename 依赖)
        entryStream.pipe(out);
        return;
      }
      entryStream.resume();
      next();
    });
    extract.on('finish', resolve);
    extract.on('error', reject);
    stream.pipe(extract);
  });
}

/** 递归删除目录中的符号链接(产物落盘前清理, 防宿主机静态服务跟随) */
export function sanitizeSymlinks(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      fs.rmSync(abs, { force: true });
    } else if (ent.isDirectory()) {
      sanitizeSymlinks(abs);
    }
  }
}
