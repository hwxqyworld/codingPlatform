import fs from 'node:fs';
import path from 'node:path';
import tar from 'tar-stream';

/**
 * 假 Docker 客户端 —— 模拟 dockerClient.js 的最小异步接口, 供容器模式测试注入。
 *
 * 行为:
 *   - runOnce(平台侧 git 操作): 按命令特征返回模拟输出(rev-parse -> sha 等),
 *     并记录全部调用(测试断言挂载/脚本内容)
 *   - createWorker(构建容器): 返回假 worker;
 *     exec 中识别构建步骤(node build.js), 按 build 配置模拟结果:
 *       { ok: true }        -> 成功, getTar 返回含 status.json + 产物的 tar
 *       { ok: false }       -> 失败, getTar 返回含 status.json(ok:false) 的 tar
 *       { timedOut: true }  -> exec 返回 timedOut(模拟容器被强杀)
 *       { hang: true }      -> exec 挂起, 超时后返回 timedOut(模拟卡死的构建)
 *   - workerGate: createWorker 挂起直到 release()(用于构造确定的排队场景)
 *   - preExistingWorkers: 预置 N 个"上次进程残留"的孤儿容器(测试启动清理)
 *   - listWorkers/removeWorker: 对应 dockerClient 的孤儿容器查询与删除
 */
export function makeFakeDocker(opts = {}) {
  const {
    imageExists = true,
    build = { ok: true, log: 'fake build ok' },
    workerGate = null, // { promise, release, after? }: 第 after+1 次 createWorker 起挂起(默认 0 = 全部挂起)
    preExistingWorkers = 0, // 预置孤儿容器数量
  } = opts;
  const calls = { runOnce: [], createWorker: [], exec: [], putTar: [], getTar: [], kill: [], remove: [], ping: 0 };
  let shaSeq = 0;
  let workerSeq = 0;
  const knownWorkers = new Map(); // 全部已创建的 worker(含预置孤儿), 供 listWorkers/removeWorker
  const nextSha = () => 'f' + (++shaSeq).toString(16).padStart(7, '0') + 'a'.repeat(24);

  // 预置"上次进程残留"的孤儿构建容器
  for (let i = 0; i < preExistingWorkers; i++) {
    const id = `orphan-${i + 1}`;
    knownWorkers.set(id, { id, alive: true, orphan: true });
  }

  const docker = {
    async ping() {
      calls.ping++;
    },
    async imageExists() {
      return imageExists;
    },

    async runOnce(o) {
      calls.runOnce.push(o);
      const joined = [...(o.cmd || []), o.script || ''].join(' ');
      // 模拟容器内 git init 的宿主副作用: 在挂载的数据目录创建裸仓库目录
      if (o.script && o.script.includes('init --bare') && o.binds?.[0]) {
        const dataBind = o.binds.find((b) => b.container === '/data');
        if (dataBind && o.scriptArgs?.[0]) {
          fs.mkdirSync(path.join(dataBind.host, `${o.scriptArgs[0]}.git`), { recursive: true });
        }
      }
      // git rev-parse -> 模拟 sha
      if (joined.includes('rev-parse')) return { exitCode: 0, stdout: nextSha(), stderr: '', timedOut: false };
      // 提交脚本(commit -m + rev-parse) -> 模拟 sha
      if (o.script && o.script.includes('commit -m')) {
        return { exitCode: 0, stdout: nextSha(), stderr: '', timedOut: false };
      }
      // 其他 git 操作默认成功
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    },

    async createWorker(o) {
      calls.createWorker.push(o);
      const callNo = calls.createWorker.length;
      if (workerGate && callNo > (workerGate.after ?? 0)) await workerGate.promise;
      const id = 'worker-' + (++workerSeq);
      const w = {
        id,
        alive: true,
        async exec({ cmd, user, env, cwd, timeoutMs }) {
          if (!w.alive) throw new Error('容器已销毁'); // 与真实 dockerClient 一致
          calls.exec.push({ id, cmd, user, env, cwd });
          const isBuild = Array.isArray(cmd) && cmd.some((c) => String(c).includes('build.js'));
          if (isBuild) {
            if (build.hang) {
              // 模拟卡死的构建: 永远不返回(任务挂起, 直到测试结束被丢弃)
              await new Promise(() => {});
            }
            if (build.timedOut) {
              // 超时 -> 容器被强杀(与真实 dockerClient.exec 一致)
              w.alive = false;
              calls.kill.push(id);
              return { exitCode: -1, stdout: '', stderr: '', timedOut: true };
            }
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
          }
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
        },
        async putTar(stream, p) {
          calls.putTar.push({ id, p });
          await drainStream(stream);
        },
        async getTar(p) {
          calls.getTar.push({ id, p });
          return tarOfOut(build);
        },
        async kill() {
          calls.kill.push(id);
          w.alive = false;
        },
        async remove() {
          calls.remove.push(id);
          w.alive = false;
        },
        async isRunning() {
          return w.alive;
        },
      };
      knownWorkers.set(id, w);
      return w;
    },

    // 孤儿容器查询/删除(与 dockerClient 接口一致)
    async listWorkers() {
      return [...knownWorkers.values()].filter((x) => x.alive).map((x) => x.id);
    },
    async removeWorker(id) {
      const w = knownWorkers.get(id);
      if (w) {
        w.alive = false;
        calls.remove.push(id);
      }
    },
  };
  return { docker, calls };
}

/** 消耗流直到结束 */
function drainStream(stream) {
  return new Promise((resolve, reject) => {
    stream.on('data', () => {});
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}

/** 按构建配置生成产物 tar(目录内容): status.json + (成功时)index.html/js/wasm */
function tarOfOut(build) {
  const pack = tar.pack();
  const entries = [];
  if (build.ok) {
    entries.push(
      ['status.json', JSON.stringify({ ok: true, log: build.log || 'fake build ok' })],
      ['index.html', '<html>fake</html>'],
      ['index.js', '// fake'],
      ['index.wasm', 'wasm-bytes'],
    );
  } else if (build.ok === false) {
    entries.push(['status.json', JSON.stringify({ ok: false, log: build.log || 'fake build failure' })]);
  }
  // hang / timedOut: 空 tar(无 status.json, 模拟容器被强杀)
  for (const [name, content] of entries) {
    pack.entry({ name, size: Buffer.byteLength(content), mode: 0o644 }, Buffer.from(content));
  }
  pack.finalize();
  return pack;
}
