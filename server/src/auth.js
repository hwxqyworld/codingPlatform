import crypto from 'node:crypto';
import { AppError } from './errors.js';

/**
 * 账号系统 —— 用户名 + 密码 + 邮箱验证。
 *
 * 安全设计:
 *   - 密码使用 Node 内置 scrypt 加盐哈希(crypto.scrypt, 无第三方依赖),
 *     校验用 timingSafeEqual 防时序攻击
 *   - 邮箱必须验证后才能绑定/登录; 未验证邮箱不占唯一索引(防邮箱抢占)
 *   - 修改密码后轮换 bearer token, 使旧会话全部失效
 *   - 早期免密账号(password_hash 为空)保留登录兼容: 凭旧 token 设置密码
 *     (LEGACY_NEEDS_SETUP 流程), 设置后即为完整账号
 *   - 登录/注册等认证接口另有 IP 限流(见 routes.js)
 */

const USERNAME_RE = /^[\w\u4e00-\u9fa5-]{1,32}$/; // 字母/数字/下划线/中文/连字符
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createAuth(cfg, db, mailer) {
  // ---------------- 密码 ----------------

  /** scrypt 加盐哈希: 返回 "salt:hash"(hex) */
  function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, 32);
    return `${salt.toString('hex')}:${hash.toString('hex')}`;
  }

  function verifyPassword(password, stored) {
    if (!stored) return false;
    const [saltHex, hashHex] = String(stored).split(':');
    if (!saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  }

  // ---------------- 校验 ----------------

  function validateUsername(name) {
    const clean = String(name || '').trim();
    if (!USERNAME_RE.test(clean)) {
      throw new AppError('用户名需为 1-32 位, 仅限中文、字母、数字、下划线或连字符');
    }
    return clean;
  }

  function validatePassword(password) {
    const pw = String(password || '');
    if (pw.length < cfg.minPasswordLen) {
      throw new AppError(`密码至少需要 ${cfg.minPasswordLen} 位`);
    }
    if (pw.length > 128) throw new AppError('密码过长(最多 128 位)');
    return pw;
  }

  function validateEmail(email) {
    const clean = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(clean) || clean.length > 200) throw new AppError('邮箱格式不正确');
    return clean;
  }

  // ---------------- 验证令牌 ----------------

  /** 生成验证令牌并落库; 同账号同用途的旧令牌先清除(防重复/占位) */
  function issueVerifyToken(creator, kind, email) {
    const token = crypto.randomBytes(24).toString('hex');
    db.insertVerifyToken({ token, creator, kind, email });
    return token;
  }

  /** 校验并消费验证令牌(过期/不存在均报错), 返回令牌记录 */
  function consumeVerifyToken(token) {
    db.purgeVerifyTokens(Date.now() - cfg.verifyTokenTtlMs); // 顺带清理过期
    const rec = db.getVerifyToken(token);
    if (!rec) throw new AppError('验证链接无效或已过期, 请重新发送', 400);
    db.deleteVerifyToken(token);
    return rec;
  }

  // ---------------- 账号操作 ----------------

  /**
   * 注册: 用户名 + 密码 + 邮箱。
   * 账号先以"未验证"状态创建(email 落库在验证通过后);
   * 发送验证邮件, 返回验证令牌(开发模式)供前端展示。
   */
  async function register({ username, password, email }) {
    if (!cfg.allowRegistration) throw new AppError('平台已关闭公开注册', 403);
    const name = validateUsername(username);
    const pw = validatePassword(password);
    const mail = validateEmail(email);
    if (db.getUser(name)) throw new AppError('用户名已被占用', 409);
    if (db.getUserByEmail(mail)) throw new AppError('该邮箱已被其他账号绑定', 409);

    db.registerUser({ name, passwordHash: hashPassword(pw) });
    const token = issueVerifyToken(name, 'register', mail);
    const r = await mailer.sendVerification({ to: mail, creator: name, token, kind: 'register' });
    return { name, needsVerify: true, ...(r.sent ? {} : { verificationToken: r.verificationToken }) };
  }

  /** 验证邮箱(注册验证 / 换绑邮箱共用): 校验通过后把邮箱写入账号 */
  function verifyEmail(token) {
    const rec = consumeVerifyToken(token);
    const user = db.getUser(rec.creator);
    if (!user) throw new AppError('账号不存在', 404);
    if (rec.kind === 'change_email' && db.getUserByEmail(rec.email)) {
      throw new AppError('该邮箱已被其他账号绑定', 409);
    }
    db.bindEmail(rec.creator, rec.email);
    return { name: rec.creator, email: rec.email, kind: rec.kind };
  }

  /**
   * 重发验证邮件: 需凭 用户名/邮箱 + 密码 证明身份(与登录同强度)。
   * 未验证邮箱尚未落库, 因此凭用户名取回其待验证邮箱。
   */
  async function resendVerification({ account, password }) {
    const clean = String(account || '').trim().toLowerCase();
    if (!clean) throw new AppError('请输入用户名或邮箱');
    const user =
      (db.getUser(clean) || (EMAIL_RE.test(clean) ? db.getUserByEmail(clean) : null));
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new AppError('用户名/邮箱或密码不正确', 401);
    }
    if (user.email_verified && user.email) {
      throw new AppError('邮箱已验证, 无需重新发送');
    }
    const pending = db.latestVerifyToken(user.name, 'register');
    const email = pending?.email;
    if (!email) throw new AppError('没有待验证的邮箱, 请重新注册');
    const token = issueVerifyToken(user.name, 'register', email);
    const r = await mailer.sendVerification({ to: email, creator: user.name, token, kind: 'register' });
    return { name: user.name, ...(r.sent ? {} : { verificationToken: r.verificationToken }) };
  }

  /**
   * 登录: account 支持用户名或已验证邮箱, 需密码。
   * 早期免密账号(legacy)返回 LEGACY_NEEDS_SETUP, 前端引导设置密码。
   */
  function login({ account, password }) {
    const clean = String(account || '').trim();
    if (!clean || !password) throw new AppError('请输入用户名/邮箱和密码');
    const user =
      (db.getUser(clean) ||
        (EMAIL_RE.test(clean.toLowerCase()) ? db.getUserByEmail(clean.toLowerCase()) : null));
    if (!user) throw new AppError('用户名/邮箱或密码不正确', 401);

    // 早期免密账号: 无法用密码登录; 凭旧 token 走"设置密码"流程(见 setupPassword)
    if (!user.password_hash) {
      const err = new AppError('该账号是早期免密账号, 请先用已有会话设置密码', 401);
      err.code = 'LEGACY_NEEDS_SETUP';
      throw err;
    }
    if (!verifyPassword(password, user.password_hash)) {
      throw new AppError('用户名/邮箱或密码不正确', 401);
    }
    return { name: user.name, token: user.token, user: ownUser(user) };
  }

  /**
   * 早期免密账号升级: 凭旧 token(证明持有会话)设置密码, 可选绑定邮箱。
   * 设置后立即成为完整账号, 旧 token 继续有效(不再轮换, 保留使用体验)。
   */
  async function setupPassword(creatorName, { password, email }) {
    const user = db.getUser(creatorName);
    if (!user) throw new AppError('账号不存在', 404);
    if (user.password_hash) throw new AppError('该账号已设置密码, 无需重复设置');
    const pw = validatePassword(password);
    db.setPassword(user.name, hashPassword(pw));
    if (email !== undefined && email !== null && String(email).trim() !== '') {
      const mail = validateEmail(email);
      if (db.getUserByEmail(mail)) throw new AppError('该邮箱已被其他账号绑定', 409);
      const token = issueVerifyToken(user.name, 'register', mail);
      await mailer.sendVerification({ to: mail, creator: user.name, token, kind: 'register' });
      return { name: user.name, needsVerify: true, ...(mailer.enabled ? {} : { verificationToken: token }) };
    }
    return { name: user.name, needsVerify: false };
  }

  /** 修改密码: 校验当前密码; 成功后轮换 token(旧会话全部失效), 返回新 token */
  function changePassword(creatorName, { currentPassword, newPassword }) {
    const user = db.getUser(creatorName);
    if (!user?.password_hash || !verifyPassword(currentPassword, user.password_hash)) {
      throw new AppError('当前密码不正确', 401);
    }
    const next = validatePassword(newPassword);
    const updated = db.setPassword(user.name, hashPassword(next));
    return { token: updated.token };
  }

  /** 换绑邮箱: 生成 change_email 令牌并发送到新邮箱; 验证通过后替换 */
  async function requestEmailChange(creatorName, newEmail) {
    const user = db.getUser(creatorName);
    const mail = validateEmail(newEmail);
    if (user.email === mail && user.email_verified) {
      throw new AppError('新邮箱与当前邮箱相同');
    }
    if (db.getUserByEmail(mail)) throw new AppError('该邮箱已被其他账号绑定', 409);
    const token = issueVerifyToken(user.name, 'change_email', mail);
    const r = await mailer.sendVerification({ to: mail, creator: user.name, token, kind: 'change_email' });
    return { sent: r.sent, ...(r.sent ? {} : { verificationToken: r.verificationToken }) };
  }

  /** 本人视角的用户信息(含邮箱/验证状态/是否有密码, 仅登录者可见) */
  function ownUser(user) {
    return {
      ...publicUser(user),
      email: user.email || '',
      emailVerified: !!user.email_verified,
      hasPassword: !!user.password_hash,
    };
  }

  /** 对外公开的用户信息(不含 email 之外的隐私字段; 邮箱仅本人可见) */
  function publicUser(user) {
    return {
      name: user.name,
      nickname: user.nickname || user.name,
      bio: user.bio || '',
      avatar: user.avatar || '',
      createdAt: user.created_at,
    };
  }

  // ---------------- 中间件 ----------------

  /** 必须登录的中间件: 校验通过后 req.creator = 创作者名称 */
  function middleware() {
    return (req, res, next) => {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const creator = token && db.findByToken(token);
      if (!creator) {
        return res.status(401).json({ ok: false, error: '未登录或登录已过期' });
      }
      req.creator = creator.name;
      req.user = creator;
      next();
    };
  }

  /** 可选登录的中间件: 携带有效 token 时识别本人, 否则匿名继续 */
  function optionalMiddleware() {
    return (req, res, next) => {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const creator = token && db.findByToken(token);
      if (creator) {
        req.creator = creator.name;
        req.user = creator;
      }
      next();
    };
  }

  /**
   * git-over-HTTP 的 Basic 认证: 支持两种凭证 ——
   *   用户名 = 创作者名称; 密码 = 账号密码 或 会话 token(旧客户端)
   * 校验通过后 req.creator = 创作者名称。
   */
  function basicAuth() {
    return (req, res, next) => {
      const header = String(req.headers.authorization || '');
      if (!/^Basic\s+/i.test(header)) {
        return challenge(res, '请提供账号密码或访问令牌');
      }
      const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      const user = idx === -1 ? decoded : decoded.slice(0, idx);
      const secret = idx === -1 ? '' : decoded.slice(idx + 1);
      const creator = db.getUser(user);
      if (!creator) return challenge(res, '账号不存在');
      const okPassword = creator.password_hash && verifyPassword(secret, creator.password_hash);
      // 会话 token 长度固定, 与密码不同长时直接不匹配(timingSafeEqual 要求等长)
      const secretBuf = Buffer.from(secret);
      const tokenBuf = creator.token ? Buffer.from(creator.token) : null;
      const okToken =
        !!tokenBuf &&
        tokenBuf.length === secretBuf.length &&
        crypto.timingSafeEqual(tokenBuf, secretBuf);
      if (!okPassword && !okToken) return challenge(res, '账号或密码不正确');
      req.creator = creator.name;
      req.user = creator;
      next();
    };
  }

  /**
   * 可选 Basic 认证(git 匿名读用): 凭证有效则识别本人, 否则匿名继续。
   * 凭证格式异常时同样静默放行(由路由层按公开/私有决定是否拒绝)。
   */
  function optionalBasicAuth() {
    return (req, res, next) => {
      const header = String(req.headers.authorization || '');
      if (!/^Basic\s+/i.test(header)) return next();
      let decoded = '';
      try {
        decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
      } catch {
        return next();
      }
      const idx = decoded.indexOf(':');
      const user = idx === -1 ? decoded : decoded.slice(0, idx);
      const secret = idx === -1 ? '' : decoded.slice(idx + 1);
      const creator = db.getUser(user);
      if (!creator) return next();
      const okPassword = creator.password_hash && verifyPassword(secret, creator.password_hash);
      // 会话 token 长度固定, 与密码不同长时直接不匹配(timingSafeEqual 要求等长)
      const secretBuf = Buffer.from(secret);
      const tokenBuf = creator.token ? Buffer.from(creator.token) : null;
      const okToken =
        !!tokenBuf &&
        tokenBuf.length === secretBuf.length &&
        crypto.timingSafeEqual(tokenBuf, secretBuf);
      if (!okPassword && !okToken) return next();
      req.creator = creator.name;
      req.user = creator;
      next();
    };
  }

  function challenge(res, message) {
    res.setHeader('WWW-Authenticate', 'Basic realm="cppplay"');
    return res.status(401).json({ ok: false, error: message });
  }

  return {
    register,
    verifyEmail,
    resendVerification,
    login,
    setupPassword,
    changePassword,
    requestEmailChange,
    publicUser,
    ownUser,
    middleware,
    optionalMiddleware,
    basicAuth,
    optionalBasicAuth,
    hashPassword,
  };
}
