import crypto from "node:crypto";
import { log } from "./logger.js";
import type {
  ApiResponse,
  CompletedTrade,
  CompletedTradesByTimeParams,
  DiscoverParams,
  DiscoveredTrader,
  LedgerUpdatesNetFlow,
  NonFundingLedgerUpdate,
  PaginatedData,
  TraderAccount,
  UserNonFundingLedgerUpdatesRequest,
} from "./types.js";

const BASE_URL = "https://openapi.hyperbot.network/api/upgrade";
const MAX_RETRY_ATTEMPTS = 6;
const MAX_BACKOFF_MS = 20000;

// 签名：HMAC-SHA1 hex -> Base64
function sign(
  accessKeyId: string,
  accessSecret: string,
): {
  AccessKeyId: string;
  SignatureNonce: string;
  Timestamp: string;
  Signature: string;
} {
  const nonce = crypto.randomBytes(4).toString("hex");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const stringToSign = `AccessKeyId=${accessKeyId}&SignatureNonce=${nonce}&Timestamp=${timestamp}`;
  const hexSignature = crypto
    .createHmac("sha1", accessSecret)
    .update(stringToSign)
    .digest("hex");
  const signature = Buffer.from(hexSignature).toString("base64");
  return {
    AccessKeyId: accessKeyId,
    SignatureNonce: nonce,
    Timestamp: timestamp,
    Signature: signature,
  };
}

// 令牌桶限速器
class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly maxTokens: number,
    private readonly refillRate: number,
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    while (true) {
      const now = Date.now();
      const elapsed = (now - this.lastRefill) / 1000;
      this.tokens = Math.min(
        this.maxTokens,
        this.tokens + elapsed * this.refillRate,
      );
      this.lastRefill = now;

      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      // 等待到有令牌可用
      const waitMs = ((1 - this.tokens) / this.refillRate) * 1000;
      await new Promise((resolve) => setTimeout(resolve, Math.ceil(waitMs)));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(retryAfterHeader: string | null): number | null {
  if (!retryAfterHeader) {
    return null;
  }

  const seconds = Number(retryAfterHeader);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const absoluteTime = Date.parse(retryAfterHeader);
  if (Number.isFinite(absoluteTime)) {
    return Math.max(0, absoluteTime - Date.now());
  }

  return null;
}

function serverBackoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
}

function rateLimitBackoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 2000 * (attempt + 1));
}

export class HyperbotClient {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly accessKeyId: string,
    private readonly accessSecret: string,
    qps: number = 5,
  ) {
    this.limiter = new RateLimiter(qps, qps);
  }

  private buildAuthQuery(): string {
    const params = sign(this.accessKeyId, this.accessSecret);
    return new URLSearchParams(params).toString();
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    queryParams?: Record<string, string>,
    body?: unknown,
  ): Promise<T> {
    const authQuery = this.buildAuthQuery();
    const extra = queryParams
      ? "&" + new URLSearchParams(queryParams).toString()
      : "";
    const url = `${BASE_URL}${path}?${authQuery}${extra}`;

    const start = Date.now();
    let lastError: Error | null = null;

    // why: API 会返回 429/HTML，重试需显式区分限流与服务端故障
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        await this.limiter.acquire();
        const response = await fetch(url, {
          method,
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });

        const duration = Date.now() - start;

        if (response.status === 429) {
          const retryAfterMs = parseRetryAfterMs(
            response.headers.get("retry-after"),
          );
          const waitMs = retryAfterMs ?? rateLimitBackoffMs(attempt);
          lastError = new Error(`HTTP 429 来自 ${path}`);
          log.warn(
            "hyperbot",
            `${path} 被限流，第 ${attempt + 1} 次重试`,
            {
              result: { status: response.status, waitMs },
              duration,
            },
          );
          await sleep(waitMs);
          continue;
        }

        if (response.status >= 500) {
          lastError = new Error(`HTTP ${response.status} 来自 ${path}`);
          const waitMs = serverBackoffMs(attempt);
          log.warn(
            "hyperbot",
            `${path} 服务端错误，第 ${attempt + 1} 次重试`,
            {
              result: { status: response.status, waitMs },
              duration,
            },
          );
          await sleep(waitMs);
          continue;
        }

        // CDN/WAF 偶尔返回 HTML，按瞬态错误处理
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          lastError = new Error(
            `非 JSON 响应 (${contentType}) 来自 ${path}`,
          );
          const waitMs = serverBackoffMs(attempt);
          log.warn(
            "hyperbot",
            `${path} 非 JSON 响应，第 ${attempt + 1} 次重试`,
            {
              result: { status: response.status, waitMs },
              duration,
            },
          );
          await sleep(waitMs);
          continue;
        }

        const json = (await response.json()) as ApiResponse<T>;
        log.debug("hyperbot", `${method} ${path}`, {
          duration,
          result: { code: json.code, msg: json.msg },
        });

        if (json.code === "429") {
          const waitMs = rateLimitBackoffMs(attempt);
          lastError = new Error(`API 被限流: code=429 path=${path}`);
          log.warn(
            "hyperbot",
            `${path} API 被限流，第 ${attempt + 1} 次重试`,
            {
              result: { waitMs },
              duration,
            },
          );
          await sleep(waitMs);
          continue;
        }

        if (json.code !== "0") {
          throw new Error(
            `API 错误: code=${json.code} msg=${json.msg} path=${path}`,
          );
        }
        return json.data;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("API 错误:")) {
          throw err;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
        log.warn(
          "hyperbot",
          `${path} 请求失败，第 ${attempt + 1} 次重试`,
          { error: lastError },
        );
        await sleep(serverBackoffMs(attempt));
      }
    }
    throw (
      lastError ??
      new Error(`${MAX_RETRY_ATTEMPTS} 次重试后仍失败: ${path}`)
    );
  }

  async discoverTraders(
    params: DiscoverParams,
  ): Promise<PaginatedData<DiscoveredTrader>> {
    return this.request<PaginatedData<DiscoveredTrader>>(
      "POST",
      "/v2/hl/traders/discover",
      undefined,
      params,
    );
  }

  async getCompletedTradesByTime(
    address: string,
    params: CompletedTradesByTimeParams,
  ): Promise<CompletedTrade[]> {
    return this.request<CompletedTrade[]>(
      "POST",
      `/v2/hl/traders/${address}/completed-trades/by-time`,
      undefined,
      params,
    );
  }

  async getTraderAccounts(addresses: string[]): Promise<TraderAccount[]> {
    return this.request<TraderAccount[]>(
      "POST",
      "/v2/hl/traders/accounts",
      undefined,
      {
        addresses,
      },
    );
  }

  async getLedgerUpdatesNetFlow(
    address: string,
    days: number,
  ): Promise<LedgerUpdatesNetFlow> {
    return this.request<LedgerUpdatesNetFlow>(
      "GET",
      `/v2/hl/ledger-updates/net-flow/${address}`,
      {
        days: String(days),
      },
    );
  }

  async getUserNonFundingLedgerUpdates(
    address: string,
    startTime: number,
    endTime?: number,
  ): Promise<NonFundingLedgerUpdate[]> {
    const body: UserNonFundingLedgerUpdatesRequest = {
      type: "userNonFundingLedgerUpdates",
      user: address,
      startTime,
    };

    if (endTime !== undefined) {
      body.endTime = endTime;
    }

    return this.request<NonFundingLedgerUpdate[]>(
      "POST",
      "/v2/hl/info",
      undefined,
      body,
    );
  }
}
