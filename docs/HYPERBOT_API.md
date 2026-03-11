# Hyperbot Hyperliquid API 文档

> 文档来源：https://openapi-docs.hyperbot.network/apis/hyperliquid
>
> 整理日期：2026-03-07

---

## 目录

1. [Base URL](#base-url)
2. [认证方式](#认证方式)
3. [通用响应格式](#通用响应格式)
4. [错误码](#错误码)
5. [行情数据（Ticker）](#行情数据ticker)
6. [用户订单与成交](#用户订单与成交)
7. [Portfolio 与 PnL](#portfolio-与-pnl)
8. [交易员分析](#交易员分析)
9. [仓位历史与 PnL](#仓位历史与-pnl)
10. [鲸鱼数据](#鲸鱼数据)
11. [聪明钱与交易员发现](#聪明钱与交易员发现)
12. [清算数据](#清算数据)
13. [持仓量（Open Interest）](#持仓量open-interest)
14. [市场深度与 K 线](#市场深度与-k-线)
15. [订单簿历史与 Taker Delta](#订单簿历史与-taker-delta)
16. [统一 Info 端点](#统一-info-端点)
17. [Info 子端点](#info-子端点)
18. [WebSocket 端点](#websocket-端点)

---

## Base URL

所有 REST API 的 Base URL：

```
https://openapi.hyperbot.network/api/upgrade
```

所有端点路径均以 `/v2/hl/` 开头，完整 URL 示例：

```
https://openapi.hyperbot.network/api/upgrade/v2/hl/tickers
```

---

## 认证方式

所有 API 请求均需在 QueryString 中携带以下四个认证参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `AccessKeyId` | string | 是 | 用户访问密钥 ID |
| `SignatureNonce` | string | 是 | 签名随机数（每次请求唯一） |
| `Timestamp` | string | 是 | 请求时间戳（Unix 秒），有效期 30 秒，超时拒绝（防重放） |
| `Signature` | string | 是 | 使用 HmacSHA1 + Base64 生成的签名 |

### 签名算法

**第一步：构造待签名字符串**

按以下固定格式拼接：

```
AccessKeyId={AccessKeyId}&SignatureNonce={SignatureNonce}&Timestamp={Timestamp}
```

**第二步：HMAC-SHA1 计算**

以 `AccessSecret`（用户私钥）为密钥，对上述字符串做 HMAC-SHA1，结果取 hex 编码。

**第三步：Base64 编码**

将 hex 字符串做 Base64 编码，得到最终 `Signature`。

> 注意：是先 hex，再把 hex 字符串做 Base64，不是直接对 HMAC 二进制 Base64。

### 验证示例

| 字段 | 值 |
|------|----|
| AccessKeyId | `975988f45090561684b7d8f4e45b85c2` |
| AccessSecret | `957f23f2d6435e37d4ac21f3e9a67d45` |
| SignatureNonce | `2` |
| Timestamp | `1612149637` |
| 待签名字符串 | `AccessKeyId=975988f45090561684b7d8f4e45b85c2&SignatureNonce=2&Timestamp=1612149637` |
| 期望 Signature | `M2Y0ODNlYTUwNDFiMTg5MjRmMGQxNmY1YTMyMzc1NTc5NTUzNDAzYw==` |

### 代码示例

**Python**

```python
import hmac
import hashlib
import time
import os
import base64

def generate_signature(access_key_id, access_secret, signature_nonce=None, timestamp=None):
    nonce = signature_nonce or os.urandom(4).hex()
    ts = str(timestamp or int(time.time()))

    string_to_sign = f"AccessKeyId={access_key_id}&SignatureNonce={nonce}&Timestamp={ts}"

    key = access_secret.encode('utf-8')
    message = string_to_sign.encode('utf-8')
    hex_signature = hmac.new(key, message, hashlib.sha1).hexdigest()

    return base64.b64encode(hex_signature.encode('ascii')).decode('utf-8')
```

**JavaScript (Node.js)**

```javascript
const crypto = require('crypto');

function generateSignature(accessKeyId, accessSecret, signatureNonce, timestamp) {
    const nonce = signatureNonce || crypto.randomBytes(4).toString('hex');
    const ts = timestamp || Math.floor(Date.now() / 1000).toString();

    const str = `AccessKeyId=${accessKeyId}&SignatureNonce=${nonce}&Timestamp=${ts}`;

    const hmac = crypto.createHmac('sha1', accessSecret);
    hmac.update(str);
    const hexSignature = hmac.digest('hex');

    return Buffer.from(hexSignature, 'binary').toString('base64');
}
```

**Go**

```go
package main

import (
    "crypto/hmac"
    "crypto/sha1"
    "encoding/base64"
    "encoding/hex"
    "fmt"
    "math/rand"
    "strconv"
    "time"
)

func GenerateSignature(accessKeyId, accessSecret string, signatureNonce *string, timestamp *int64) string {
    nonce := ""
    if signatureNonce == nil {
        b := make([]byte, 4)
        rand.Read(b)
        nonce = hex.EncodeToString(b)
    } else {
        nonce = *signatureNonce
    }

    ts := ""
    if timestamp == nil {
        ts = strconv.FormatInt(time.Now().Unix(), 10)
    } else {
        ts = strconv.FormatInt(*timestamp, 10)
    }

    str := fmt.Sprintf("AccessKeyId=%s&SignatureNonce=%s&Timestamp=%s",
        accessKeyId, nonce, ts)

    h := hmac.New(sha1.New, []byte(accessSecret))
    h.Write([]byte(str))
    hexSignature := hex.EncodeToString(h.Sum(nil))

    return base64.StdEncoding.EncodeToString([]byte(hexSignature))
}
```

**PHP**

```php
function generateSignature($accessKeyId, $accessSecret, $signatureNonce = null, $timestamp = null) {
    $nonce = $signatureNonce ?: bin2hex(random_bytes(4));
    $ts = $timestamp ?: (string)floor(time());

    $str = "AccessKeyId={$accessKeyId}&SignatureNonce={$nonce}&Timestamp={$ts}";

    $hexSignature = hash_hmac('sha1', $str, $accessSecret, false);

    return base64_encode($hexSignature);
}
```

### 请求 URL 示例

GET 请求将认证参数拼入 QueryString：

```
GET https://openapi.hyperbot.network/api/upgrade/v2/hl/tickers?AccessKeyId=xxx&SignatureNonce=xxx&Timestamp=xxx&Signature=xxx
```

---

## 通用响应格式

所有接口统一返回 JSON，顶层结构如下：

```json
{
  "code": "0",
  "msg": "success",
  "data": {}
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `code` | string | 状态码，`"0"` 表示成功 |
| `msg` | string | 响应消息，成功时为 `"success"` |
| `data` | object \| array \| null | 响应数据，结构随接口不同而变化 |

---

## 错误码

| code | 说明 |
|------|------|
| `0` | 成功 |
| `400` | 请求参数错误 |
| `401` | 未授权，API Key 无效或缺失 |
| `403` | 无权限访问该接口 |
| `500` | 服务器内部错误 |

---

## 行情数据（Ticker）

### 获取所有币种 Ticker

```
GET /v2/hl/tickers
```

返回所有可交易币种的实时报价。

**请求参数：** 仅认证参数（无业务参数）

**响应 `data` 字段：**

`data` 为数组，每个元素：

| 字段 | 类型 | 说明 |
|------|------|------|
| `coin` | string | 币种名称，如 `"BTC"`、`"ETH"` |
| `price` | string | 当前成交价格 |

---

### 获取指定币种 Ticker

```
GET /v2/hl/tickers/coin/:coin
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `coin` | string | 是 | 币种名称，如 `"ETH"` |

**响应 `data` 字段：**

`data` 为单个对象：

| 字段 | 类型 | 说明 |
|------|------|------|
| `coin` | string | 币种名称 |
| `price` | string | 当前成交价格 |

---

## 用户订单与成交

### 获取用户成交记录

```
GET /v2/hl/fills/:address
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `address` | string | 是 | 用户钱包地址 |

**查询参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `coin` | string | 否 | - | 筛选指定币种的成交记录 |
| `limit` | integer | 否 | 1000（最大 2000） | 返回记录数量上限 |

**响应 `data` 字段：**

`data` 为数组，每个元素：

| 字段 | 类型 | 说明 |
|------|------|------|
| `coin` | string | 币种名称 |
| `side` | string | 成交方向：`"buy"` 或 `"sell"` |
| `price` | string | 成交价格 |
| `size` | string | 成交数量 |
| `time` | number | 成交时间戳（毫秒） |
| `oid` | string | 关联订单 ID |

---

### 按订单 ID 查询成交记录

```
GET /v2/hl/fills/oid/:oid
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `oid` | string | 是 | 订单 ID |

**响应 `data` 字段：** 结构同上（数组）

---

### 按 TWAP 订单 ID 查询成交记录

```
GET /v2/hl/fills/twapid/:twapid
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `twapid` | string | 是 | TWAP 订单 ID |

**响应 `data` 字段：** 成交记录数组，结构同 `/v2/hl/fills/:address`

---

### 获取 Builder 最新成交记录

```
GET /v2/hl/fills/builder/:builder/latest
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `builder` | string | 是 | Builder 钱包地址 |

**查询参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `coin` | string | 否 | - | 筛选指定币种 |
| `limit` | integer | 否 | 1000（最大 2000） | 返回记录数量上限 |
| `minVal` | integer | 否 | - | 最小成交价值过滤（USD） |

**响应 `data` 字段：**

`data` 为数组，每个元素：

| 字段 | 类型 | 说明 |
|------|------|------|
| `builderFee` | string | Builder 手续费 |
| `closedPnl` | string | 已实现盈亏 |
| `coin` | string | 币种名称 |
| `crossed` | boolean | 是否为 Taker 单 |
| `dir` | string | 仓位变化方向描述 |
| `fee` | string | 手续费金额 |
| `feeToken` | string | 手续费计价 Token |
| `hash` | string | 链上交易哈希 |
| `oid` | number | 订单 ID |
| `px` | string | 成交价格 |
| `side` | string | 成交方向 |
| `startPosition` | string | 成交前仓位大小 |
| `sz` | string | 成交数量 |
| `time` | number | 成交时间戳（毫秒） |

---

### 获取大额成交记录

```
GET /v2/hl/fills/top-trades
```

**查询参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `interval` | string | 是 | - | 时间区间，范围 `1s` ~ `7d` |
| `coin` | string | 是 | - | 币种名称 |
| `limit` | integer | 是 | 10（最大 100） | 返回记录数量上限 |

**响应 `data` 字段：**

`data` 为数组，每个元素：

| 字段 | 类型 | 说明 |
|------|------|------|
| `time` | number | 成交时间戳（毫秒） |
| `address` | string | 钱包地址 |
| `coin` | string | 币种名称 |
| `side` | string | 成交方向 |
| `oid` | number | 订单 ID |
| `isTaker` | boolean | 是否为 Taker |
| `px` | string | 成交价格 |
| `sz` | string | 成交数量 |
| `val` | string | 成交价值（USD） |
| `endPosition` | string | 成交后仓位大小 |

---

### 获取用户成交订单列表

```
GET /v2/hl/filled-orders/:address/latest
```

与 `/fills` 的区别在于返回的是订单维度的聚合信息（而非逐笔成交）。

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `address` | string | 是 | 用户钱包地址 |

**查询参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `coin` | string | 否 | - | 筛选指定币种 |
| `limit` | integer | 否 | 1000（最大 1000） | 返回记录数量上限 |

**响应 `data` 字段：**

`data` 为数组，每个元素：

| 字段 | 类型 | 说明 |
|------|------|------|
| `oid` | string | 订单 ID |
| `coin` | string | 币种名称 |
| `side` | string | 方向：`"buy"` 或 `"sell"` |
| `price` | string | 订单价格 |
| `size` | string | 订单总数量 |
| `filledSize` | string | 已成交数量 |
| `status` | string | 订单状态：`"filled"`、`"cancelled"` 等 |
| `time` | number | 时间戳（毫秒） |

---

### 按订单 ID 查询成交订单

```
GET /v2/hl/filled-orders/oid/:oid
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `oid` | string | 是 | 订单 ID |

**响应 `data` 字段：** 单个成交订单对象（结构同上），订单不存在时返回 `null`

---

### 获取最新订单列表（含已取消）

```
GET /v2/hl/orders/:address/latest
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `address` | string | 是 | 用户钱包地址 |

**查询参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `coin` | string | 否 | - | 筛选指定币种 |
| `limit` | integer | 否 | 2000（最大 2000） | 返回记录数量上限 |

**响应 `data` 字段：**

`data` 为数组（按时间倒序），每个元素：

| 字段 | 类型 | 说明 |
|------|------|------|
| `oid` | string | 订单 ID |
| `coin` | string | 币种名称 |
| `side` | string | 方向：`"buy"` 或 `"sell"` |
| `price` | string | 订单价格 |
| `size` | string | 订单总数量 |
| `filledSize` | string | 已成交数量 |
| `status` | string | 订单状态：`"filled"`、`"cancelled"` 等 |
| `time` | number | 时间戳（毫秒） |

---

### 按订单 ID 查询订单详情

```
GET /v2/hl/orders/oid/:oid
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `oid` | string | 是 | 订单 ID |

**响应 `data` 字段：** 单个订单对象（结构同上），不存在时返回 `null`

---

### 获取大额挂单

```
GET /v2/hl/orders/top-open-orders
```

**查询参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `minVal` | string | 否 | - | 最小订单价值过滤 |
| `coin` | string | 否 | - | 筛选指定币种 |
| `limit` | integer | 否 | 10（最大 100） | 返回记录数量上限 |

**响应 `data` 字段：**

`data` 为数组，每个元素：

| 字段 | 类型 | 说明 |
|------|------|------|
| `time` | number | 下单时间戳（毫秒） |
| `address` | string | 钱包地址 |
| `oid` | number | 订单 ID |
| `coin` | string | 币种名称 |
| `side` | string | 方向 |
| `sz` | string | 当前剩余数量 |
| `origSz` | string | 原始下单数量 |
| `limitPx` | string | 限价 |
| `val` | string | 订单价值（USD） |
| `reduceOnly` | boolean | 是否为只减仓单 |
| `tif` | string | 生效时间类型（如 `"GTC"`） |
| `distPct` | string | 距当前价格偏离百分比 |

---

### 获取活跃订单统计

```
GET /v2/hl/orders/active-stats
```

**查询参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `whaleThreshold` | string | 否 | 鲸鱼标准（订单价值阈值，USD） |
| `coin` | string | 否 | 筛选指定币种 |

**响应 `data` 字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `totalCount` | number | 活跃订单总数 |
| `bidCount` | number | 买单数量 |
| `askCount` | number | 卖单数量 |
| `bidValue` | string | 买单总价值（USD） |
| `askValue` | string | 卖单总价值（USD） |
| `bidValueRatio` | string | 买单价值占比 |
| `whaleBidCount` | number | 鲸鱼买单数量 |
| `whaleAskCount` | number | 鲸鱼卖单数量 |
| `whaleBidValue` | string | 鲸鱼买单总价值（USD） |
| `whaleAskValue` | string | 鲸鱼卖单总价值（USD） |
| `whaleBidValueRatio` | string | 鲸鱼买单价值占比 |

---

### 获取 TWAP 订单状态

```
GET /v2/hl/twap-states/:address/latest
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `address` | string | 是 | 用户钱包地址 |

**查询参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `coin` | string | 否 | 筛选指定币种 |
| `limit` | integer | 否 | 返回记录数量上限 |

**响应 `data` 字段：** TWAP 订单状态列表（数组）

---

## Portfolio 与 PnL

### 获取账户价值与 PnL 曲线

```
GET /v2/hl/portfolio/:address/:window
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `address` | string | 是 | 用户钱包地址 |
| `window` | string | 是 | 时间窗口，枚举：`day`、`week`、`month`、`allTime` |

**响应 `data` 字段：**

```json
{
  "accountValue": [
    { "time": 1700000000000, "value": "12345.67" }
  ],
  "pnl": [
    { "time": 1700000000000, "value": "234.56" }
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `accountValue` | array | 账户总价值时间序列 |
| `accountValue[].time` | number | 时间戳（毫秒） |
| `accountValue[].value` | string | 账户总价值（USD） |
| `pnl` | array | 盈亏时间序列 |
| `pnl[].time` | number | 时间戳（毫秒） |
| `pnl[].value` | string | 盈亏金额（USD） |

---

### 获取 PnL 曲线

```
GET /v2/hl/pnls/:address
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `address` | string | 是 | 用户钱包地址 |

**查询参数：**

| 参数 | 类型 | 必填 | 枚举值 | 说明 |
|------|------|------|--------|------|
| `period` | integer | 否 | `0`（全部时间）、`1`、`7`、`30` | 统计周期天数，默认 `0` |

**响应 `data` 字段：**

`data` 为数组：

| 字段 | 类型 | 说明 |
|------|------|------|
| `time` | number | 时间戳（毫秒） |
| `pnl` | string | 盈亏金额 |

---

### 获取最大回撤

```
GET /v2/hl/max-drawdown/:address
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `address` | string | 是 | 用户钱包地址 |

**查询参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `days` | integer | 否 | 30 | 统计周期天数 |

**响应 `data` 字段：** 最大回撤数据对象

---

### 批量获取最大回撤

```
POST /v2/hl/batch-max-drawdown
```

**请求体（application/json）：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `addresses` | array[string] | 是 | 钱包地址列表 |

**响应 `data` 字段：** 各地址的最大回撤数据数组

---

### 获取净流入/流出统计

```
GET /v2/hl/ledger-updates/net-flow/:address
```

统计指定时间段内账户的资金净流入或净流出。

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `address` | string | 是 | 用户钱包地址 |

**查询参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `days` | integer | 否 | 30 | 统计周期天数 |

**响应 `data` 字段：** 净流量统计对象

---

### 批量获取净流入/流出统计

```
POST /v2/hl/batch-ledger-updates-net-flow
```

**请求体（application/json）：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `addresses` | array[string] | 是 | 钱包地址列表 |

**响应 `data` 字段：** 各地址的净流量统计数组

---

## 交易员分析

### 获取收益最高的交易记录

```
GET /v2/hl/traders/:address/best-trades
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `address` | string | 是 | 用户钱包地址 |

**查询参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `period` | integer | 是 | - | 统计周期天数 |
| `limit` | integer | 否 | 10（最大 100） | 返回记录数量上限 |

**响应 `data` 字段：**

`data` 为数组，按收益从高到低排序，每个元素：

| 字段 | 类型 | 说明 |
|------|------|------|
| `coin` | string | 币种名称 |
| `side` | string | 方向：`"long"` 或 `"short"` |
| `entryPrice` | string | 入场价格 |
| `exitPrice` | string | 出场价格 |
| `pnl` | string | 盈亏金额（USD） |
| `pnlPercent` | string | 盈亏百分比 |
| `openTime` | number | 开仓时间戳（毫秒） |
| `closeTime` | number | 平仓时间戳（毫秒） |

---

### 按币种统计交易表现

```
GET /v2/hl/traders/:address/performance-by-coin
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `address` | string | 是 | 用户钱包地址 |

**查询参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `period` | integer | 是 | -（`0` = 全部时间） | 统计周期天数 |
| `limit` | integer | 否 | 10（最大 100） | 返回记录数量上限 |

**响应 `data` 字段：**

`data` 为数组，每个元素：

| 字段 | 类型 | 说明 |
|------|------|------|
| `coin` | string | 币种名称 |
| `tradeCount` | number | 总交易次数 |
| `winCount` | number | 盈利次数 |
| `lossCount` | number | 亏损次数 |
| `winRate` | string | 胜率（百分比字符串） |
| `totalPnl` | string | 该币种总盈亏（USD） |
| `avgPnl` | string | 平均每笔盈亏（USD） |

---

### 获取地址交易统计

```
GET /v2/hl/traders/:address/addr-stat
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `address` | string | 是 | 用户钱包地址 |

**查询参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `period` | integer | 否 | 7 | 统计周期天数 |

**响应 `data` 字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `avgPosDuration` | string | 平均持仓时长 |
| `closePosCount` | number | 已平仓次数 |
| `maxDrawdown` | string | 最大回撤 |
| `orderCount` | number | 订单总数 |
| `totalPnl` | string | 总盈亏（USD） |
| `winRate` | string | 胜率（百分比字符串） |

---

### 获取已完成交易列表

```
GET /v2/hl/traders/:address/completed-trades
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `address` | string | 是 | 用户钱包地址 |

**查询参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `coin` | string | 否 | - | 筛选指定币种 |
| `limit` | integer | 否 | 100（最大 2000） | 返回记录数量上限 |

**响应 `data` 字段：**

`data` 为数组，每个元素：

| 字段 | 类型 | 说明 |
|------|------|------|
| `coin` | string | 币种名称 |
| `side` | string | 方向：`"long"` 或 `"short"` |
| `entryPrice` | string | 入场价格 |
| `exitPrice` | string | 出场价格 |
| `size` | string | 仓位大小 |
| `pnl` | string | 盈亏金额（USD） |
| `pnlPercent` | string | 盈亏百分比 |
| `openTime` | number | 开仓时间戳（毫秒） |
| `closeTime` | number | 平仓时间戳（毫秒） |

---

### 按时间范围查询已完成交易（分页）

```
POST /v2/hl/traders/:address/completed-trades/by-time
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `address` | string | 是 | 用户钱包地址 |

**请求体（application/json）：**

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `pageNum` | integer | 否 | 1（最大 50） | 页码 |
| `pageSize` | integer | 否 | 20（最大 2000） | 每页条数 |
| `Coin` | string | 否 | - | 筛选指定币种 |
| `endTimeFrom` | integer | 否 | - | 平仓时间范围起点（毫秒） |
| `endTimeTo` | integer | 否 | - | 平仓时间范围终点（毫秒） |

**响应 `data` 字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `list` | array | 交易记录数组（结构同 `completed-trades`） |
| `total` | number | 总记录数 |
| `pageNum` | number | 当前页码 |
| `pageSize` | number | 每页条数 |

---

### 批量查询账户信息

```
POST /v2/hl/traders/accounts
```

最多支持 50 个地址（超出静默截断）。

**请求体（application/json）：**

```json
{
  "addresses": ["0xabc...", "0xdef..."]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `addresses` | array[string] | 是 | 钱包地址列表，最多 50 个 |

**响应 `data` 字段：**

`data` 为数组，每个元素：

| 字段 | 类型 | 说明 |
|------|------|------|
| `address` | string | 用户钱包地址 |
| `currentPosition` | number | 当前持仓数量 |
| `effLeverage` | string | 有效杠杆 |
| `lastOperationAt` | number | 最近操作时间戳（毫秒） |
| `leverage` | string | 杠杆倍数 |
| `marginUsage` | string | 已用保证金（USD） |
| `marginUsageRate` | string | 保证金使用率 |
| `perpValue` | string | 永续合约持仓价值（USD） |
| `spotValue` | string | 现货持仓价值（USD） |
| `totalValue` | string | 账户总价值（USD） |

---

### 批量查询交易统计

```
POST /v2/hl/traders/statistics
```

最多支持 50 个地址。

**请求体（application/json）：**

```json
{
  "period": 7,
  "pnlList": true,
  "addresses": ["0xabc...", "0xdef..."]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `period` | integer | 否 | 统计周期天数（默认 `7`，`0` = 全部时间） |
| `pnlList` | boolean | 否 | 是否在响应中附带 PnL 曲线数据 |
| `addresses` | array[string] | 是 | 钱包地址列表，最多 50 个 |

**响应 `data` 字段：**

`data` 为数组，每个元素：

| 字段 | 类型 | 说明 |
|------|------|------|
| `address` | string | 用户钱包地址 |
| `tradeCount` | number | 总交易次数 |
| `winCount` | number | 盈利次数 |
| `lossCount` | number | 亏损次数 |
| `winRate` | string | 胜率（百分比字符串） |
| `totalPnl` | string | 总盈亏（USD） |
| `avgPnl` | string | 平均每笔盈亏（USD） |

---

### 批量查询永续合约账户状态

```
POST /v2/hl/traders/clearinghouse-state
```

最多支持 50 个地址（超出静默截断）。

**请求体（application/json）：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `addresses` | array[string] | 是 | 钱包地址列表，最多 50 个 |
| `dex` | string | 否 | DEX 名称，空串为主 DEX |

**响应 `data` 字段：**

`data` 为数组，每个元素：

| 字段 | 类型 | 说明 |
|------|------|------|
| `address` | string | 钱包地址 |
| `state` | object | 账户状态对象 |
| `state.marginSummary` | object | 保证金摘要 |
| `state.marginSummary.accountValue` | string | 账户价值 |
| `state.marginSummary.totalNtlPos` | string | 总名义持仓 |
| `state.marginSummary.totalRawUsd` | string | 总原始 USD |
| `state.marginSummary.totalMarginUsed` | string | 总已用保证金 |
| `state.crossMarginSummary` | object | 全仓保证金摘要 |
| `state.crossMaintenanceMarginUsed` | string | 全仓维持保证金 |
| `state.withdrawable` | string | 可提取金额 |
| `state.assetPositions` | array | 持仓列表 |
| `state.assetPositions[].type` | string | 持仓类型 |
| `state.assetPositions[].position` | object | 持仓详情 |
| `state.assetPositions[].position.coin` | string | 币种 |
| `state.assetPositions[].position.szi` | string | 有符号持仓量 |
| `state.assetPositions[].position.leverage` | object | 杠杆信息 |
| `state.assetPositions[].position.entryPx` | string | 入场价格 |
| `state.assetPositions[].position.positionValue` | string | 持仓价值 |
| `state.assetPositions[].position.unrealizedPnl` | string | 未实现盈亏 |
| `state.assetPositions[].position.returnOnEquity` | string | 净值回报率 |
| `state.assetPositions[].position.liquidationPx` | string | 清算价格 |
| `state.assetPositions[].position.marginUsed` | string | 已用保证金 |
| `state.assetPositions[].position.maxLeverage` | number | 最大杠杆 |
| `state.assetPositions[].position.cumFunding` | object | 累计资金费 |
| `state.time` | number | 时间戳（毫秒） |

---

### 批量查询现货账户状态

```
POST /v2/hl/traders/spot-clearinghouse-state
```

最多支持 50 个地址（超出静默截断）。

**请求体（application/json）：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `addresses` | array[string] | 是 | 钱包地址列表，最多 50 个 |

**响应 `data` 字段：**

`data` 为数组，每个元素：

| 字段 | 类型 | 说明 |
|------|------|------|
| `address` | string | 钱包地址 |
| `spotState` | object | 现货账户状态 |
| `spotState.balances` | array | 余额列表 |
| `spotState.balances[].coin` | string | 币种名称 |
| `spotState.balances[].token` | number | Token ID |
| `spotState.balances[].total` | string | 总余额 |
| `spotState.balances[].hold` | string | 冻结余额 |
| `spotState.balances[].entryNtl` | string | 入场名义价值 |

---

## 仓位历史与 PnL

### 获取当前仓位历史

```
GET /v2/hl/traders/:address/current-position-history/:coin
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `address` | string | 是 | 用户钱包地址 |
| `coin` | string | 是 | 币种名称，如 `"BTC"` |

**响应 `data` 字段：**

`data` 为对象（无持仓时为 `null`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `address` | string | 钱包地址 |
| `coin` | string | 币种名称 |
| `direction` | string | 仓位方向 |
| `cross` | boolean | 是否全仓模式 |
| `startTime` | number | 开仓时间戳（毫秒） |
| `history` | array | 仓位历史快照列表 |
| `history[].time` | number | 快照时间戳（毫秒） |
| `history[].size` | string | 仓位数量 |
| `history[].leverage` | string | 杠杆倍数 |
| `history[].effLeverage` | string | 有效杠杆 |
| `history[].entryPrice` | string | 入场价格 |
| `history[].positionValue` | string | 仓位价值 |
| `history[].unrealizedPnl` | string | 未实现盈亏 |
| `history[].returnOnEquity` | string | 净值回报率 |
| `history[].liqPrice` | string | 清算价格 |
| `history[].marginUsed` | string | 已用保证金 |
| `history[].cumFunding` | string | 累计资金费 |

---

### 获取已完成仓位历史

```
GET /v2/hl/traders/:address/completed-position-history/:coin
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `address` | string | 是 | 用户钱包地址 |
| `coin` | string | 是 | 币种名称 |

**查询参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `startTime` | integer | 条件必填 | 开始时间戳（毫秒），与 `endTime` 至少提供一个 |
| `endTime` | integer | 条件必填 | 结束时间戳（毫秒），与 `startTime` 至少提供一个 |

**响应 `data` 字段：** 结构同当前仓位历史，额外包含 `endTime` 字段

---

### 获取当前仓位 PnL

```
GET /v2/hl/traders/:address/current-position-pnl/:coin
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `address` | string | 是 | 用户钱包地址 |
| `coin` | string | 是 | 币种名称 |

**查询参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `interval` | string | 否 | - | 时间粒度，范围 `15m` ~ `1d` |
| `limit` | integer | 否 | 20（最大 1000） | 返回记录数量上限 |

**响应 `data` 字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `address` | string | 钱包地址 |
| `coin` | string | 币种名称 |
| `direction` | string | 仓位方向 |
| `cross` | boolean | 是否全仓模式 |
| `startTime` | number | 开仓时间戳（毫秒） |
| `interval` | string | 时间粒度 |
| `pnls` | array | PnL 时间序列 |
| `pnls[].time` | number | 时间戳（毫秒） |
| `pnls[].size` | string | 仓位数量 |
| `pnls[].positionValue` | string | 仓位价值 |
| `pnls[].unrealizedPnl` | string | 未实现盈亏 |

---

### 获取已完成仓位 PnL

```
GET /v2/hl/traders/:address/completed-position-pnl/:coin
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `address` | string | 是 | 用户钱包地址 |
| `coin` | string | 是 | 币种名称 |

**查询参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `interval` | string | 否 | - | 时间粒度，范围 `15m` ~ `1d` |
| `startTime` | integer | 条件必填 | - | 开始时间戳（毫秒），与 `endTime` 至少提供一个 |
| `endTime` | integer | 条件必填 | - | 结束时间戳（毫秒），与 `startTime` 至少提供一个 |
| `limit` | integer | 否 | 20（最大 1000） | 返回记录数量上限 |

**响应 `data` 字段：** 结构同当前仓位 PnL，额外包含 `endTime` 字段

---

### 获取当前仓位执行轨迹

```
GET /v2/hl/traders/:address/current-position-executions/:coin
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `address` | string | 是 | 用户钱包地址 |
| `coin` | string | 是 | 币种名称 |

**查询参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `interval` | string | 否 | - | 时间粒度，范围 `15m` ~ `1d` |
| `limit` | integer | 否 | 20（最大 1000） | 返回记录数量上限 |

**响应 `data` 字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `address` | string | 钱包地址 |
| `coin` | string | 币种名称 |
| `direction` | string | 仓位方向 |
| `cross` | boolean | 是否全仓模式 |
| `startTime` | number | 开仓时间戳（毫秒） |
| `interval` | string | 时间粒度 |
| `executions` | array | 执行记录列表 |
| `executions[].time` | number | 时间戳（毫秒） |
| `executions[].buyCount` | number | 买入次数 |
| `executions[].sellCount` | number | 卖出次数 |
| `executions[].buySz` | string | 买入总量 |
| `executions[].sellSz` | string | 卖出总量 |
| `executions[].buyAvgPx` | string | 买入均价 |
| `executions[].sellAvgPx` | string | 卖出均价 |

---

### 获取已完成仓位执行轨迹

```
GET /v2/hl/traders/:address/completed-position-executions/:coin
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `address` | string | 是 | 用户钱包地址 |
| `coin` | string | 是 | 币种名称 |

**查询参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `interval` | string | 否 | - | 时间粒度，范围 `15m` ~ `1d` |
| `startTime` | integer | 条件必填 | - | 开始时间戳（毫秒），与 `endTime` 至少提供一个 |
| `endTime` | integer | 条件必填 | - | 结束时间戳（毫秒），与 `startTime` 至少提供一个 |
| `limit` | integer | 否 | 20（最大 1000） | 返回记录数量上限 |

**响应 `data` 字段：** 结构同当前仓位执行轨迹，额外包含 `endTime` 字段

---

## 鲸鱼数据

### 获取鲸鱼最新仓位事件

```
GET /v2/hl/whales/latest-events
```

**查询参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `limit` | integer | 否 | 10（最大 100） | 返回记录数量上限 |
| `take` | integer | 否 | 10（最大 100） | 返回记录数量上限（同 `limit`） |

**响应 `data` 字段：**

`data` 为数组，每个元素：

| 字段 | 类型 | 说明 |
|------|------|------|
| `user` | string | 鲸鱼钱包地址 |
| `symbol` | string | 交易对名称 |
| `marginMode` | string | 保证金模式 |
| `positionSize` | string | 仓位大小 |
| `entryPrice` | string | 入场价格 |
| `liqPrice` | string | 清算价格 |
| `positionValueUsd` | string | 仓位价值（USD） |
| `positionAction` | string | 仓位操作类型（开仓/平仓） |
| `createTime` | number | 事件时间戳（毫秒） |

---

### 获取鲸鱼多空方向统计

```
GET /v2/hl/whales/directions
```

**查询参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `coin` | string | 否 | 筛选指定币种，如 `"BTC"` |

**响应 `data` 字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `longCount` | number | 持多仓的鲸鱼账户数 |
| `shortCount` | number | 持空仓的鲸鱼账户数 |

---

### 查询鲸鱼当前持仓

```
GET /v2/hl/whales/open-positions
```

支持多维度筛选和排序。

**查询参数：**

| 参数 | 类型 | 必填 | 枚举值 | 说明 |
|------|------|------|--------|------|
| `coin` | string | 否 | - | 筛选指定币种 |
| `dir` | string | 否 | `long`、`short` | 筛选仓位方向 |
| `npnl-side` | string | 否 | `profit`、`loss` | 筛选浮盈/浮亏方 |
| `fr-side` | string | 否 | `profit`、`loss` | 筛选资金费盈亏方 |
| `top-by` | string | 否 | `position-value`、`margin-balance`、`create-time`、`profit`、`loss` | 排序方式，默认 `create-time` |
| `take` | integer | 否 | - | 返回记录数量上限 |

**响应 `data` 字段：**

`data` 为数组，每个元素：

| 字段 | 类型 | 说明 |
|------|------|------|
| `address` | string | 鲸鱼钱包地址 |
| `coin` | string | 币种名称 |
| `dir` | string | 仓位方向：`"long"` 或 `"short"` |
| `positionValue` | string | 仓位价值（USD） |
| `marginBalance` | string | 保证金余额（USD） |
| `entryPrice` | string | 开仓价格 |
| `markPrice` | string | 当前标记价格 |
| `size` | string | 仓位数量 |
| `leverage` | string | 杠杆倍数 |
| `npnl` | string | 浮动盈亏（USD） |
| `npnlPercent` | string | 浮动盈亏百分比 |
| `fundingRate` | string | 当前资金费率 |
| `frPnl` | string | 累计资金费盈亏（USD） |
| `createTime` | number | 开仓时间戳（毫秒） |

---

### 获取鲸鱼多空比历史

```
GET /v2/hl/whales/history-long-ratio
```

**查询参数：**

| 参数 | 类型 | 必填 | 示例值 | 说明 |
|------|------|------|--------|------|
| `interval` | string | 否 | `1h`、`4h`、`1d` | 时间粒度 |
| `limit` | integer | 否 | - | 返回数据点数量上限 |

**响应 `data` 字段：** 历史多空比时间序列数组

---

## 聪明钱与交易员发现

### 发现聪明钱地址

```
POST /v2/hl/smart/find
```

根据多种策略指标筛选出高绩效的聪明钱地址。

**请求体（application/json）：**

```json
{
  "pageNum": 1,
  "pageSize": 20,
  "period": 30,
  "sort": "win-rate",
  "pnlList": true
}
```

| 字段 | 类型 | 必填 | 默认值 | 枚举值 | 说明 |
|------|------|------|--------|--------|------|
| `pageNum` | integer | 否 | 1（最大 20） | - | 页码 |
| `pageSize` | integer | 否 | 20（最大 25） | - | 每页条数 |
| `period` | integer | 是 | - | - | 统计周期天数 |
| `sort` | string | 是 | - | `win-rate`、`account-balance`、`ROI`、`pnl`、`position-count`、`profit-count`、`last-operation`、`avg-holding-period`、`current-position` | 排序指标 |
| `pnlList` | boolean | 是 | - | - | 是否在响应中附带 PnL 曲线数据 |

**响应 `data` 字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `list` | array | 聪明钱地址列表 |
| `total` | number | 总匹配数 |

`list` 每个元素：

| 字段 | 类型 | 说明 |
|------|------|------|
| `address` | string | 钱包地址 |
| `winRate` | string | 胜率（百分比字符串） |
| `accountBalance` | string | 账户余额（USD） |
| `roi` | string | 收益率（ROI） |
| `pnl` | string | 周期内总盈亏（USD） |
| `positionCount` | number | 当前持仓数量 |
| `profitCount` | number | 周期内盈利次数 |
| `lastOperation` | number | 最近操作时间戳（毫秒） |
| `avgHoldingPeriod` | string | 平均持仓周期（天） |

---

### 交易员发现（高级搜索）

```
POST /v2/hl/traders/discover
```

**请求体（application/json）：**

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `pageNum` | integer | 否 | 1（最大 20） | 页码 |
| `pageSize` | integer | 否 | 20（最大 25） | 每页条数 |
| `period` | integer | 否 | 7（`0` = 全部时间） | 统计周期天数 |
| `sort` | object | 否 | - | 排序规则，`{field: string, dir: "asc"\|"desc"}` |
| `tags` | array | 否 | - | 标签过滤列表 |
| `coins` | array | 否 | - | AND 关系：交易过所有指定币种 |
| `anyCoins` | array | 否 | - | OR 关系：交易过任一指定币种 |
| `noCoins` | array | 否 | - | NOT 关系：未交易过指定币种 |
| `allCoins` | array | 否 | - | 所有交易币种 |
| `selects` | array | 否 | - | 查询返回字段列表 |
| `loadPnls` | boolean | 否 | false | 是否附带 PnL 曲线 |
| `loadTags` | boolean | 否 | false | 是否附带标签 |
| `countOnly` | boolean | 否 | false | 是否仅返回计数 |
| `lang` | string | 否 | `"en"` | 语言 |
| `filters` | array | 否 | - | 过滤条件列表 |
| `filters[].field` | string | - | - | 过滤字段名 |
| `filters[].op` | string | - | - | 操作符：`">`"、`"<"`、`"="`、`"!="`、`"exist"` |
| `filters[].val` | any | - | - | 过滤值 |
| `filters[].val2` | any | - | - | 过滤值 2（用于范围查询） |
| `filters[].period` | integer | - | - | 过滤周期 |
| `addrs` | array | 否 | - | 指定查询地址列表，最多 50 个（超出静默截断） |

**响应 `data` 字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `list` | array | 交易员数据列表 |
| `total` | number | 总匹配数 |

---

## 清算数据

### 获取清算汇总统计

```
GET /v2/hl/liquidations/stat
```

**查询参数：**

| 参数 | 类型 | 必填 | 枚举值 | 默认值 | 说明 |
|------|------|------|--------|--------|------|
| `coin` | string | 否 | - | - | 筛选指定币种 |
| `interval` | string | 否 | `1m`、`5m`、`15m`、`30m`、`1h`、`4h`、`1d` | `1d` | 统计时间窗口 |

**响应 `data` 字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `startTime` | number | 统计起始时间戳（毫秒） |
| `addresses` | number | 涉及地址数 |
| `shortLiquidations` | number | 空头被清算次数 |
| `longLiquidations` | number | 多头被清算次数 |
| `totalFilled` | string | 总清算价值（USD） |
| `longFilled` | string | 多头清算价值（USD） |
| `shortFilled` | string | 空头清算价值（USD） |
| `totalPnl` | string | 总清算盈亏（USD） |
| `longPnl` | string | 多头清算盈亏（USD） |
| `shortPnl` | string | 空头清算盈亏（USD） |

---

### 按币种获取清算统计

```
GET /v2/hl/liquidations/stat-by-coin
```

**查询参数：**

| 参数 | 类型 | 必填 | 枚举值 | 默认值 | 说明 |
|------|------|------|--------|--------|------|
| `interval` | string | 否 | `1m`、`5m`、`15m`、`30m`、`1h`、`4h`、`1d` | `1d` | 统计时间窗口 |

**响应 `data` 字段：**

`data` 为数组，每个元素：

| 字段 | 类型 | 说明 |
|------|------|------|
| `coin` | string | 币种名称 |
| `longLiquidations` | number | 多头被清算次数 |
| `shortLiquidations` | number | 空头被清算次数 |
| `longValue` | string | 多头清算总价值（USD） |
| `shortValue` | string | 空头清算总价值（USD） |

---

### 获取清算历史数据

```
GET /v2/hl/liquidations/history
```

**查询参数：**

| 参数 | 类型 | 必填 | 枚举值 | 默认值 | 说明 |
|------|------|------|--------|--------|------|
| `coin` | string | 否 | - | - | 筛选指定币种 |
| `interval` | string | 否 | `1m` ~ `60d` | `1d` | 时间粒度 |
| `limit` | integer | 否 | - | 20（最大 100） | 返回数据点数量上限 |

**响应 `data` 字段：**

`data` 为数组，每个元素代表一个时间窗口的清算数据：

| 字段 | 类型 | 说明 |
|------|------|------|
| `time` | number | 时间窗口开始时间戳（毫秒） |
| `coin` | string | 币种名称 |
| `longLiquidations` | number | 多头被清算次数 |
| `shortLiquidations` | number | 空头被清算次数 |
| `longValue` | string | 多头清算总价值（USD） |
| `shortValue` | string | 空头清算总价值（USD） |

---

### 获取大额清算仓位

```
GET /v2/hl/liquidations/top-positions
```

**查询参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `interval` | string | 是 | - | 时间区间，范围 `1m` ~ `60d` |
| `coin` | string | 是 | - | 币种名称 |
| `limit` | integer | 是 | 10（最大 100） | 返回记录数量上限 |

**响应 `data` 字段：**

`data` 为数组，每个元素：

| 字段 | 类型 | 说明 |
|------|------|------|
| `time` | number | 清算时间戳（毫秒） |
| `address` | string | 钱包地址 |
| `coin` | string | 币种名称 |
| `direction` | string | 仓位方向 |
| `oid` | number | 订单 ID |
| `liqPrice` | string | 清算价格 |
| `liquidatedVal` | string | 清算价值（USD） |
| `pnl` | string | 盈亏金额（USD） |
| `startPosition` | string | 清算前仓位大小 |
| `endPosition` | string | 清算后仓位大小 |

---

## 持仓量（Open Interest）

### 获取持仓量汇总

```
GET /v2/hl/open-interest-summary
```

**查询参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `coin` | string | 否 | 筛选指定币种 |

**响应 `data` 字段：** 持仓量汇总统计对象

---

### 获取持仓量 Top 币种

```
GET /v2/hl/open-interest-top-coins
```

**查询参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `limit` | integer | 否 | 返回记录数量上限 |

**响应 `data` 字段：** 按持仓量排序的币种列表（数组）

---

### 获取持仓量历史

```
GET /v2/hl/open-interest-history
```

**查询参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `coin` | string | 否 | 筛选指定币种 |
| `interval` | string | 否 | 时间粒度 |
| `limit` | integer | 否 | 返回数据点数量上限 |

**响应 `data` 字段：** 持仓量历史时间序列（数组）

---

## 市场深度与 K 线

### 获取 K 线与 Taker 成交量

```
GET /v2/hl/klines-with-taker-vol/:coin/:interval
```

在标准 OHLCV K 线数据基础上附加 Taker 买入成交量，用于分析主动买卖力量。

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `coin` | string | 是 | 币种名称，如 `"ETH"` |
| `interval` | string | 是 | K 线周期，如 `1m`、`15m`、`1h`、`4h`、`1d` |

**查询参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `startTime` | integer | 是 | 开始时间戳（毫秒） |
| `limit` | integer | 否 | 返回 K 线数量上限 |

**响应 `data` 字段：**

`data` 为数组，每个元素：

| 字段 | 类型 | 说明 |
|------|------|------|
| `openTime` | number | K 线开盘时间戳（毫秒） |
| `open` | string | 开盘价 |
| `high` | string | 最高价 |
| `low` | string | 最低价 |
| `close` | string | 收盘价 |
| `size` | string | 总成交量 |
| `sizeBuyer` | string | Taker 主动买入成交量 |

---

## 订单簿历史与 Taker Delta

### 获取订单簿历史汇总

```
GET /v2/hl/orderbooks-history-summaries
```

**查询参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `coin` | string | 否 | 筛选指定币种 |
| `interval` | string | 否 | 时间粒度 |

**响应 `data` 字段：** 历史订单簿聚合数据

---

### 获取累计 Taker Delta

```
GET /v2/hl/accumulated-taker-delta
```

**查询参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `coin` | string | 否 | 筛选指定币种 |
| `interval` | string | 否 | 时间粒度 |

**响应 `data` 字段：** 累计 Taker 买卖压力数据

---

## 统一 Info 端点

```
POST /v2/hl/info
```

兼容 Hyperliquid 官方 Info API 格式，通过 `type` 字段指定查询类型，统一入口访问多种市场数据。

**请求体（application/json）基本结构：**

```json
{
  "type": "查询类型",
  "其他参数": "..."
}
```

### 支持的查询类型

#### `meta` — 获取永续合约元数据

```json
{ "type": "meta" }
```

响应包含所有永续合约的币种信息、精度、最大杠杆等。

---

#### `spotMeta` — 获取现货元数据

```json
{ "type": "spotMeta" }
```

---

#### `clearinghouseState` — 获取用户永续合约账户状态

```json
{
  "type": "clearinghouseState",
  "user": "0xabc..."
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user` | string | 是 | 用户钱包地址 |

---

#### `spotClearinghouseState` — 获取用户现货账户状态

```json
{
  "type": "spotClearinghouseState",
  "user": "0xabc..."
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user` | string | 是 | 用户钱包地址 |

---

#### `openOrders` — 获取用户挂单列表

```json
{
  "type": "openOrders",
  "user": "0xabc..."
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user` | string | 是 | 用户钱包地址 |

---

#### `frontendOpenOrders` — 获取用户挂单（前端格式）

```json
{
  "type": "frontendOpenOrders",
  "user": "0xabc...",
  "dex": "optional-dex"
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user` | string | 是 | 用户钱包地址 |
| `dex` | string | 否 | 指定 DEX |

---

#### `userFees` — 获取用户手续费信息

```json
{
  "type": "userFees",
  "user": "0xabc..."
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user` | string | 是 | 用户钱包地址 |

---

#### `userFills` — 获取用户成交记录

```json
{
  "type": "userFills",
  "user": "0xabc...",
  "aggregateByTime": true
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user` | string | 是 | 用户钱包地址 |
| `aggregateByTime` | boolean | 否 | 是否按时间聚合 |

---

#### `userFillsByTime` — 按时间范围查询成交

```json
{
  "type": "userFillsByTime",
  "user": "0xabc...",
  "startTime": 1700000000000,
  "endTime": 1700086400000,
  "aggregateByTime": false
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user` | string | 是 | 用户钱包地址 |
| `startTime` | integer | 是 | 开始时间戳（毫秒） |
| `endTime` | integer | 否 | 结束时间戳（毫秒） |
| `aggregateByTime` | boolean | 否 | 是否按时间聚合 |

---

#### `candleSnapshot` — 获取 K 线数据

```json
{
  "type": "candleSnapshot",
  "req": {
    "coin": "ETH",
    "interval": "1h",
    "startTime": 1700000000000,
    "endTime": 1700086400000
  }
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `req.coin` | string | 是 | 币种名称 |
| `req.interval` | string | 是 | K 线周期 |
| `req.startTime` | integer | 是 | 开始时间戳（毫秒） |
| `req.endTime` | integer | 否 | 结束时间戳（毫秒） |

---

#### `perpDexs` — 获取永续 DEX 列表

```json
{ "type": "perpDexs" }
```

---

#### `historicalOrders` — 获取历史订单

```json
{
  "type": "historicalOrders",
  "user": "0xabc..."
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user` | string | 是 | 用户钱包地址 |

---

#### `orderStatus` — 查询指定订单状态

```json
{
  "type": "orderStatus",
  "user": "0xabc...",
  "oid": 123456
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user` | string | 是 | 用户钱包地址 |
| `oid` | integer | 是 | 订单 ID |

---

#### `userFunding` — 获取资金费历史

```json
{
  "type": "userFunding",
  "user": "0xabc...",
  "startTime": 1700000000000,
  "endTime": 1700086400000
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user` | string | 是 | 用户钱包地址 |
| `startTime` | integer | 是 | 开始时间戳（毫秒） |
| `endTime` | integer | 否 | 结束时间戳（毫秒） |

---

#### `userNonFundingLedgerUpdates` — 获取非资金费账本更新

```json
{
  "type": "userNonFundingLedgerUpdates",
  "user": "0xabc...",
  "startTime": 1700000000000,
  "endTime": 1700086400000
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user` | string | 是 | 用户钱包地址 |
| `startTime` | integer | 是 | 开始时间戳（毫秒） |
| `endTime` | integer | 否 | 结束时间戳（毫秒） |

---

#### `allMids` — 获取所有币种中间价

```json
{ "type": "allMids" }
```

响应为 `币种名称 → 中间价` 的映射对象，如：

```json
{
  "BTC": "42000.5",
  "ETH": "2800.25"
}
```

---

#### `l2Book` — 获取订单簿

```json
{
  "type": "l2Book",
  "coin": "ETH"
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `coin` | string | 是 | 币种名称 |

响应包含 `levels`（买卖盘档位列表）和 `time`（时间戳）。

---

## Info 子端点

统一 Info 端点的各查询类型也可通过独立子路径访问（均为 POST 方法）：

| 子端点路径 | 对应 Info type | 参数 |
|-----------|---------------|------|
| `/v2/hl/info/spot-meta` | `spotMeta` | 无 |
| `/v2/hl/info/clearinghouse-state` | `clearinghouseState` | `user`（query），`dex`（query，可选） |
| `/v2/hl/info/spot-clearinghouse-state` | `spotClearinghouseState` | `user`（query） |
| `/v2/hl/info/open-orders` | `openOrders` | `user`（query） |
| `/v2/hl/info/frontend-open-orders` | `frontendOpenOrders` | `user`（query） |
| `/v2/hl/info/user-fees` | `userFees` | `user`（query） |
| `/v2/hl/info/user-fills` | `userFills` | `user`（query） |
| `/v2/hl/info/user-fills-by-time` | `userFillsByTime` | `user`、`startTime`、`endTime`（query） |
| `/v2/hl/info/candle-snapshot` | `candleSnapshot` | `coin`、`interval`（query） |
| `/v2/hl/info/perp-dexs` | `perpDexs` | 无 |
| `/v2/hl/info/all-mids` | `allMids` | 无 |
| `/v2/hl/info/l2-book` | `l2Book` | `coin`（query） |
| `/v2/hl/info/historical-orders` | `historicalOrders` | `user`（query），`coin`（query，可选） |
| `/v2/hl/info/order-status` | `orderStatus` | `user`、`oid`（query） |
| `/v2/hl/info/user-funding` | `userFunding` | `user`（query），`startTime`、`endTime`（query，可选） |
| `/v2/hl/info/user-non-funding-ledger-updates` | `userNonFundingLedgerUpdates` | `user`（query），`startTime`、`endTime`（query，可选） |
| `/v2/hl/info/portfolio` | — | `user`（query） |
| `/v2/hl/info/web-data2` | — | `user`（query） |
| `/v2/hl/info/user-twap-slice-fills` | — | `user`、`twapId`（query） |
| `/v2/hl/info/active-asset-data` | — | 无 |

---

## WebSocket 端点

WebSocket Base URL：

```
wss://openapi.hyperbot.network/api/upgrade
```

### /v2/hl/ws — 主订阅入口（官方兼容格式）

```
WS /v2/hl/ws
```

支持以官方 Hyperliquid 格式订阅实时数据推送。

**连接后发送订阅消息：**

```json
{
  "method": "subscribe",
  "subscription": {
    "type": "订阅类型",
    "附加参数": "..."
  }
}
```

**取消订阅：**

```json
{
  "method": "unsubscribe",
  "subscription": {
    "type": "订阅类型"
  }
}
```

**支持的 subscription.type：**

| type | 附加参数 | 说明 |
|------|----------|------|
| `trades` | `coin` (string) | 订阅指定币种的实时成交流 |
| `openOrders` | `user` (string) | 订阅用户挂单变化 |
| `clearinghouseState` | `user` (string) | 订阅用户账户状态变化 |
| `userFills` | `user` (string) | 订阅用户成交推送 |
| `userNonFundingLedgerUpdates` | `user` (string) | 订阅用户非资金费账本更新 |

> 注意：`allMids` 和 `orderUpdates` 类型在此入口**不支持**。

**示例（订阅 BTC 成交）：**

```json
{
  "method": "subscribe",
  "subscription": {
    "type": "trades",
    "coin": "BTC"
  }
}
```

---

### /v2/hl/ws/fills — 用户成交订阅

```
WS /v2/hl/ws/fills
```

支持同时订阅多个地址的实时成交推送。

**订阅消息格式：**

```json
{
  "type": "subscribe",
  "address": ["0xbadb...", "0x0104..."]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | string | 是 | 固定为 `"subscribe"` |
| `address` | array[string] | 是 | 要订阅的钱包地址列表 |

**推送消息字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `address` | string | 成交所属的钱包地址 |
| `time` | number | 成交时间戳（毫秒） |
| `coin` | string | 币种名称 |
| `px` | string | 成交价格 |
| `sz` | string | 成交数量 |
| `side` | string | 成交方向：`"B"`（买）或 `"A"`（卖） |
| `startPosition` | string | 成交前仓位大小 |
| `dir` | string | 仓位变化方向描述 |
| `closedPnl` | string | 本次成交产生的已实现盈亏 |
| `hash` | string | 链上交易哈希 |
| `oid` | number | 关联订单 ID |
| `crossed` | boolean | 是否为 Taker 单（穿越订单簿） |
| `fee` | string | 手续费金额 |
| `tid` | number | 成交 ID |
| `feeToken` | string | 手续费计价 Token |
| `twapId` | number \| null | 关联 TWAP 订单 ID，非 TWAP 时为 `null` |

---

### /v2/hl/ws/filled-orders — 用户成交订单订阅

```
WS /v2/hl/ws/filled-orders
```

推送订单维度的成交信息（区别于 `/fills` 的逐笔成交）。

**订阅消息格式：**

```json
{
  "type": "subscribe",
  "address": ["0xbadb...", "0x0104..."]
}
```

与 `/ws/fills` 格式相同。

**推送消息字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `ts` | number | 订单成交时间戳（毫秒） |
| `address` | string | 钱包地址 |
| `hash` | string | 链上交易哈希 |
| `builder` | string | 构建者地址 |
| `status` | string | 订单状态，如 `"filled"` |
| `coin` | string | 币种名称 |
| `side` | string | 方向：`"B"`（买）或 `"A"`（卖） |
| `limitPx` | string | 限价单价格 |
| `sz` | string | 订单数量 |
| `oid` | number | 订单 ID |
| `placeTs` | number | 下单时间戳（毫秒） |
