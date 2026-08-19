import nodemailer from 'nodemailer';

/**
 * 邮件服务 —— 邮箱验证 / 换绑邮箱通知。
 *
 * 两种模式:
 *   - SMTP 模式: 配置了 SMTP_HOST 后走 nodemailer 真实发送(生产)。
 *   - 开发模式: 未配置 SMTP 时, 验证链接打印到服务端控制台;
 *     注册/重发接口同时把 verificationToken 返回给调用方(仅开发模式),
 *     便于本地体验与自动化测试, 行为与生产一致(同样必须验证)。
 */
export function createMailer(cfg) {
  const smtp = cfg.smtp;
  const enabled = !!smtp.host;
  let transport = null;
  if (enabled) {
    transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    });
  }

  /** 验证链接: 指向前端 /verify 路由(SPA 内完成验证) */
  function verifyLink(token) {
    return `${cfg.publicUrl.replace(/\/+$/, '')}/verify?token=${encodeURIComponent(token)}`;
  }

  /**
   * 发送邮箱验证邮件。
   * @returns {{ sent: boolean, verificationToken: string, link: string }}
   *   dev 模式下 sent=false 但令牌仍在响应中返回(注册接口据此暴露给前端)。
   */
  async function sendVerification({ to, creator, token, kind }) {
    const link = verifyLink(token);
    const isRebind = kind === 'change_email';
    const subject = isRebind ? '确认更换邮箱 - 创玩 · C++ 创作平台' : '验证你的邮箱 - 创玩 · C++ 创作平台';
    const html = `<!doctype html><html><body style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#222">
      <h2 style="margin-top:0">${isRebind ? '确认更换邮箱' : '欢迎来到创玩'}</h2>
      <p>你好 <b>${escapeHtml(creator)}</b>：</p>
      <p>${isRebind
        ? '你请求把账号邮箱更换为这个地址。点击下方按钮完成换绑：'
        : '你正在注册创玩 · C++ 创作平台账号。点击下方按钮验证邮箱并完成注册：'}</p>
      <p style="text-align:center;margin:28px 0">
        <a href="${link}" style="display:inline-block;background:#3b82f6;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none">${isRebind ? '确认更换邮箱' : '验证邮箱'}</a>
      </p>
      <p style="color:#888;font-size:12px">如果按钮无法点击, 请复制以下链接到浏览器打开:<br>
        <a href="${link}" style="word-break:break-all">${link}</a><br><br>
        链接 24 小时内有效。如果不是你本人的操作, 请忽略这封邮件。</p>
    </body></html>`;

    if (!enabled) {
      console.log(`[mail] (开发模式, 未配置 SMTP) ${subject}\n[mail] 验证链接: ${link}`);
      return { sent: false, verificationToken: token, link };
    }
    try {
      await transport.sendMail({
        from: smtp.from,
        to,
        subject,
        html,
      });
      return { sent: true, verificationToken: token, link };
    } catch (err) {
      console.error('[mail] 邮件发送失败:', err?.message || err);
      throw Object.assign(new Error(`邮件发送失败: ${err?.message || 'SMTP 错误'}`), { mail: true });
    }
  }

  return { sendVerification, enabled };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
