import Docker from 'dockerode';

/**
 * Docker 客户端封装 —— 平台与容器引擎的唯一交互点。
 *
 * 双平台自动适配(dockerode/docker-modem 原生支持):
 *   - Linux:    默认 unix socket /var/run/docker.sock
 *   - Windows:  默认命名管道 //./pipe/docker_engine
 *   - 任意:     DOCKER_HOST 环境变量可覆盖(如 tcp://host:2375)
 *
 * 对外只暴露最小异步接口, 便于测试注入假实现:
 *   ping()                引擎是否可达
 *   imageExists(name)     镜像是否存在
 *   runOnce(opts)         一次性容器(平台侧 git 操作; 用完即毁)
 *   createWorker(opts)    常驻构建工作容器(热备池)
 *
 * 安全基线(所有容器统一):
 *   - --network none           禁用网络(离线构建; 容器无法外联)
 *   - --cap-drop ALL           丢弃全部 Linux 能力
 *   - CPU / 内存 / 进程数上限   防资源耗尽
 *   - 构建容器以非特权用户运行用户代码, 且无任何宿主机挂载
 */

/** 解析 docker 多路复用帧(stdout=1 / stderr=2); 非帧数据整体视为 stdout */
function demux(buf) {
  const stdout = [];
  const stderr = [];
  let off = 0;
  let framed = false;
  while (off + 8 <= buf.length) {
    const stream = buf[off];
    const size = buf.readUInt32BE(off + 4);
    if (stream > 2 || off + 8 + size > buf.length) break;
    framed = true;
    (stream === 2 ? stderr : stdout).push(buf.subarray(off + 8, off + 8 + size));
    off += 8 + size;
  }
  if (!framed) return { stdout: buf.toString('utf8'), stderr: '' };
  if (off < buf.length) stdout.push(buf.subarray(off)); // 尾部残留按 stdout 处理
  return {
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

/** 收集可读流的所有数据 */
function collectStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

export function createDockerClient() {
  const docker = new Docker();

  /** 一次性容器: 创建 → 启动 → (可选)stdin 喂脚本 → 等待退出 → 收集输出 → 销毁 */
  async function runOnce(opts = {}) {
    const { image, cmd, script, scriptArgs = [], binds = [], env = [], cwd = '/' } = opts;
    const memoryMb = opts.memoryMb || 512;
    const timeoutMs = opts.timeoutMs || 60000;
    const container = await docker.createContainer({
      Image: image,
      Cmd: script ? ['/bin/sh', '-s', '--', ...scriptArgs] : cmd,
      Env: [...env],
      WorkingDir: cwd,
      OpenStdin: !!script,
      StdinOnce: !!script,
      HostConfig: {
        NetworkMode: 'none',
        Cpus: opts.cpus || 1,
        Memory: memoryMb * 1024 * 1024,
        MemorySwap: memoryMb * 1024 * 1024, // 与 Memory 相等 = 禁用 swap
        CapDrop: ['ALL'],
        PidsLimit: opts.pidsLimit || 128,
        Binds: binds.map((b) => `${b.host}:${b.container}${b.ro ? ':ro' : ''}`),
      },
    });
    try {
      await container.start();
      if (script) {
        const stream = await container.attach({ stream: true, stdin: true });
        stream.end(script);
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        container.kill().catch(() => {});
      }, timeoutMs);
      let status;
      try {
        status = await container.wait();
      } finally {
        clearTimeout(timer);
      }
      let raw = Buffer.alloc(0);
      try {
        const stream = await container.logs({ stdout: true, stderr: true });
        raw = await collectStream(stream);
      } catch {
        /* 日志不可用时不阻断 */
      }
      const { stdout, stderr } = demux(raw);
      await container.remove({ force: true }).catch(() => {});
      return { exitCode: status.StatusCode, stdout, stderr, timedOut };
    } catch (err) {
      await container.remove({ force: true }).catch(() => {});
      throw err;
    }
  }

  /** 常驻构建工作容器: sleep 常驻, 任务经 docker exec / cp 进出 */
  async function createWorker(opts = {}) {
    const memoryMb = opts.memoryMb || 2048;
    const container = await docker.createContainer({
      Image: opts.image,
      Cmd: opts.cmd || ['sleep', 'infinity'],
      // 构建镜像保证存在 UID 1000 用户(用户名随基础镜像变化, 不硬编码),
      // 以数字 UID 引用, 规避 "unable to find user" 类错误
      User: opts.user || '1000',
      Env: opts.env || [],
      // 平台标签: 启动时据此清理上次进程残留的孤儿容器(未持久化)
      Labels: { 'cppp.platform': 'build-worker' },
      HostConfig: {
        NetworkMode: 'none',
        Cpus: opts.cpus || 1,
        Memory: memoryMb * 1024 * 1024,
        MemorySwap: memoryMb * 1024 * 1024,
        CapDrop: ['ALL'],
        PidsLimit: opts.pidsLimit || 256,
        // 构建容器零宿主机挂载: 源码/产物全部经 docker cp 进出,
        // 容器内运行的用户代码看不到宿主机任何路径(作品间隔离 + 防逃逸)
        // 日志轮转: 常驻容器执行输出(可能含用户代码产物)不无限累积
        LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '2' } },
      },
    });
    await container.start();
    let dead = false;

    return {
      id: container.id,
      get alive() {
        return !dead;
      },
      /** 在容器内执行命令; 超过 timeoutMs 强杀容器(调用方据此判超时) */
      async exec({ cmd, user, env = [], cwd, timeoutMs }) {
        if (dead) throw new Error('容器已销毁');
        const exec = await container.exec({
          Cmd: cmd,
          User: user,
          Env: env,
          WorkingDir: cwd,
          AttachStdout: true,
          AttachStderr: true,
        });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          container.kill().catch(() => {});
        }, timeoutMs || 60000);
        let raw = Buffer.alloc(0);
        let info = { ExitCode: -1, Running: false };
        try {
          const stream = await exec.start({ hijack: false, stdin: false, Tty: false });
          raw = await collectStream(stream);
        } catch (err) {
          if (!timedOut) throw err; // 非超时错误上抛
        } finally {
          clearTimeout(timer);
        }
        if (timedOut) {
          dead = true; // 容器被强杀 -> 不健康, 由池销毁补建
        } else {
          info = await exec.inspect().catch(() => ({ ExitCode: -1, Running: false }));
        }
        const { stdout, stderr } = demux(raw);
        return { exitCode: info.ExitCode, stdout, stderr, timedOut };
      },
      /** 把 tar 流解包到容器内路径(docker cp 进) */
      async putTar(stream, path) {
        if (dead) throw new Error('容器已销毁');
        await container.putArchive(stream, { path });
      },
      /** 取回容器内路径的 tar 流(docker cp 出) */
      async getTar(path) {
        if (dead) throw new Error('容器已销毁');
        return container.getArchive({ path });
      },
      async kill() {
        dead = true;
        await container.kill().catch(() => {});
      },
      async remove() {
        dead = true;
        await container.remove({ force: true }).catch(() => {});
      },
      async isRunning() {
        const info = await container.inspect().catch(() => null);
        return !!(info && info.State && info.State.Running);
      },
    };
  }

  return {
    ping: () => docker.ping(),
    async imageExists(name) {
      try {
        await docker.getImage(name).inspect();
        return true;
      } catch {
        return false;
      }
    },
    runOnce,
    createWorker,
    /** 列出平台残留的构建容器(带标签; 供启动时清理上次进程的孤儿容器) */
    async listWorkers() {
      const list = await docker.listContainers({
        all: true,
        filters: { label: ['cppp.platform=build-worker'] },
      });
      return (list || []).map((c) => c.Id);
    },
    /** 强制删除容器(孤儿清理用) */
    async removeWorker(id) {
      await docker.getContainer(id).remove({ force: true }).catch(() => {});
    },
  };
}
