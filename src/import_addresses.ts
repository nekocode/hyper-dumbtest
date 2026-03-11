import "dotenv/config";
import { program } from "commander";
import { HyperbotClient } from "./lib/hyperbot.js";
import { countAddresses, initDatabase, insertAddresses } from "./lib/db.js";
import { log } from "./lib/logger.js";
import { normalizeAddress } from "./lib/utils.js";
import type { AddressRow, TraderAccount } from "./lib/types.js";

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
const DISCOVERED_AT_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const ACCOUNT_BATCH_SIZE = 50;

export function parseAndValidateAddresses(input: string): string[] {
  const addresses = input
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);

  if (addresses.length === 0) {
    throw new Error("未提供地址");
  }

  for (const address of addresses) {
    if (!ADDRESS_REGEX.test(address)) {
      throw new Error(
        `地址格式无效: ${address}（需 0x + 40 位十六进制）`,
      );
    }
  }

  return [...new Set(addresses)];
}

function validateDiscoveredAt(value: string): string {
  if (!DISCOVERED_AT_REGEX.test(value)) {
    throw new Error("--discovered-at 格式无效（需 YYYY-MM-DD）");
  }

  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error("--discovered-at 值无效（无法解析日期）");
  }

  return value;
}

function toAddressRow(
  address: string,
  groupName: string,
  discoveredAt: string,
  account: TraderAccount | null,
): AddressRow {
  const totalValueRaw = account?.totalValue;
  const accountBalance =
    totalValueRaw !== undefined ? parseFloat(totalValueRaw) : null;

  return {
    address,
    group_name: groupName,
    discovered_at: discoveredAt,
    account_balance: Number.isFinite(accountBalance) ? accountBalance : null,
    raw_json: JSON.stringify(account ?? {}),
  };
}

async function fetchAccounts(
  client: HyperbotClient,
  addresses: string[],
): Promise<Map<string, TraderAccount>> {
  const accountMap = new Map<string, TraderAccount>();

  for (let i = 0; i < addresses.length; i += ACCOUNT_BATCH_SIZE) {
    const batch = addresses.slice(i, i + ACCOUNT_BATCH_SIZE);
    const batchId = Math.floor(i / ACCOUNT_BATCH_SIZE) + 1;

    try {
      const accounts = await client.getTraderAccounts(batch);
      for (const account of accounts) {
        if (account.address) {
          accountMap.set(normalizeAddress(account.address), account);
        }
      }
      log.info(
        "import_addresses",
        `拉取账户批次 ${batchId}: ${accounts.length}/${batch.length}`,
      );
    } catch (error) {
      log.error(
        "import_addresses",
        `拉取账户批次 ${batchId} 失败`,
        { error },
      );
      throw error;
    }
  }

  return accountMap;
}

async function main() {
  program
    .requiredOption("--addresses <list>", "逗号分隔的钱包地址")
    .requiredOption(
      "--group <name>",
      "地址分组名（爬取/回测共用）",
    )
    .requiredOption("--discovered-at <date>", "发现日期（YYYY-MM-DD）")
    .option("--db <path>", "SQLite 数据库路径", "./data.db")
    .option("--qps <number>", "每秒 API 请求数", "5")
    .parse();

  const opts = program.opts();
  const key = process.env.HYPERBOT_KEY;
  const secret = process.env.HYPERBOT_SECRET;

  if (!key || !secret) {
    throw new Error(
      "缺少环境变量: 需设置 HYPERBOT_KEY 和 HYPERBOT_SECRET",
    );
  }

  const addresses = parseAndValidateAddresses(opts.addresses as string);
  const groupName = String(opts.group).trim();
  const discoveredAt = validateDiscoveredAt(String(opts.discoveredAt));
  const qps = parseInt(opts.qps as string, 10);

  if (!groupName) {
    throw new Error("--group 值无效（不可为空）");
  }
  if (!Number.isFinite(qps) || qps <= 0) {
    throw new Error("--qps 值无效（需正整数）");
  }

  log.info(
    "import_addresses",
    `导入 ${addresses.length} 个地址到 group=${groupName}`,
  );

  const db = initDatabase(opts.db as string);
  const client = new HyperbotClient(key, secret, qps);

  const accountMap = await fetchAccounts(client, addresses);

  const rows: AddressRow[] = addresses.map((address) => {
    const account = accountMap.get(normalizeAddress(address)) ?? null;
    if (!account) {
      log.warn(
        "import_addresses",
        `${address} 无账户快照，余额置空`,
      );
    }
    return toAddressRow(address, groupName, discoveredAt, account);
  });

  const inserted = insertAddresses(db, rows);
  const totalInGroup = countAddresses(db, groupName);

  log.info(
    "import_addresses",
    `完成。新增: ${inserted}，group(${groupName}) 去重总数: ${totalInGroup}`,
  );

  db.close();
}

main().catch((error) => {
  log.error("import_addresses", "致命错误", { error });
  process.exit(1);
});
