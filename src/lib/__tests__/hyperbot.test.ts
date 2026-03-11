import {
  afterEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import crypto from "node:crypto";
import { HyperbotClient } from "../hyperbot.js";

let fetchMock: MockInstance;

afterEach(() => {
  fetchMock?.mockRestore();
});

// 直接测试签名算法的正确性（不导出 sign 函数，用文档验证示例验证逻辑）
describe("hyperbot signature", () => {
  it("should match the documented verification example", () => {
    const accessKeyId = "975988f45090561684b7d8f4e45b85c2";
    const accessSecret = "957f23f2d6435e37d4ac21f3e9a67d45";
    const nonce = "2";
    const timestamp = "1612149637";

    const stringToSign = `AccessKeyId=${accessKeyId}&SignatureNonce=${nonce}&Timestamp=${timestamp}`;
    const hexSignature = crypto
      .createHmac("sha1", accessSecret)
      .update(stringToSign)
      .digest("hex");
    const signature = Buffer.from(hexSignature).toString("base64");

    expect(signature).toBe(
      "M2Y0ODNlYTUwNDFiMTg5MjRmMGQxNmY1YTMyMzc1NTc5NTUzNDAzYw==",
    );
  });
});

describe("hyperbot client requests", () => {
  it("should call ledger net-flow endpoint with days query", async () => {
    fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            code: "0",
            msg: "success",
            data: { netPerpIn: "1", netSpotIn: "2" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

    const client = new HyperbotClient("ak", "sk", 1000);
    const result = await client.getLedgerUpdatesNetFlow("0xabc", 7);

    expect(result.netPerpIn).toBe("1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(
      "/v2/hl/ledger-updates/net-flow/0xabc?AccessKeyId=",
    );
    expect(String(url)).toContain("days=7");
    expect(options?.method).toBe("GET");
  });

  it("should call hl/info with userNonFundingLedgerUpdates body", async () => {
    fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            code: "0",
            msg: "success",
            data: [
              {
                delta: { type: "deposit", usdc: "10" },
                time: 1681222254710,
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

    const client = new HyperbotClient("ak", "sk", 1000);
    const result = await client.getUserNonFundingLedgerUpdates(
      "0xabc",
      1000,
      2000,
    );

    expect(result).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v2/hl/info?AccessKeyId=");
    expect(options?.method).toBe("POST");
    const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      type: "userNonFundingLedgerUpdates",
      user: "0xabc",
      startTime: 1000,
      endTime: 2000,
    });
  });
});
