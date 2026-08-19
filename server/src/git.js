import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from './errors.js';

const execFileP = promisify(execFile);

/**
 * Git 服务层 —— 平台内所有仓库操作统一走这里。
 *
 * 两种执行模式(由构建模式决定):
 *   local     宿主机直接执行 git(开发/降级/测试, 行为与历史版本一致)
 *   container 平台侧所有 git 命令都在一次性容器内执行:
 *             - 只挂载目标作品的裸仓库(/repo)与编辑器目录(/worktree),
 *               作品之间互不可见, 容器内无其他宿主机路径
 *             - --network none(无网络)、--cap-drop ALL、资源受限
 *             - 每次操作一个全新容器, 用完即毁, 无状态残留
 *             - 宿主机唯一还会接触用户 git 数据的是外部 git push 的
 *               receive-pack(用户明确接受的方案), 平台自身不再在
 *               宿主机运行任何处理用户仓库数据的 git 命令
 *
 * 仓库模型(每个作品一个独立仓库):
 *   - 裸仓库   data/repos/<id>.git     接收外部/编辑器推送, 默认分支 develop
 *   - 编辑器区 data/worktrees/<id>     普通目录(非 git 工作区), 供在线编辑器读写文件
 *   - 分支约定: 默认作品初始化两个分支 —— develop 内部开发不公开;
 *     main 发布分支(初始与 develop 对齐, 被推送即触发构建, 构建成功才公开)
 *
 * 安全防护(编辑器区由容器内 git 物化, 用户树可能含恶意符号链接):
 *   - 宿主机文件操作逐级校验路径组件, 拒绝符号链接(防越权读宿主机文件)
 *   - 文件树列出时跳过符号链接
 */
export function createGitService(cfg, deps) {
  const { getWebhookUrl, docker, mode } = deps;
  const containerMode = mode === 'container';

  // 宿主机真实路径(文件操作/挂载来源)
  const hostRepoDir = (id) => path.join(cfg.reposDir, `${id}.git`);
  const hostWorkDir = (id) => path.join(cfg.worktreesDir, id);
  // 容器内路径(git 命令参数; 与挂载点一一对应)
  const repoPath = '/repo';
  const worktreePath = '/worktree';
  const dataPath = '/data';
  const tmpInitPath = '/tmp-init';

  /** git 命令中使用的路径: 容器模式 → 容器路径, 本地模式 → 宿主机路径 */
  const repoDir = (id) => (containerMode ? repoPath : hostRepoDir(id));
  const workDir = (id) => (containerMode ? worktreePath : hostWorkDir(id));

  // ---------------- 执行后端 ----------------

  /** 本地执行 git(仅 local 模式) */
  async function runGitLocal(args, opts = {}) {
    try {
      const { stdout, stderr } = await execFileP('git', args, {
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        ...opts,
      });
      return { stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (err) {
      const detail = (err.stderr || '').trim() || (err.stdout || '').trim() || err.message;
      throw new AppError(`git 操作失败: ${detail || '未知错误'}`);
    }
  }

  /** 容器内执行 git(仅 container 模式); 一次性容器, 只挂载目标作品数据 */
  async function runGitContainer(args, opts = {}) {
    const r = await docker.runOnce({
      image: cfg.buildImage,
      cmd: opts.script ? undefined : args, // 无脚本时直接执行 git 命令
      script: opts.script,
      scriptArgs: opts.scriptArgs,
      binds: opts.mounts || [],
      env: opts.env || [],
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs || 60000,
      memoryMb: cfg.gitMemoryMb,
    });
    if (r.timedOut) throw new AppError('git 操作超时(容器内执行超过时限, 已强制终止)');
    if (r.exitCode !== 0) {
      const detail = (r.stderr || r.stdout || '').trim() || '未知错误';
      throw new AppError(`git 操作失败: ${detail}`);
    }
    return { stdout: r.stdout.trim(), stderr: r.stderr.trim() };
  }

  const runGit = (args, opts = {}) =>
    containerMode ? runGitContainer(args, opts) : runGitLocal(args, opts);

  // ---------------- 路径安全 ----------------

  /**
   * 路径穿越防护: 只允许访问 root 内部的相对路径。
   * 拒绝绝对路径、以 / 开头、以及任何包含 .. 段落的路径。
   */
  function safeJoin(root, rel) {
    if (typeof rel !== 'string' || !rel || rel.startsWith('/') || rel.split(/[\\/]/).includes('..')) {
      throw new AppError('非法文件路径');
    }
    const abs = path.resolve(root, rel);
    const relCheck = path.relative(root, abs);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) throw new AppError('非法文件路径');
    return abs;
  }

  /**
   * 符号链接防护: 编辑器目录由容器内 git 物化, 恶意仓库可植入符号链接;
   * 若宿主机文件操作跟随链接, 可越权读取宿主机任意文件。逐级校验:
   *   - 任一中间组件是符号链接 → 拒绝
   *   - 最终组件是符号链接 → 由调用方决定(读拒绝 / 写时替换)
   */
  function firstSymlink(root, rel) {
    let cur = root;
    for (const part of rel.split(/[\\/]/)) {
      cur = path.join(cur, part);
      let st;
      try {
        st = fs.lstatSync(cur);
      } catch {
        return null; // 不存在 → 由后续操作报错
      }
      if (st.isSymbolicLink()) return cur;
      if (!st.isDirectory()) return null; // 已是文件, 无更多层级
    }
    return null;
  }

  // ---------------- 仓库初始化 ----------------

  /**
   * 初始化作品仓库: 裸仓库(develop 默认分支) + 首提交 + 编辑器目录 + post-receive hook。
   * @param {string} workId 作品 ID(仓库目录名)
   * @param {Object<string,string>} files 模板文件(相对路径 -> 内容)
   */
  async function initRepo(workId, files) {
    const bare = hostRepoDir(workId);
    if (fs.existsSync(bare)) throw new AppError('仓库已存在');
    fs.mkdirSync(cfg.reposDir, { recursive: true });
    fs.mkdirSync(cfg.worktreesDir, { recursive: true });
    const editor = hostWorkDir(workId);
    fs.mkdirSync(editor, { recursive: true });

    // 首提交模板: 宿主机写入临时目录(平台自有文件, 安全), 容器内 git 提交
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cppplay-init-'));
    try {
      for (const [rel, content] of Object.entries(files)) {
        const abs = safeJoin(tmp, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
      }

      if (containerMode) {
        // 一次性容器完成全部初始化(模板数据是平台生成, 但 git 处理一律在容器内)
        const script = `set -e
git init --bare -b develop /data/$1.git
git -C /data/$1.git config user.name platform
git -C /data/$1.git config user.email platform@local
git -C /data/$1.git remote add origin /data/$1.git
cd /tmp-init
git init -b develop
git add -A
git -c user.name=platform -c user.email=platform@local commit -m init
git remote add origin /data/$1.git
git push -u origin develop
git -C /data/$1.git branch main develop
git --git-dir=/data/$1.git --work-tree=/worktree reset --hard develop
`;
        await runGit([], {
          script,
          scriptArgs: [workId],
          mounts: [
            { host: cfg.reposDir, container: dataPath, ro: false },
            { host: tmp, container: tmpInitPath, ro: false },
            { host: editor, container: worktreePath, ro: false },
          ],
        });
      } else {
        await runGit(['init', '--bare', '-b', 'develop', bare]);
        // 统一提交身份(编辑器提交时会被覆盖为创作者名称)
        await runGit(['-C', bare, 'config', 'user.name', 'platform']);
        await runGit(['-C', bare, 'config', 'user.email', 'platform@local']);

        await runGit(['init', '-b', 'develop'], { cwd: tmp });
        await runGit(['add', '-A'], { cwd: tmp });
        await runGit(
          ['-c', 'user.name=platform', '-c', 'user.email=platform@local', 'commit', '-m', '初始化作品'],
          { cwd: tmp },
        );
        await runGit(['remote', 'add', 'origin', bare], { cwd: tmp });
        await runGit(['push', '-u', 'origin', 'develop'], { cwd: tmp });

        // 编辑器目录: 普通目录, 用 reset 从 develop 物化出模板文件
        await runGit(['--git-dir=' + bare, '--work-tree=' + editor, 'reset', '--hard', 'develop']);

        // 编辑器通过裸仓库配置中的 origin(指向自身)完成发布推送
        await runGit(['-C', bare, 'remote', 'add', 'origin', bare]);
        // 默认作品双分支: main 与初始提交对齐
        await runGit(['-C', bare, 'branch', 'main', 'develop']);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }

    installHook(workId);
  }

  /**
   * 安装 post-receive hook:
   * 每当 main 分支收到推送, 回调平台 webhook, 触发"公开 + 构建"流水线。
   * 容器模式下外部 push 在宿主机 receive-pack 收(用户接受), hook 在宿主机生效;
   * 编辑器内部 push 的 hook 在容器内执行(无网络, 静默失败, 由平台直接触发构建)。
   */
  function installHook(workId) {
    const hookPath = path.join(hostRepoDir(workId), 'hooks', 'post-receive');
    // 容器模式下裸仓库由容器内 git 创建, 目录兜底(仓库缺失时由 init 报错, 不在这里崩溃)
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    const url = getWebhookUrl();
    const body = JSON.stringify({ workId });
    const secret = cfg.webhookSecret;
    const header = secret ? `-H 'X-Webhook-Secret: ${secret}' ` : '';
    const script = `#!/bin/sh
# 由创玩 · C++ 创作平台自动生成, 请勿手动修改
# main 分支被推送 -> 通知平台公开作品并执行构建
while read old_rev new_rev ref; do
  case "$ref" in
    refs/heads/main)
      if command -v curl >/dev/null 2>&1; then
        curl -s --max-time 600 -X POST "${url}" -H 'Content-Type: application/json' ${header}-d '${body}' >/dev/null 2>&1
      else
        powershell -NoProfile -Command "Invoke-RestMethod -Uri '${url}' -Method Post -ContentType 'application/json' ${header}-Body '${body}'" >/dev/null 2>&1
      fi
      ;;
  esac
done
exit 0
`;
    // 以 LF 写入并赋予可执行权限(git for windows 通过自带的 sh 执行 hook)
    fs.writeFileSync(hookPath, script, { encoding: 'utf8', mode: 0o755 });
  }

  // ---------------- 文件操作(编辑器目录 = develop 的物化内容) ----------------

  /** 列出工作区文件树(跳过 .git、node_modules 与符号链接) */
  function listFiles(workId) {
    const root = hostWorkDir(workId);
    const out = [];
    const walk = (dir, base) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === '.git' || ent.name === 'node_modules') continue;
        if (ent.isSymbolicLink()) continue; // 恶意符号链接不进文件树
        const abs = path.join(dir, ent.name);
        const rel = base ? `${base}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          out.push({ path: rel, type: 'dir', size: 0 });
          walk(abs, rel);
        } else {
          out.push({ path: rel, type: 'file', size: fs.statSync(abs).size });
        }
      }
    };
    walk(root, '');
    // 目录优先, 其余按字典序
    return out.sort((a, b) =>
      a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'dir' ? -1 : 1,
    );
  }

  function readFile(workId, rel) {
    const root = hostWorkDir(workId);
    const abs = safeJoin(root, rel);
    if (firstSymlink(root, rel)) throw new AppError('路径包含符号链接, 已阻止访问');
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new AppError('文件不存在', 404);
    const size = fs.statSync(abs).size;
    if (size > 4 * 1024 * 1024) throw new AppError('文件过大, 无法在线查看');
    return { path: rel, content: fs.readFileSync(abs, 'utf8'), size };
  }

  function writeFile(workId, rel, content) {
    const root = hostWorkDir(workId);
    const abs = safeJoin(root, rel);
    const link = firstSymlink(root, rel);
    if (link === abs) fs.unlinkSync(abs); // 最终组件是符号链接: 替换为普通文件
    else if (link) throw new AppError('路径包含符号链接, 已阻止写入');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }

  function deleteFile(workId, rel) {
    const abs = safeJoin(hostWorkDir(workId), rel);
    if (!fs.existsSync(abs)) throw new AppError('文件不存在', 404);
    fs.rmSync(abs, { recursive: true, force: true }); // rm 符号链接只删链接本身, 不跟随
  }

  function moveFile(workId, from, to) {
    const root = hostWorkDir(workId);
    const src = safeJoin(root, from);
    const dst = safeJoin(root, to);
    if (firstSymlink(root, from)) throw new AppError('路径包含符号链接, 已阻止移动');
    if (!fs.existsSync(src)) throw new AppError('源文件不存在', 404);
    if (fs.existsSync(dst)) throw new AppError('目标路径已存在');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
  }

  /** 编辑器上传目录(assets/), 自动创建 */
  function assetDir(workId) {
    const dir = path.join(hostWorkDir(workId), 'assets');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ---------------- 提交与发布 ----------------

  /** 提交全部改动到 develop(在线编辑器"提交"按钮) */
  async function commitDevelop(workId, message, author) {
    const bare = repoDir(workId);
    const editor = workDir(workId);
    // 直接以裸仓库 + 编辑器目录的方式提交(不经 worktree, 见模块顶部设计说明)
    const gitEnv = ['--git-dir=' + bare, '--work-tree=' + editor];
    if (containerMode) {
      // 状态检查 + 提交 + 取 sha 合并为一次容器执行(避免多次容器往返)
      const script = `st=$(git --git-dir=/repo --work-tree=/worktree status --porcelain)
[ -n "$st" ] || { echo __NO_CHANGES__; exit 0; }
git --git-dir=/repo --work-tree=/worktree add -A
git --git-dir=/repo --work-tree=/worktree -c user.name="$1" -c user.email="$1@local" commit -m "$2"
git -C /repo rev-parse develop
`;
      const r = await runGit([], {
        script,
        scriptArgs: [author, message || '更新作品'],
        mounts: [
          { host: hostRepoDir(workId), container: repoPath, ro: false },
          { host: hostWorkDir(workId), container: worktreePath, ro: false },
        ],
      });
      if (r.stdout.includes('__NO_CHANGES__')) throw new AppError('没有需要提交的改动');
      return r.stdout.split('\n').pop(); // 最后一行是 develop sha
    }
    const st = await runGit([...gitEnv, 'status', '--porcelain']);
    if (!st.stdout) throw new AppError('没有需要提交的改动');
    await runGit([...gitEnv, 'add', '-A']);
    await runGit([
      ...gitEnv,
      '-c', `user.name=${author}`, '-c', `user.email=${author}@local`,
      'commit', '-m', message || '更新作品',
    ]);
    return (await runGit(['-C', bare, 'rev-parse', 'develop'])).stdout;
  }

  /**
   * 发布: develop -> main。
   * 由裸仓库自身推送(develop:main), 经 post-receive hook 回调平台触发构建;
   * 容器模式下 hook 在容器内无网络静默失败, 平台在推送成功后直接触发构建。
   */
  async function publishDevelop(workId) {
    const bare = repoDir(workId);
    let r;
    try {
      if (containerMode) {
        r = await runGit(['-C', repoPath, '-c', `remote.origin.url=${repoPath}`, 'push', 'origin', 'develop:main'], {
          mounts: [{ host: hostRepoDir(workId), container: repoPath, ro: false }],
        });
      } else {
        r = await runGit(['-C', bare, 'push', 'origin', 'develop:main']);
      }
    } catch (err) {
      if (/non-fast-forward|fetch first/i.test(err.message)) {
        throw new AppError('main 分支包含 develop 没有的提交(非快进推送), 请使用 git 命令行合并后再发布', 409);
      }
      throw err;
    }
    if (/Everything up-to-date/i.test(`${r.stdout}\n${r.stderr}`)) {
      throw new AppError('main 分支与 develop 一致, 没有新的更新可发布');
    }
    return r.stdout;
  }

  /** 同步编辑器目录: 拉取外部 push 到 develop 的更新(要求目录干净) */
  async function syncWorktree(workId) {
    const bare = repoDir(workId);
    const editor = workDir(workId);
    const gitEnv = ['--git-dir=' + bare, '--work-tree=' + editor];
    if (containerMode) {
      const script = `st=$(git --git-dir=/repo --work-tree=/worktree status --porcelain)
[ -z "$st" ] || { echo __DIRTY__; exit 0; }
git --git-dir=/repo --work-tree=/worktree reset --hard develop
`;
      const r = await runGit([], {
        script,
        mounts: [
          { host: hostRepoDir(workId), container: repoPath, ro: true },
          { host: hostWorkDir(workId), container: worktreePath, ro: false },
        ],
      });
      if (r.stdout.includes('__DIRTY__')) {
        throw new AppError('编辑器里有未提交的改动, 请先提交或撤销后再同步', 409);
      }
      return;
    }
    const st = await runGit([...gitEnv, 'status', '--porcelain']);
    if (st.stdout) throw new AppError('编辑器里有未提交的改动, 请先提交或撤销后再同步', 409);
    await runGit([...gitEnv, 'reset', '--hard', 'develop']);
  }

  /** 分支最新提交 sha */
  async function headSha(workId, branch) {
    return (await runGit(['-C', repoDir(workId), 'rev-parse', branch], {
      mounts: containerMode ? [{ host: hostRepoDir(workId), container: repoPath, ro: true }] : [],
    })).stdout;
  }

  /** 提交历史(最近 n 条) */
  async function history(workId, branch, n = 50) {
    const r = await runGit([
      '-C', repoDir(workId), 'log', branch, `-n ${n}`,
      '--pretty=format:%h|%an|%at|%s',
    ], {
      mounts: containerMode ? [{ host: hostRepoDir(workId), container: repoPath, ro: true }] : [],
    });
    if (!r.stdout) return [];
    return r.stdout.split('\n').map((line) => {
      const parts = line.split('|');
      return {
        sha: parts[0],
        author: parts[1] || '',
        time: Number(parts[2] || 0) * 1000,
        message: parts.slice(3).join('|'), // 提交信息里可能含有 '|'
      };
    });
  }

  /**
   * 导出分支快照到目录(供编译)。
   * 容器模式下由构建容器内部完成(见 docker/build.js), 此处不执行 ——
   * 宿主机不再对用户仓库做任何检出操作。
   */
  async function exportTree(workId, branch, destDir) {
    if (containerMode) {
      throw new AppError('容器模式下快照导出由构建容器内部完成');
    }
    const bare = repoDir(workId);
    fs.mkdirSync(destDir, { recursive: true });
    // 临时索引放在目标目录之外(索引文件在 work-tree 内会导致 checkout 失效)
    const indexFile = path.join(path.dirname(destDir), `.git-index-${path.basename(destDir)}`);
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_INDEX_FILE: indexFile };
    try {
      await runGit(['--git-dir=' + bare, 'read-tree', branch], { env });
      await runGit(['--git-dir=' + bare, '--work-tree=' + destDir, 'checkout-index', '-a', '-f'], { env });
    } finally {
      fs.rmSync(indexFile, { force: true });
    }
  }

  /** 删除作品仓库(工作区 + 裸仓库) */
  function removeRepo(workId) {
    for (const dir of [hostWorkDir(workId), hostRepoDir(workId)]) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }

  /**
   * 对外 git 远程地址:
   *   - 配置了 GIT_BASE_URL(自建 SSH 等)则用 URL
   *   - 否则使用平台内置 git-over-HTTP(与请求同源, 生产/开发通用)
   */
  function remoteUrl(workId, req) {
    if (cfg.gitBaseUrl) return `${cfg.gitBaseUrl.replace(/\/+$/, '')}/${workId}.git`;
    const base = req ? `${req.protocol}://${req.get('host')}` : cfg.publicUrl;
    return `${base.replace(/\/+$/, '')}/git/${workId}.git`;
  }

  return {
    initRepo,
    listFiles,
    readFile,
    writeFile,
    deleteFile,
    moveFile,
    assetDir,
    commitDevelop,
    publishDevelop,
    syncWorktree,
    headSha,
    history,
    exportTree,
    removeRepo,
    remoteUrl,
    repoDir: hostRepoDir,
    workDir: hostWorkDir,
  };
}
