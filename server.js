const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");

const app = express();

app.use(cors({
  origin: "*"
}));

app.use(express.json());

const NAVER_API_BASE_URL = "https://api.commerce.naver.com/external";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} 환경변수가 설정되지 않았습니다.`);
  }
  return value;
}

function maskValue(value, visible = 6) {
  if (!value) return "";
  const str = String(value);
  if (str.length <= visible) return "*".repeat(str.length);
  return str.slice(0, visible) + "*".repeat(Math.max(0, str.length - visible));
}

function createNaverSignature(clientId, clientSecret, timestamp) {
  const password = `${clientId}_${timestamp}`;
  const hashed = bcrypt.hashSync(password, clientSecret);
  return Buffer.from(hashed, "utf-8").toString("base64");
}

function toKstDateTimeString(date) {
  const kstTime = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = kstTime.getUTCFullYear();
  const mm = String(kstTime.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kstTime.getUTCDate()).padStart(2, "0");
  const hh = String(kstTime.getUTCHours()).padStart(2, "0");
  const mi = String(kstTime.getUTCMinutes()).padStart(2, "0");
  const ss = String(kstTime.getUTCSeconds()).padStart(2, "0");
  const ms = String(kstTime.getUTCMilliseconds()).padStart(3, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}.${ms}+09:00`;
}

function getDefaultOrderRange() {
  const now = new Date();
  const from = new Date(now.getTime() - 23 * 60 * 60 * 1000);
  return {
    from: toKstDateTimeString(from),
    to: toKstDateTimeString(now)
  };
}

function getContentsFromNaverResponse(data) {
  if (!data) return [];
  if (Array.isArray(data.contents)) return data.contents;
  if (data.data && Array.isArray(data.data.contents)) return data.data.contents;
  if (Array.isArray(data.data)) return data.data;
  return [];
}

async function getNaverAccessToken(options = {}) {
  const clientId = requireEnv("NAVER_COMMERCE_CLIENT_ID");
  const clientSecret = requireEnv("NAVER_COMMERCE_CLIENT_SECRET");

  const timestamp = Date.now().toString();
  const clientSecretSign = createNaverSignature(clientId, clientSecret, timestamp);

  const type = options.type || process.env.NAVER_COMMERCE_AUTH_TYPE || "SELF";
  const accountId = options.accountId || process.env.NAVER_COMMERCE_ACCOUNT_ID || "";

  const body = new URLSearchParams();
  body.append("grant_type", "client_credentials");
  body.append("client_id", clientId);
  body.append("timestamp", timestamp);
  body.append("client_secret_sign", clientSecretSign);
  body.append("type", type);

  if (accountId) {
    body.append("account_id", accountId);
  }

  const response = await fetch(`${NAVER_API_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const rawText = await response.text();

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (error) {
    data = { rawText };
  }

  if (!response.ok) {
    const error = new Error("네이버 인증 토큰 발급 실패");
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return {
    accessToken: data.access_token,
    data,
    meta: {
      type,
      accountId: accountId || null,
      timestamp
    }
  };
}

async function naverApiFetch(path, options = {}) {
  const tokenResult = await getNaverAccessToken({
    type: options.type,
    accountId: options.accountId
  });

  const response = await fetch(`${NAVER_API_BASE_URL}${path}`, {
    method: options.method || "GET",
    headers: {
      "Authorization": `Bearer ${tokenResult.accessToken}`,
      "Content-Type": options.contentType || "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const rawText = await response.text();

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (error) {
    data = { rawText };
  }

  if (!response.ok) {
    const error = new Error("네이버 커머스API 호출 실패");
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return {
    data,
    tokenMeta: tokenResult.meta
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "cnffurdl-order-api",
    message: "출력이 주문 API 서버가 정상 실행 중입니다.",
    endpoints: [
      "/health",
      "/ip",
      "/naver/env-check",
      "/naver/token-test",
      "/naver/orders"
    ]
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "healthy",
    time: new Date().toISOString()
  });
});

app.get("/ip", async (req, res) => {
  try {
    const response = await fetch("https://api.ipify.org?format=json");
    const data = await response.json();

    res.json({
      ok: true,
      outboundIp: data.ip,
      message: "이 IP를 네이버 커머스API센터의 API 호출 IP에 등록하면 됩니다."
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/naver/env-check", (req, res) => {
  const clientId = process.env.NAVER_COMMERCE_CLIENT_ID || "";
  const clientSecret = process.env.NAVER_COMMERCE_CLIENT_SECRET || "";

  res.json({
    ok: true,
    env: {
      NAVER_COMMERCE_CLIENT_ID: clientId ? maskValue(clientId) : "NOT_SET",
      NAVER_COMMERCE_CLIENT_SECRET: clientSecret ? "SET" : "NOT_SET",
      NAVER_COMMERCE_AUTH_TYPE: process.env.NAVER_COMMERCE_AUTH_TYPE || "SELF",
      NAVER_COMMERCE_ACCOUNT_ID: process.env.NAVER_COMMERCE_ACCOUNT_ID ? "SET" : "NOT_SET"
    }
  });
});

app.get("/naver/token-test", async (req, res) => {
  try {
    const type = req.query.type ? String(req.query.type) : undefined;
    const accountId = req.query.account_id ? String(req.query.account_id) : undefined;

    const result = await getNaverAccessToken({ type, accountId });
    const tokenData = result.data || {};

    res.json({
      ok: true,
      message: "네이버 커머스API 인증 토큰 발급 성공",
      auth: {
        type: result.meta.type,
        accountId: result.meta.accountId
      },
      token: {
        accessTokenPreview: tokenData.access_token ? maskValue(tokenData.access_token, 12) : null,
        tokenType: tokenData.token_type || null,
        expiresIn: tokenData.expires_in || null
      },
      rawKeys: Object.keys(tokenData)
    });
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      message: error.message,
      status: error.status || 500,
      detail: error.data || null
    });
  }
});

app.get("/naver/orders", async (req, res) => {
  try {
    const defaultRange = getDefaultOrderRange();

    const from = req.query.from ? String(req.query.from) : defaultRange.from;
    const to = req.query.to ? String(req.query.to) : defaultRange.to;
    const rangeType = req.query.rangeType ? String(req.query.rangeType) : "PAYED_DATETIME";
    const productOrderStatuses = req.query.productOrderStatuses ? String(req.query.productOrderStatuses) : "PAYED";
    const page = req.query.page ? String(req.query.page) : "1";
    const size = req.query.size ? String(req.query.size) : "100";

    const params = new URLSearchParams();
    params.append("from", from);
    params.append("to", to);
    params.append("rangeType", rangeType);
    params.append("page", page);
    params.append("size", size);

    if (productOrderStatuses) {
      params.append("productOrderStatuses", productOrderStatuses);
    }

    if (req.query.claimStatuses) {
      params.append("claimStatuses", String(req.query.claimStatuses));
    }

    if (req.query.fulfillment) {
      params.append("fulfillment", String(req.query.fulfillment));
    }

    const result = await naverApiFetch(`/v1/pay-order/seller/product-orders?${params.toString()}`, {
      method: "GET",
      type: req.query.type ? String(req.query.type) : undefined,
      accountId: req.query.account_id ? String(req.query.account_id) : undefined
    });

    const contents = getContentsFromNaverResponse(result.data);

    res.json({
      ok: true,
      message: "네이버 스마트스토어 주문 조회 성공",
      query: {
        from,
        to,
        rangeType,
        productOrderStatuses,
        page,
        size
      },
      count: contents.length,
      contents,
      raw: result.data
    });
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      message: error.message,
      status: error.status || 500,
      detail: error.data || null
    });
  }
});

/*
  다음 단계에서 추가할 예정:
  - 상품 주문 상세 조회
  - 발주 확인 처리
  - Firebase Firestore 주문 저장
  - 관리자 페이지 주문 탭 연동
*/

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`cnffurdl-order-api running on port ${PORT}`);
});
