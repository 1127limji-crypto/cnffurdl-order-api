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

function getProductOrderIdsFromRows(rows) {
  const ids = [];

  for (const row of rows || []) {
    const productOrderId =
      row.productOrderId ||
      (row.productOrder && row.productOrder.productOrderId) ||
      (row.productOrderInfo && row.productOrderInfo.productOrderId) ||
      (row.productOrderInfo && row.productOrderInfo.productOrder && row.productOrderInfo.productOrder.productOrderId);

    if (productOrderId) ids.push(String(productOrderId));
  }

  return Array.from(new Set(ids));
}

function hasOrderDetail(row) {
  if (!row) return false;
  return Boolean(
    row.order ||
    row.productOrder ||
    row.delivery ||
    row.shippingAddress ||
    row.productOrderInfo ||
    row.orderInfo
  );
}

async function getProductOrderDetailsByIds(productOrderIds, options = {}) {
  const cleanIds = Array.from(new Set((productOrderIds || []).map((id) => String(id).trim()).filter(Boolean)));

  if (!cleanIds.length) {
    return [];
  }

  const result = await naverApiFetch("/v1/pay-order/seller/product-orders/query", {
    method: "POST",
    body: {
      productOrderIds: cleanIds,
      quantityClaimCompatibility: true
    },
    type: options.type,
    accountId: options.accountId
  });

  return getContentsFromNaverResponse(result.data);
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

function getNested(obj, paths, fallback = "") {
  for (const path of paths) {
    const value = path.split(".").reduce((acc, key) => acc && acc[key] !== undefined ? acc[key] : undefined, obj);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return fallback;
}

function extractSimpleOrder(row) {
  const order = row.order || row.orderInfo || row.orderResponseContent || {};
  const productOrder = row.productOrder || row.productOrderInfo || row.productOrderResponseContent || {};
  const delivery = row.delivery || row.deliveryInfo || row.deliveryResponseContent || {};
  const shippingAddress = row.shippingAddress || row.shippingAddressInfo || row.shippingAddressResponseContent || {};

  const productOrderId = getNested(row, [
    "productOrderId",
    "productOrder.productOrderId",
    "productOrderInfo.productOrderId",
    "productOrderResponseContent.productOrderId"
  ]);

  const orderId = getNested(row, [
    "order.orderId",
    "orderInfo.orderId",
    "productOrder.orderId",
    "productOrderInfo.orderId"
  ]);

  const orderNo = getNested(row, [
    "order.orderNo",
    "orderInfo.orderNo",
    "orderNo"
  ]);

  const productName = getNested(row, [
    "productOrder.productName",
    "productOrderInfo.productName",
    "productOrderResponseContent.productName",
    "productName"
  ]);

  const optionCode = getNested(row, [
    "productOrder.optionCode",
    "productOrderInfo.optionCode",
    "productOrderResponseContent.optionCode",
    "optionCode"
  ]);

  const status = getNested(row, [
    "productOrder.productOrderStatus",
    "productOrderInfo.productOrderStatus",
    "productOrderResponseContent.productOrderStatus",
    "productOrderStatus"
  ]);

  const quantity = getNested(row, [
    "productOrder.quantity",
    "productOrder.initialQuantity",
    "productOrder.remainQuantity",
    "productOrderInfo.quantity",
    "productOrderInfo.initialQuantity",
    "productOrderInfo.remainQuantity",
    "quantity"
  ]);

  const amount = Number(getNested(row, [
    "productOrder.totalProductAmount",
    "productOrder.initialPaymentAmount",
    "productOrder.remainPaymentAmount",
    "productOrderInfo.totalProductAmount",
    "productOrderInfo.initialPaymentAmount",
    "productOrderInfo.remainPaymentAmount",
    "totalProductAmount",
    "paymentAmount"
  ], 0)) || 0;

  return {
    productOrderId,
    orderId,
    orderNo,
    orderDate: getNested(row, ["order.orderDate", "orderInfo.orderDate", "orderDate"]),
    paymentDate: getNested(row, ["order.paymentDate", "orderInfo.paymentDate", "paymentDate"]),
    orderName: getNested(row, ["order.orderName", "orderInfo.orderName", "orderName"]),
    orderTel: getNested(row, ["order.orderTel", "orderInfo.orderTel", "orderTel"]),
    productName,
    optionCode,
    quantity,
    amount,
    status,
    deliveryCompany: getNested(row, ["delivery.deliveryCompany", "deliveryInfo.deliveryCompany", "productOrder.expectedDeliveryCompany", "productOrderInfo.expectedDeliveryCompany"]),
    shippingMemo: getNested(row, ["productOrder.shippingMemo", "productOrderInfo.shippingMemo", "shippingMemo"]),
    receiverName: getNested(row, ["shippingAddress.name", "shippingAddressInfo.name", "receiverName"]),
    receiverTel1: getNested(row, ["shippingAddress.tel1", "shippingAddressInfo.tel1", "receiverTel1"]),
    receiverTel2: getNested(row, ["shippingAddress.tel2", "shippingAddressInfo.tel2", "receiverTel2"]),
    zipCode: getNested(row, ["shippingAddress.zipCode", "shippingAddressInfo.zipCode", "zipCode"]),
    baseAddress: getNested(row, ["shippingAddress.baseAddress", "shippingAddressInfo.baseAddress", "baseAddress"]),
    detailedAddress: getNested(row, ["shippingAddress.detailedAddress", "shippingAddressInfo.detailedAddress", "detailedAddress"]),
    raw: row
  };
}


async function fetchDetailedOrdersByCondition({
  from,
  to,
  rangeType = "PAYED_DATETIME",
  productOrderStatuses = "PAYED",
  page = "1",
  size = "300",
  type,
  accountId
}) {
  const params = new URLSearchParams();
  params.append("from", from);
  params.append("to", to);
  params.append("rangeType", rangeType);
  params.append("page", page);
  params.append("size", size);

  if (productOrderStatuses) {
    params.append("productOrderStatuses", productOrderStatuses);
  }

  const result = await naverApiFetch(`/v1/pay-order/seller/product-orders?${params.toString()}`, {
    method: "GET",
    type,
    accountId
  });

  const contents = getContentsFromNaverResponse(result.data);
  const productOrderIds = getProductOrderIdsFromRows(contents);

  let detailRows = contents;
  let detailFetchUsed = false;

  if (productOrderIds.length && (!contents.length || !contents.some(hasOrderDetail))) {
    detailRows = await getProductOrderDetailsByIds(productOrderIds, {
      type,
      accountId
    });
    detailFetchUsed = true;
  }

  return {
    query: { from, to, rangeType, productOrderStatuses, page, size },
    productOrderIds,
    detailFetchUsed,
    rows: detailRows,
    raw: detailFetchUsed ? { firstQuery: result.data, detailRows } : result.data
  };
}

function parseYmdToDate(ymd) {
  const match = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const yyyy = Number(match[1]);
  const mm = Number(match[2]);
  const dd = Number(match[3]);
  return new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0, 0));
}

function getKstYmd(date) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, "0")}-${String(kst.getUTCDate()).padStart(2, "0")}`;
}

function ymdToKstDateTime(ymd, endOfDay = false) {
  return `${ymd}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+09:00`;
}

function addDaysUtc(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function getDateRangeList(startYmd, endYmd) {
  const start = parseYmdToDate(startYmd);
  const end = parseYmdToDate(endYmd);
  if (!start || !end || start > end) return [];

  const list = [];
  let current = start;
  while (current <= end) {
    list.push(getKstYmd(current));
    current = addDaysUtc(current, 1);
  }
  return list;
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
    const productOrderIds = getProductOrderIdsFromRows(contents);

    let detailRows = contents;
    let detailFetchUsed = false;

    // 조건형 조회 결과가 상품주문번호 위주로만 내려오는 경우,
    // 상품주문번호를 이용해 상세조회 API를 한 번 더 호출합니다.
    if (productOrderIds.length && (!contents.length || !contents.some(hasOrderDetail))) {
      detailRows = await getProductOrderDetailsByIds(productOrderIds, {
        type: req.query.type ? String(req.query.type) : undefined,
        accountId: req.query.account_id ? String(req.query.account_id) : undefined
      });
      detailFetchUsed = true;
    }

    const simpleOrders = detailRows.map(extractSimpleOrder);

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
      detailFetchUsed,
      productOrderIds,
      orders: simpleOrders,
      raw: detailFetchUsed ? { firstQuery: result.data, detailRows } : result.data
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


app.get("/naver/unshipped-orders", requireFirebaseAdmin, async (req, res) => {
  try {
    const todayYmd = getKstYmd(new Date());

    const requestedDays = Math.max(1, Math.min(180, Number(req.query.days) || 180));
    const endYmd = req.query.endDate ? String(req.query.endDate) : todayYmd;

    let startYmd = req.query.startDate ? String(req.query.startDate) : null;
    if (!startYmd) {
      const endDate = parseYmdToDate(endYmd) || parseYmdToDate(todayYmd);
      startYmd = getKstYmd(addDaysUtc(endDate, -(requestedDays - 1)));
    }

    const dateList = getDateRangeList(startYmd, endYmd);

    if (!dateList.length) {
      return res.status(400).json({
        ok: false,
        message: "조회 기간이 올바르지 않습니다. startDate/endDate 형식은 YYYY-MM-DD입니다."
      });
    }

    if (dateList.length > 180) {
      return res.status(400).json({
        ok: false,
        message: "한 번에 조회 가능한 기간은 최대 180일입니다."
      });
    }

    const allRows = [];
    const dayResults = [];
    const type = req.query.type ? String(req.query.type) : undefined;
    const accountId = req.query.account_id ? String(req.query.account_id) : undefined;

    for (const ymd of dateList) {
      const from = ymdToKstDateTime(ymd, false);
      const to = ymdToKstDateTime(ymd, true);

      const result = await fetchDetailedOrdersByCondition({
        from,
        to,
        rangeType: "PAYED_DATETIME",
        productOrderStatuses: "PAYED",
        page: "1",
        size: "300",
        type,
        accountId
      });

      const simpleOrders = result.rows.map(extractSimpleOrder);

      allRows.push(...simpleOrders);

      dayResults.push({
        date: ymd,
        count: simpleOrders.length,
        detailFetchUsed: result.detailFetchUsed,
        productOrderIds: result.productOrderIds
      });
    }

    const uniqueMap = new Map();
    for (const row of allRows) {
      const key = row.productOrderId || `${row.orderNo}-${row.productName}-${row.quantity}`;
      if (!uniqueMap.has(key)) uniqueMap.set(key, row);
    }

    const orders = Array.from(uniqueMap.values());

    res.json({
      ok: true,
      message: "네이버 스마트스토어 미발송/결제완료 주문 전체 조회 성공",
      admin: req.adminUser.email,
      query: {
        startDate: startYmd,
        endDate: endYmd,
        days: dateList.length,
        productOrderStatuses: "PAYED",
        rangeType: "PAYED_DATETIME"
      },
      count: orders.length,
      orders,
      dayResults
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
