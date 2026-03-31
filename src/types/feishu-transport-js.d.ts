declare module "*feishu/transport.js" {
  export const FEISHU_TRANSPORT_WEBHOOK: string;
  export const FEISHU_TRANSPORT_LONG_CONNECTION: string;

  export function normalizeFeishuTransport(value: unknown): string;
  export function isFeishuWebhookTransport(value: unknown): boolean;
  export function isFeishuLongConnectionTransport(value: unknown): boolean;
}
