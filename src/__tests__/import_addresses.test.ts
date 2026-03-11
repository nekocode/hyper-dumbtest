import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import {
  countAddresses,
  getDistinctAddressesByGroup,
  initDatabase,
  insertAddresses,
} from "../lib/db.js";
import type { AddressRow } from "../lib/types.js";
import type Database from "better-sqlite3";

const TEST_DB = "./test_import.sqlite";
const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

function cleanup() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = TEST_DB + suffix;
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
}

function makeAddress(
  address: string,
  groupName: string,
  discoveredAt = "2026-03-10",
  accountBalance: number | null = null,
): AddressRow {
  return {
    address,
    group_name: groupName,
    discovered_at: discoveredAt,
    account_balance: accountBalance,
    raw_json: "{}",
  };
}

describe("address validation", () => {
  it("should accept valid Ethereum addresses", () => {
    expect(
      ADDRESS_REGEX.test("0x1234567890abcdef1234567890abcdef12345678"),
    ).toBe(true);
    expect(
      ADDRESS_REGEX.test("0xABCDEF1234567890ABCDEF1234567890ABCDEF12"),
    ).toBe(true);
    expect(
      ADDRESS_REGEX.test("0x0000000000000000000000000000000000000000"),
    ).toBe(true);
  });

  it("should reject addresses without 0x prefix", () => {
    expect(ADDRESS_REGEX.test("1234567890abcdef1234567890abcdef12345678")).toBe(
      false,
    );
  });

  it("should reject addresses with wrong length", () => {
    expect(ADDRESS_REGEX.test("0x1234")).toBe(false);
    expect(
      ADDRESS_REGEX.test("0x1234567890abcdef1234567890abcdef123456789"),
    ).toBe(false);
  });

  it("should reject addresses with non-hex characters", () => {
    expect(
      ADDRESS_REGEX.test("0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG"),
    ).toBe(false);
  });

  it("should reject empty string", () => {
    expect(ADDRESS_REGEX.test("")).toBe(false);
  });
});

describe("manual address import to DB", () => {
  let db: Database.Database;

  beforeEach(() => {
    cleanup();
    db = initDatabase(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  it("should insert addresses with account snapshots", () => {
    const rows = [
      makeAddress(
        "0x1111111111111111111111111111111111111111",
        "alpha",
        "2026-03-10",
        1200,
      ),
      makeAddress(
        "0x2222222222222222222222222222222222222222",
        "alpha",
        "2026-03-10",
        2500,
      ),
    ];

    const inserted = insertAddresses(db, rows);
    expect(inserted).toBe(2);
    expect(countAddresses(db, "alpha")).toBe(2);
  });

  it("should deduplicate on same address+group+date", () => {
    const row = makeAddress(
      "0x1111111111111111111111111111111111111111",
      "alpha",
    );
    insertAddresses(db, [row]);
    const inserted = insertAddresses(db, [row]);

    expect(inserted).toBe(0);
    expect(countAddresses(db, "alpha")).toBe(1);
  });

  it("should allow same address in different groups", () => {
    const address = "0x1111111111111111111111111111111111111111";
    insertAddresses(db, [makeAddress(address, "alpha")]);
    const inserted = insertAddresses(db, [makeAddress(address, "beta")]);

    expect(inserted).toBe(1);
    expect(countAddresses(db, "alpha")).toBe(1);
    expect(countAddresses(db, "beta")).toBe(1);
  });

  it("should appear in getDistinctAddressesByGroup for crawl", () => {
    const address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    insertAddresses(db, [makeAddress(address, "alpha")]);

    const groupAddresses = getDistinctAddressesByGroup(db, "alpha");
    expect(groupAddresses).toContain(address);
  });
});
