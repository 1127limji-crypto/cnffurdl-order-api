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
    data,
    meta: {
      type,
      accountId: accountId || null,
      timestamp
    }
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
      "/naver/token-test"
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

/*
  다음 단계에서 추가할 예정:
  - 스마트스토어 주문 목록 조회
  - 상품 주문 상세 조회
  - 발주 확인 처리
  - Firebase Firestore 주문 저장
*/

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`cnffurdl-order-api running on port ${PORT}`);
});
