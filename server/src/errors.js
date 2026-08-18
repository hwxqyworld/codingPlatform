/**
 * 业务错误类型。
 *
 * 路由层抛出的 AppError 会由统一的错误处理中间件转换为
 * 对应 HTTP 状态码的 JSON 响应, 避免在每个接口里重复写错误分支。
 */
export class AppError extends Error {
  /**
   * @param {string} message 面向用户的错误信息(简体中文)
   * @param {number} status  HTTP 状态码, 默认 400
   */
  constructor(message, status = 400) {
    super(message);
    this.name = 'AppError';
    this.status = status;
  }
}
