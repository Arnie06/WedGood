import { describe, expect, it } from "vitest";
import { isPublicAddress } from "./ip-policy";

describe("isPublicAddress", () => {
  it("allows ordinary public addresses", () => {
    for (const ip of [
      "93.184.216.34",
      "8.8.8.8",
      "1.1.1.1",
      "2606:4700:4700::1111",
      "2a00:1450:4001::200e",
    ])
      expect(isPublicAddress(ip), ip).toBe(true);
  });

  it("refuses private, loopback, link-local and reserved IPv4", () => {
    for (const ip of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "127.255.255.254",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.8",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.7",
      "203.0.113.9",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
  });

  it("does not over-block the neighbours of private ranges", () => {
    for (const ip of [
      "172.15.255.255",
      "172.32.0.1",
      "11.0.0.1",
      "100.63.255.255",
      "100.128.0.1",
      "192.167.1.1",
    ])
      expect(isPublicAddress(ip), ip).toBe(true);
  });

  it("refuses private, loopback, link-local and special IPv6", () => {
    for (const ip of [
      "::",
      "::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
      "2001:db8::1",
      "64:ff9b::1",
      "2002:7f00:1::1",
      "100::1",
      "2001::1",
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
  });

  it("judges IPv4 embedded in IPv6 as IPv4", () => {
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:7f00:1")).toBe(false);
    expect(isPublicAddress("::ffff:10.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:169.254.169.254")).toBe(false);
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
  });

  it("refuses anything that is not an IP address", () => {
    for (const s of ["", "localhost", "example.com", "1.2.3", "999.1.1.1", "::g"])
      expect(isPublicAddress(s), s).toBe(false);
  });
});
