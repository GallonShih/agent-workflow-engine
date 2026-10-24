import type { RunServices } from './services.js';

/**
 * http_request 的 SSRF 防護（不 import node 模組，瀏覽器也能用）。
 * - 有 allowlist：hostname 必須在清單內（明確列出的 localhost 也允許）
 * - 沒有 allowlist：拒絕 loopback / 私有 / link-local（含雲端 metadata 169.254.169.254）/ 保留位址；
 *   Node 端會先做 DNS 解析再檢查（services.resolveHost）。httpAllowPrivate=true 可關閉。
 * 已知限制：解析與實際連線之間仍有 DNS rebinding 的 TOCTOU 空窗。
 */
function v4ToInt(ip: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return undefined;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return undefined;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

export function isPrivateAddress(addr: string): boolean {
  const ip = addr.replace(/^\[|\]$/g, '').toLowerCase();
  const n = v4ToInt(ip);
  if (n !== undefined) return V4_BLOCKED.some(([base, bits]) => n >>> (32 - bits) === v4ToInt(base)! >>> (32 - bits));
  if (!ip.includes(':')) return false;
  // IPv4-mapped / NAT64：::ffff:a.b.c.d、::ffff:7f00:1、64:ff9b::a.b.c.d
  const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return isPrivateAddress(mapped[1]);
  const hexMapped = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16), lo = parseInt(hexMapped[2], 16);
    return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (ip === '::' || ip === '::1') return true;
  const first = parseInt(ip.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 /* fc00::/7 */ || (first & 0xffc0) === 0xfe80 /* fe80::/10 */ || (first & 0xff00) === 0xff00 /* multicast */;
}

const isIpLiteral = (host: string) => v4ToInt(host) !== undefined || host.startsWith('[') || host.includes(':');

/** 檢查一個 URL 是否可以請求；不允許時 throw */
export async function assertUrlAllowed(url: URL, services: RunServices): Promise<void> {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`protocol not allowed: ${url.protocol}`);
  const host = url.hostname.toLowerCase();
  if (services.httpAllowHosts?.length) {
    if (!services.httpAllowHosts.map((h) => h.toLowerCase()).includes(host)) throw new Error(`host not in allowlist: ${url.hostname}`);
    return;
  }
  if (services.httpAllowPrivate) return;
  const blocked = (why: string) => new Error(`private/loopback address blocked: ${url.hostname}${why} (set HTTP_ALLOW_HOSTS or HTTP_ALLOW_PRIVATE=1 to allow)`);
  if (host === 'localhost' || host.endsWith('.localhost')) throw blocked('');
  if (isIpLiteral(host)) {
    if (isPrivateAddress(host)) throw blocked('');
    return;
  }
  if (services.resolveHost) {
    const addrs = await services.resolveHost(host).catch((e) => {
      throw new Error(`DNS lookup failed for ${host}: ${(e as Error).message}`);
    });
    const bad = addrs.find(isPrivateAddress);
    if (bad) throw blocked(` → ${bad}`);
  }
}
