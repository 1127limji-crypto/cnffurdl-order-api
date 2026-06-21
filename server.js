const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const admin = require("firebase-admin");

const app = express();

app.use(cors({
  origin: "*"
}));

app.use(express.json());

const NAVER_API_BASE_URL = "https://api.commerce.naver.com/external";

let firebaseAdminInitialized = false;

function getAdminEmails() {
  const raw = process.env.ADMIN_EMAILS || "1127limji@gmail.com,cont834@gmail.com";
  return raw
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function normalizePrivateKey(key) {
  if (!key) return "";
  return key.replace(/\\n/g, "\n");
}

function initFirebaseAdmin() {
  if (firebaseAdminInitialized) return;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY);

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Firebase Admin 환경변수가 설정되지 않았습니다. FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY를 확인하세요.");
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey
      })
    });
  }

  firebaseAdminInitialized = true;
}

async function requireFirebaseAdmin(req, res, next) {
  try {
    initFirebaseAdmin();

    const authHeader = req.headers.authorization || "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return res.status(401).json({
        ok: false,
        message: "로그인이 필요합니다. Authorization: Bearer <Firebase ID Token> 헤더가 없습니다."
      });
    }

    const idToken = match[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    const email = String(decoded.email || "").toLowerCase();
    const adminEmails = getAdminEmails();

    if (!email || !adminEmails.includes(email)) {
      return res.status(403).json({
        ok: false,
        message: "관리자 권한이 없습니다.",
        email
      });
    }

    req.adminUser = {
      uid: decoded.uid,
      email
    };

    next();
  } catch (error) {
    return res.status(401).json({
      ok: false,
      message: "Firebase 로그인 검증 실패",
      error: error.message
    });
  }
}

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

function extractSimpleOrder(row) {
  const order = row.order || {};
  const productOrder = row.productOrder || {};
  const delivery = row.delivery || {};
  const shippingAddress = row.shippingAddress || {};
  const productOrderId = row.productOrderId || productOrder.productOrderId || "";
  const orderId = order.orderId || productOrder.orderId || "";
  const orderNo = order.orderNo || "";
  const productName = productOrder.productName || "";
  const optionCode = productOrder.optionCode || "";
  const status = productOrder.productOrderStatus || row.productOrderStatus || "";
  const quantity = productOrder.quantity || productOrder.initialQuantity || "";
  const amount = productOrder.totalProductAmount || productOrder.initialPaymentAmount || productOrder.remainPaymentAmount || 0;

  return {
    productOrderId,
    orderId,
    orderNo,
    orderDate: order.orderDate || "",
    paymentDate: order.paymentDate || "",
    orderName: order.orderName || "",
    orderTel: order.orderTel || "",
    productName,
    optionCode,
    quantity,
    amount,
    status,
    deliveryCompany: delivery.deliveryCompany || productOrder.expectedDeliveryCompany || "",
    shippingMemo: productOrder.shippingMemo || "",
    receiverName: shippingAddress.name || "",
    receiverTel1: shippingAddress.tel1 || "",
    receiverTel2: shippingAddress.tel2 || "",
    zipCode: shippingAddress.zipCode || "",
    baseAddress: shippingAddress.baseAddress || "",
    detailedAddress: shippingAddress.detailedAddress || "",
    raw: row
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "cnffurdl-order-api",
    message: "출력이 주문 API 서버가 정상 실행 중입니다.",
    security: "Firebase ID token required for /naver/* endpoints except /naver/env-check",
    endpoints: [
      "/health",
      "/ip",
      "/naver/env-check",
      "/naver/token-test",
      "/naver/orders",
      "/naver/confirm-order"
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
      NAVER_COMMERCE_ACCOUNT_ID: process.env.NAVER_COMMERCE_ACCOUNT_ID ? "SET" : "NOT_SET",
      FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID ? "SET" : "NOT_SET",
      FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL ? "SET" : "NOT_SET",
      FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY ? "SET" : "NOT_SET",
      ADMIN_EMAILS: getAdminEmails()
    }
  });
});

app.get("/naver/token-test", requireFirebaseAdmin, async (req, res) => {
  try {
    const type = req.query.type ? String(req.query.type) : undefined;
    const accountId = req.query.account_id ? String(req.query.account_id) : undefined;

    const result = await getNaverAccessToken({ type, accountId });
    const tokenData = result.data || {};

    res.json({
      ok: true,
      message: "네이버 커머스API 인증 토큰 발급 성공",
      admin: req.adminUser.email,
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

app.get("/naver/orders", requireFirebaseAdmin, async (req, res) => {
  try {
    const defaultRange = getDefaultOrderRange();

    const from = req.query.from ? String(req.query.from) : defaultRange.from;
    const to = req.query.to ? String(req.query.to) : defaultRange.to;
    const rangeType = req.query.rangeType ? String(req.query.rangeType) : "PAYED_DATETIME";
    const productOrderStatuses = req.query.productOrderStatuses !== undefined ? String(req.query.productOrderStatuses) : "PAYED";
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
    const simpleOrders = contents.map(extractSimpleOrder);

    res.json({
      ok: true,
      message: "네이버 스마트스토어 주문 조회 성공",
      admin: req.adminUser.email,
      query: {
        from,
        to,
        rangeType,
        productOrderStatuses,
        page,
        size
      },
      count: simpleOrders.length,
      orders: simpleOrders,
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

app.post("/naver/confirm-order", requireFirebaseAdmin, async (req, res) => {
  try {
    const productOrderIds =
      Array.isArray(req.body.productOrderIds)
        ? req.body.productOrderIds
        : req.body.productOrderId
          ? [req.body.productOrderId]
          : [];

    const cleanIds = productOrderIds
      .map((id) => String(id).trim())
      .filter(Boolean);

    if (!cleanIds.length) {
      return res.status(400).json({
        ok: false,
        message: "productOrderIds 배열 또는 productOrderId가 필요합니다."
      });
    }

    if (cleanIds.length > 30) {
      return res.status(400).json({
        ok: false,
        message: "발주 확인은 한 번에 최대 30개 상품주문번호만 요청할 수 있습니다."
      });
    }

    const result = await naverApiFetch("/v1/pay-order/seller/product-orders/confirm", {
      method: "POST",
      body: {
        productOrderIds: cleanIds
      },
      type: req.query.type ? String(req.query.type) : undefined,
      accountId: req.query.account_id ? String(req.query.account_id) : undefined
    });

    res.json({
      ok: true,
      message: "발주 확인 처리 요청 완료",
      admin: req.adminUser.email,
      productOrderIds: cleanIds,
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`cnffurdl-order-api running on port ${PORT}`);
});
