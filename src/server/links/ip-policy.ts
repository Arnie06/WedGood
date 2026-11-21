import { BlockList, isIP } from "node:net";

/**
 * Which addresses the link lookup may connect to (ADR-029): public unicast only.
 * Everything else, including every range an attacker could use to reach internal
 * services or cloud metadata, is refused. Embedded IPv4 inside IPv6 forms is unwrapped
 * and judged as IPv4.
 */
const blocked = new BlockList();

const V4: ReadonlyArray<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved and broadcast
];
for (const [net, prefix] of V4) blocked.addSubnet(net, prefix, "ipv4");

const V6: ReadonlyArray<[string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64 (unwrapped below, also blocked outright)
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (unwrapped below, also blocked outright)
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
];
for (const [net, prefix] of V6) blocked.addSubnet(net, prefix, "ipv6");

/** If the IPv6 text is an IPv4-mapped or IPv4-compatible form, returns the IPv4 address. */
function embeddedV4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^(?:::ffff:|::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted?.[1]) return dotted[1];
  const hex = /^(?:::ffff:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex?.[1] && hex[2]) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) {
    const v4 = embeddedV4(address);
    if (v4 !== null) return isPublicAddress(v4);
    return !blocked.check(address, "ipv6");
  }
  return false;
}
