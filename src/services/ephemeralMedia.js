// Carries the no-retry/no-store contract across sendHuman → sendReliable →
// transport. Async-local: never disable another chat's delivery receipts.
import { AsyncLocalStorage } from 'node:async_hooks';
const scope = new AsyncLocalStorage();
export const privateMedia = (fn) => scope.run(true, fn);
export const isPrivateMedia = () => scope.getStore() === true;

// A closed Cloud window / disconnected socket may keep a notification, but
// never the observation it replaced. This API deliberately accepts no body.
export function queueReviewPointer(sock, owner, number) {
  const chat = String(number).replace(/\D/g, '');
  return queueNotice(sock, owner, `Media needs human review. Open the original chat: +${chat}`);
}
export function quotaNotice(code) {
  if (!/^(?:videos|vision)_(?:day|month)$/.test(code)) return null;
  return `Media quota reached (${code}). New video requests will ask for a description. Check .media and your plan.`;
}
export function queueQuotaNotice(sock, owner, code) {
  const text = quotaNotice(code);
  return text ? queueNotice(sock, owner, text) : null;
}
// Private helper: only the fixed constructors above can enqueue a body.
function queueNotice(sock, owner, text) {
  return scope.exit(async () => {
    const { sendReliable, isRetryable } = await import('./outbox.js');
    const transport = {
      async sendMessage(jid, payload) {
        try {
          return await sock.sendMessage(jid, payload);
        } catch (err) {
          throw Error(isRetryable(err) ? 'network unavailable' : 'notification rejected');
        }
      },
    };
    return sendReliable(transport, owner, { text });
  });
}
