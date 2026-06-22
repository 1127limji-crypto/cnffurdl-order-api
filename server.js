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

function firstNonEmpty(values, fallback = "") {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return fallback;
}

function buildOptionInfo(row) {
  const values = [
    getNested(row, ["productOrder.optionInfo", "productOrderInfo.optionInfo", "productOrderResponseContent.optionInfo"]),
    getNested(row, ["productOrder.optionName", "productOrderInfo.optionName", "productOrderResponseContent.optionName"]),
    getNested(row, ["productOrder.optionValue", "productOrderInfo.optionValue", "productOrderResponseContent.optionValue"]),
    getNested(row, ["productOrder.productOption", "productOrderInfo.productOption", "productOrderResponseContent.productOption"]),
    getNested(row, ["productOrder.productOptionContents", "productOrderInfo.productOptionContents", "productOrderResponseContent.productOptionContents"]),
    getNested(row, ["productOrder.optionManageCode", "productOrderInfo.optionManageCode", "productOrderResponseContent.optionManageCode"]),
    getNested(row, ["productOrder.optionCode", "productOrderInfo.optionCode", "productOrderResponseContent.optionCode"]),
    getNested(row, ["optionInfo", "optionName", "optionValue", "productOption", "productOptionContents", "optionManageCode", "optionCode"])
  ];

  return Array.from(new Set(values.map((v) => String(v || "").trim()).filter(Boolean))).join(" / ");
}


function getNaverStatusLabel(code, type = "product") {
  const value = String(code || "").trim().toUpperCase();

  const productStatusMap = {
    PAYED: "신규주문/결제완료",
    PRODUCT_PREPARE: "상품준비중",
    DELIVERING: "배송중",
    DELIVERED: "배송완료",
    PURCHASE_DECIDED: "구매확정",
    EXCHANGED: "교환",
    CANCELED: "취소",
    RETURNED: "반품",
    CANCELED_BY_NOPAYMENT: "미입금취소"
  };

  const claimStatusMap = {
    CANCEL_REQUEST: "취소요청",
    CANCELING: "취소처리중",
    CANCEL_DONE: "취소완료",
    CANCEL_REJECT: "취소철회/거부",
    RETURN_REQUEST: "반품요청",
    RETURNING: "반품처리중",
    RETURN_DONE: "반품완료",
    RETURN_REJECT: "반품철회/거부",
    EXCHANGE_REQUEST: "교환요청",
    EXCHANGING: "교환처리중",
    EXCHANGE_DONE: "교환완료",
    EXCHANGE_REJECT: "교환철회/거부"
  };

  const deliveryStatusMap = {
    DELIVERING: "배송중",
    DELIVERED: "배송완료",
    COLLECTING: "수거중",
    COLLECTED: "수거완료"
  };

  const map = type === "claim" ? claimStatusMap : type === "delivery" ? deliveryStatusMap : productStatusMap;
  return value ? (map[value] || value) : "";
}

function inferPlaceOrderLabel(row) {
  const productStatus = String(row.productOrderStatus || row.status || "").toUpperCase();
  const deliveryStatus = String(row.deliveryStatus || "").toUpperCase();
  const claimStatus = String(row.claimStatus || "").toUpperCase();
  const claimType = String(row.claimType || "").toUpperCase();

  if (claimStatus || claimType) return "클레임";
  if (["DELIVERING", "DELIVERED", "PURCHASE_DECIDED"].includes(productStatus) || ["DELIVERING", "DELIVERED"].includes(deliveryStatus)) return "발송 이후";
  if (productStatus === "PAYED") return "신규주문(발주전)";
  if (["PRODUCT_PREPARE", "DISPATCHED", "PLACE_PRODUCT_ORDER"].includes(productStatus)) return "신규주문(발주후)";
  return productStatus ? "상태확인필요" : "";
}

function isBeforeShipmentOrClaim(order) {
  const productStatus = String(order.productOrderStatus || order.status || "").toUpperCase();
  const deliveryStatus = String(order.deliveryStatus || "").toUpperCase();
  const claimStatus = String(order.claimStatus || "").toUpperCase();
  const claimType = String(order.claimType || "").toUpperCase();

  if (claimStatus || claimType) return true;

  const shippedStatuses = new Set(["DELIVERING", "DELIVERED", "PURCHASE_DECIDED"]);
  if (shippedStatuses.has(productStatus)) return false;
  if (shippedStatuses.has(deliveryStatus)) return false;

  return true;
}


function extractSimpleOrder(row) {
  const order = row.order || row.orderInfo || row.orderResponseContent || {};
  const productOrder = row.productOrder || row.productOrderInfo || row.productOrderResponseContent || {};
  const delivery = row.delivery || row.deliveryInfo || row.deliveryResponseContent || {};
  const shippingAddress = row.shippingAddress || row.shippingAddressInfo || row.shippingAddressResponseContent || {};
  const claim = row.claim || row.claimInfo || row.claimResponseContent || {};

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

  const optionInfo = buildOptionInfo(row);
  const optionCode = optionInfo || getNested(row, [
    "productOrder.optionCode",
    "productOrderInfo.optionCode",
    "productOrderResponseContent.optionCode",
    "optionCode"
  ]);

  const productOrderStatus = getNested(row, [
    "productOrder.productOrderStatus",
    "productOrderInfo.productOrderStatus",
    "productOrderResponseContent.productOrderStatus",
    "productOrderStatus"
  ]);

  const claimStatus = getNested(row, [
    "claim.claimStatus",
    "claimInfo.claimStatus",
    "claimResponseContent.claimStatus",
    "productOrder.claimStatus",
    "productOrderInfo.claimStatus",
    "claimStatus"
  ]);

  const claimType = getNested(row, [
    "claim.claimType",
    "claimInfo.claimType",
    "claimResponseContent.claimType",
    "productOrder.claimType",
    "productOrderInfo.claimType",
    "claimType"
  ]);

  const deliveryStatus = getNested(row, [
    "delivery.deliveryStatus",
    "deliveryInfo.deliveryStatus",
    "deliveryResponseContent.deliveryStatus",
    "productOrder.deliveryStatus",
    "productOrderInfo.deliveryStatus",
    "deliveryStatus"
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

  const simple = {
    productOrderId,
    orderId,
    orderNo,
    orderDate: getNested(row, ["order.orderDate", "orderInfo.orderDate", "orderDate"]),
    paymentDate: getNested(row, ["order.paymentDate", "orderInfo.paymentDate", "paymentDate"]),
    buyerName: firstNonEmpty([
      getNested(row, ["order.ordererName", "orderInfo.ordererName"]),
      getNested(row, ["order.orderName", "orderInfo.orderName"]),
      getNested(row, ["order.purchaserName", "orderInfo.purchaserName"]),
      getNested(row, ["order.buyerName", "orderInfo.buyerName"]),
      getNested(row, ["productOrder.ordererName", "productOrderInfo.ordererName"]),
      getNested(row, ["productOrder.purchaserName", "productOrderInfo.purchaserName"]),
      getNested(row, ["buyerName", "ordererName", "purchaserName", "orderName"])
    ]),
    orderName: firstNonEmpty([
      getNested(row, ["order.ordererName", "orderInfo.ordererName"]),
      getNested(row, ["order.orderName", "orderInfo.orderName"]),
      getNested(row, ["order.purchaserName", "orderInfo.purchaserName"]),
      getNested(row, ["order.buyerName", "orderInfo.buyerName"]),
      getNested(row, ["productOrder.ordererName", "productOrderInfo.ordererName"]),
      getNested(row, ["productOrder.purchaserName", "productOrderInfo.purchaserName"]),
      getNested(row, ["buyerName", "ordererName", "purchaserName", "orderName"])
    ]),
    orderTel: getNested(row, ["order.orderTel", "orderInfo.orderTel", "orderTel"]),
    productName,
    optionInfo,
    optionCode,
    quantity,
    amount,

    productOrderStatus,
    productOrderStatusLabel: getNaverStatusLabel(productOrderStatus, "product"),
    status: productOrderStatus,
    statusLabel: getNaverStatusLabel(productOrderStatus, "product"),

    claimStatus,
    claimStatusLabel: getNaverStatusLabel(claimStatus, "claim"),
    claimType,

    deliveryStatus,
    deliveryStatusLabel: getNaverStatusLabel(deliveryStatus, "delivery"),

    placeOrderLabel: "",

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

  simple.placeOrderLabel = inferPlaceOrderLabel(simple);

  return simple;
}

function removeUndefinedDeep(value) {
  if (Array.isArray(value)) {
    return value.map(removeUndefinedDeep);
  }

  if (value && typeof value === "object") {
    const cleaned = {};
    for (const [key, val] of Object.entries(value)) {
      if (val !== undefined) {
        cleaned[key] = removeUndefinedDeep(val);
      }
    }
    return cleaned;
  }

  return value;
}

function dateOnlyFromDateTime(value) {
  if (!value) return "";
  return String(value).slice(0, 10);
}

async function saveNaverOrdersToFirestore(orders, source = "manual") {
  initFirebaseAdmin();

  if (!orders || !orders.length) {
    return 0;
  }

  const db = admin.firestore();
  const collection = db.collection("naverOrders");
  const now = admin.firestore.FieldValue.serverTimestamp();

  let savedCount = 0;
  let batch = db.batch();
  let batchCount = 0;

  for (const order of orders) {
    const productOrderId = order.productOrderId || "";
    if (!productOrderId) continue;

    const docRef = collection.doc(String(productOrderId));
    const payload = removeUndefinedDeep({
      ...order,
      estimateNo: order.estimateNo || extractEstimateNoFromText(order.optionInfo, order.optionCode, order.shippingMemo, order.productName),
      paymentDateYmd: dateOnlyFromDateTime(order.paymentDate),
      orderDateYmd: dateOnlyFromDateTime(order.orderDate),
      source,
      lastSyncedAt: now
    });

    batch.set(docRef, payload, { merge: true });
    savedCount++;
    batchCount++;

    if (batchCount >= 400) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  }

  if (batchCount > 0) {
    await batch.commit();
  }

  return savedCount;
}

function filterStoredOrders(orders, { startDate, endDate, keyword }) {
  const kw = String(keyword || "").trim().toLowerCase();

  return orders.filter((order) => {
    const date = order.paymentDateYmd || order.orderDateYmd || "";
    const dateMatched =
      (!startDate || (date && date >= startDate)) &&
      (!endDate || (date && date <= endDate));

    const joined = [
      order.productOrderId,
      order.orderNo,
      order.orderId,
      order.orderName,
      order.receiverName,
      order.productName,
      order.optionInfo,
      order.optionCode,
      order.estimateNo,
      order.matchedEstimateNo,
      order.status,
      order.shippingMemo
    ].join(" ").toLowerCase();

    const keywordMatched = !kw || joined.includes(kw);

    return dateMatched && keywordMatched;
  });
}



const ESTIMATE_STATUS_LABELS = {
  UNPAID: "미결제",
  PAID: "결제완료",
  CONFIRMED: "주문확인",
  SHIPPED: "발송완료"
};

function normalizeEstimateStatus(status) {
  const value = String(status || "UNPAID").trim().toUpperCase();
  return ESTIMATE_STATUS_LABELS[value] ? value : "UNPAID";
}

function getEstimateStatusLabel(status) {
  return ESTIMATE_STATUS_LABELS[normalizeEstimateStatus(status)];
}

function serializeFirestoreValue(value) {
  if (value && typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(serializeFirestoreValue);
  }

  if (value && typeof value === "object") {
    const obj = {};
    for (const [key, val] of Object.entries(value)) {
      obj[key] = serializeFirestoreValue(val);
    }
    return obj;
  }

  return value;
}

function estimateDateOnly(row) {
  if (row.createdAtLocal) return String(row.createdAtLocal).slice(0, 10);
  if (row.createdAt && typeof row.createdAt === "string") return row.createdAt.slice(0, 10);
  if (row.createdAtIso) return String(row.createdAtIso).slice(0, 10);
  return "";
}

function filterEstimates(rows, { startDate, endDate, keyword, status }) {
  const kw = String(keyword || "").trim().toLowerCase();
  const normalizedStatus = status ? normalizeEstimateStatus(status) : "";

  return rows.filter((row) => {
    const date = estimateDateOnly(row);
    const dateMatched =
      (!startDate || (date && date >= startDate)) &&
      (!endDate || (date && date <= endDate));

    const rowStatus = normalizeEstimateStatus(row.orderStatus || row.status);

    const statusMatched = !normalizedStatus || rowStatus === normalizedStatus;

    const joined = [
      row.estimateNo,
      row.customerName,
      row.paperName,
      row.coatingText,
      row.foilText,
      row.pdfFileName,
      row.matchedEstimateNo,
      row.matchedNaverOrderNo,
      row.matchedNaverProductOrderId,
      row.matchType,
      rowStatus,
      getEstimateStatusLabel(rowStatus)
    ].join(" ").toLowerCase();

    const keywordMatched = !kw || joined.includes(kw);

    return dateMatched && statusMatched && keywordMatched;
  });
}



function extractEstimateNoFromText(...values) {
  const text = values
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value))
    .join(" ");

  const patterns = [
    /(EST[-_\s]?\d{6}[-_\s]?\d{3,6})/i,
    /(CNF[-_\s]?\d{6}[-_\s]?\d{3,6})/i,
    /(견적서번호|견적번호|견적\s*번호|estimate\s*no\.?)\s*[:：]?\s*([A-Z]{2,5}[-_\s]?\d{6}[-_\s]?\d{3,6}|\d{6}[-_\s]?\d{3,6})/i,
    /(\d{6}[-_\s]?\d{3,6})/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const raw = match[2] || match[1];
      return String(raw)
        .toUpperCase()
        .replace(/\s+/g, "-")
        .replace(/_/g, "-")
        .replace(/^-+|-+$/g, "");
    }
  }

  return "";
}

function normalizeAmount(value) {
  const number = Number(String(value || "0").replace(/[^\d.-]/g, ""));
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function getEstimateAmount(row) {
  return normalizeAmount(row.totalPrice || row.finalPrice || row.estimatePrice || row.amount);
}

function getNaverOrderAmount(row) {
  return normalizeAmount(row.amount || row.totalProductAmount || row.paymentAmount);
}

function normalizeName(value) {
  return String(value || "").replace(/\s+/g, "").trim().toLowerCase();
}

function getEstimateCustomerName(row) {
  return row.customerName || row.orderName || row.buyerName || "";
}

function getNaverBuyerName(row) {
  return row.buyerName || row.orderName || "";
}

async function matchNaverOrdersToEstimates(orders, source = "auto") {
  initFirebaseAdmin();

  if (!orders || !orders.length) {
    return { matchedCount: 0, candidatesCount: 0, results: [] };
  }

  const db = admin.firestore();
  const estimatesRef = db.collection("estimates");
  const results = [];
  let matchedCount = 0;
  let candidatesCount = 0;

  for (const order of orders) {
    const productOrderId = String(order.productOrderId || "").trim();
    if (!productOrderId) continue;

    const estimateNo = extractEstimateNoFromText(
      order.estimateNo,
      order.optionInfo,
      order.optionCode,
      order.shippingMemo,
      order.productName,
      order.orderNo,
      order.raw ? JSON.stringify(order.raw).slice(0, 3000) : ""
    );

    let matchedEstimate = null;
    let matchType = "";
    let candidateEstimates = [];

    if (estimateNo) {
      const snapshot = await estimatesRef.where("estimateNo", "==", estimateNo).limit(1).get();
      if (!snapshot.empty) {
        matchedEstimate = { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
        matchType = "estimateNo";
      }
    }

    if (!matchedEstimate) {
      const amount = getNaverOrderAmount(order);
      const buyerName = normalizeName(getNaverBuyerName(order));

      if (amount && buyerName) {
        const snapshot = await estimatesRef
          .where("totalPrice", "==", amount)
          .limit(20)
          .get();

        candidateEstimates = snapshot.docs
          .map((doc) => ({ id: doc.id, ...doc.data() }))
          .filter((estimate) => normalizeName(getEstimateCustomerName(estimate)) === buyerName);

        if (candidateEstimates.length === 1) {
          matchedEstimate = candidateEstimates[0];
          matchType = "buyerNameAmount";
        } else if (candidateEstimates.length > 1) {
          candidatesCount++;
        }
      }
    }

    if (matchedEstimate) {
      const estimateDocRef = estimatesRef.doc(matchedEstimate.id);
      const orderDocRef = db.collection("naverOrders").doc(productOrderId);

      const matchPayload = {
        matchedEstimateId: matchedEstimate.id,
        matchedEstimateNo: matchedEstimate.estimateNo || estimateNo || "",
        matchedNaverProductOrderId: productOrderId,
        matchedNaverOrderNo: order.orderNo || order.orderId || "",
        matchedNaverAmount: getNaverOrderAmount(order),
        matchedNaverBuyerName: getNaverBuyerName(order),
        matchType,
        matchedAt: admin.firestore.FieldValue.serverTimestamp(),
        matchedBy: source,
        orderStatus: "PAID",
        orderStatusLabel: "결제완료",
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      await estimateDocRef.set(matchPayload, { merge: true });

      await orderDocRef.set({
        matchedEstimateId: matchedEstimate.id,
        matchedEstimateNo: matchedEstimate.estimateNo || estimateNo || "",
        matchType,
        matchedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      matchedCount++;
      results.push({
        productOrderId,
        estimateId: matchedEstimate.id,
        estimateNo: matchedEstimate.estimateNo || estimateNo || "",
        matchType
      });
    } else {
      results.push({
        productOrderId,
        estimateNo,
        matchType: "",
        candidatesCount: candidateEstimates.length || 0
      });
    }
  }

  return { matchedCount, candidatesCount, results };
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
      "/naver/unshipped-orders",
      "/stored/naver-orders",
      "/stored/estimates",
      "/stored/estimates/:estimateId/status",
      "/stored/estimates/:estimateId",
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


function getKstYmd(date = new Date()) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, "0")}-${String(kst.getUTCDate()).padStart(2, "0")}`;
}

function parseYmdToDate(ymd) {
  const match = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const yyyy = Number(match[1]);
  const mm = Number(match[2]);
  const dd = Number(match[3]);

  return new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0, 0));
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

  if (!start || !end || start > end) {
    return [];
  }

  const list = [];
  let current = start;

  while (current <= end) {
    list.push(getKstYmd(current));
    current = addDaysUtc(current, 1);
  }

  return list;
}

async function fetchDetailedOrdersByCondition({
  from,
  to,
  rangeType = "PAYED_DATETIME",
  productOrderStatuses = "",
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
    query: {
      from,
      to,
      rangeType,
      productOrderStatuses,
      page,
      size
    },
    productOrderIds,
    detailFetchUsed,
    rows: detailRows,
    raw: detailFetchUsed ? { firstQuery: result.data, detailRows } : result.data
  };
}


app.get("/naver/orders", requireFirebaseAdmin, async (req, res) => {
  try {
    const defaultRange = getDefaultOrderRange();

    const from = req.query.from ? String(req.query.from) : defaultRange.from;
    const to = req.query.to ? String(req.query.to) : defaultRange.to;
    const rangeType = req.query.rangeType ? String(req.query.rangeType) : "PAYED_DATETIME";
    const productOrderStatuses = req.query.productOrderStatuses !== undefined ? String(req.query.productOrderStatuses) : "";
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

    const simpleOrders = detailRows.map(extractSimpleOrder).filter(isBeforeShipmentOrClaim);
    const savedCount = await saveNaverOrdersToFirestore(simpleOrders, "naver-orders");
    const matchResult = await matchNaverOrdersToEstimates(simpleOrders, "naver-orders");

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
      savedCount,
      matchedCount: matchResult.matchedCount,
      candidatesCount: matchResult.candidatesCount,
      matchResult,
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
        productOrderStatuses: "",
        page: "1",
        size: "300",
        type,
        accountId
      });

      const simpleOrders = result.rows.map(extractSimpleOrder).filter(isBeforeShipmentOrClaim);

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
    const savedCount = await saveNaverOrdersToFirestore(orders, "naver-unshipped-orders");
    const matchResult = await matchNaverOrdersToEstimates(orders, "naver-unshipped-orders");

    res.json({
      ok: true,
      message: "네이버 스마트스토어 배송 전/클레임 주문 조회 성공",
      admin: req.adminUser.email,
      query: {
        startDate: startYmd,
        endDate: endYmd,
        days: dateList.length,
        productOrderStatuses: "",
        rangeType: "PAYED_DATETIME"
      },
      count: orders.length,
      savedCount,
      matchedCount: matchResult.matchedCount,
      candidatesCount: matchResult.candidatesCount,
      matchResult,
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




app.get("/stored/estimates", requireFirebaseAdmin, async (req, res) => {
  try {
    initFirebaseAdmin();

    const startDate = req.query.startDate ? String(req.query.startDate) : "";
    const endDate = req.query.endDate ? String(req.query.endDate) : "";
    const keyword = req.query.keyword ? String(req.query.keyword) : "";
    const status = req.query.status ? String(req.query.status) : "";
    const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 1000));

    const snapshot = await admin.firestore()
      .collection("estimates")
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    const rows = snapshot.docs.map((doc) => {
      const data = serializeFirestoreValue(doc.data());
      const orderStatus = normalizeEstimateStatus(data.orderStatus || data.status);
      return {
        id: doc.id,
        ...data,
        orderStatus,
        orderStatusLabel: getEstimateStatusLabel(orderStatus)
      };
    });

    const filtered = filterEstimates(rows, { startDate, endDate, keyword, status });

    res.json({
      ok: true,
      message: "견적 목록 조회 성공",
      admin: req.adminUser.email,
      query: {
        startDate,
        endDate,
        keyword,
        status,
        limit
      },
      count: filtered.length,
      estimates: filtered
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

app.patch("/stored/estimates/:estimateId/status", requireFirebaseAdmin, async (req, res) => {
  try {
    initFirebaseAdmin();

    const estimateId = String(req.params.estimateId || "").trim();
    const orderStatus = normalizeEstimateStatus(req.body.orderStatus || req.body.status);

    if (!estimateId) {
      return res.status(400).json({
        ok: false,
        message: "estimateId가 필요합니다."
      });
    }

    await admin.firestore()
      .collection("estimates")
      .doc(estimateId)
      .set({
        orderStatus,
        orderStatusLabel: getEstimateStatusLabel(orderStatus),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: req.adminUser.email
      }, { merge: true });

    res.json({
      ok: true,
      message: "견적 상태 변경 완료",
      estimateId,
      orderStatus,
      orderStatusLabel: getEstimateStatusLabel(orderStatus)
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

app.delete("/stored/estimates/:estimateId", requireFirebaseAdmin, async (req, res) => {
  try {
    initFirebaseAdmin();

    const estimateId = String(req.params.estimateId || "").trim();

    if (!estimateId) {
      return res.status(400).json({
        ok: false,
        message: "estimateId가 필요합니다."
      });
    }

    await admin.firestore()
      .collection("estimates")
      .doc(estimateId)
      .delete();

    res.json({
      ok: true,
      message: "견적 삭제 완료",
      estimateId
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


app.get("/stored/naver-orders", requireFirebaseAdmin, async (req, res) => {
  try {
    initFirebaseAdmin();

    const startDate = req.query.startDate ? String(req.query.startDate) : "";
    const endDate = req.query.endDate ? String(req.query.endDate) : "";
    const keyword = req.query.keyword ? String(req.query.keyword) : "";
    const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 1000));

    const snapshot = await admin.firestore()
      .collection("naverOrders")
      .orderBy("lastSyncedAt", "desc")
      .limit(limit)
      .get();

    const orders = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data()
    }));

    const filteredOrders = filterStoredOrders(orders, {
      startDate,
      endDate,
      keyword
    });

    res.json({
      ok: true,
      message: "저장된 네이버 주문 조회 성공",
      admin: req.adminUser.email,
      query: {
        startDate,
        endDate,
        keyword,
        limit
      },
      count: filteredOrders.length,
      orders: filteredOrders
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



app.post("/stored/match-estimate-naver", requireFirebaseAdmin, async (req, res) => {
  try {
    initFirebaseAdmin();

    const estimateId = String(req.body.estimateId || "").trim();
    const productOrderId = String(req.body.productOrderId || "").trim();

    if (!estimateId || !productOrderId) {
      return res.status(400).json({
        ok: false,
        message: "estimateId와 productOrderId가 필요합니다."
      });
    }

    const db = admin.firestore();
    const estimateRef = db.collection("estimates").doc(estimateId);
    const orderRef = db.collection("naverOrders").doc(productOrderId);

    const [estimateSnap, orderSnap] = await Promise.all([estimateRef.get(), orderRef.get()]);

    if (!estimateSnap.exists) {
      return res.status(404).json({ ok: false, message: "견적서를 찾을 수 없습니다." });
    }

    if (!orderSnap.exists) {
      return res.status(404).json({ ok: false, message: "네이버 주문을 찾을 수 없습니다." });
    }

    const estimate = estimateSnap.data();
    const order = orderSnap.data();

    await estimateRef.set({
      matchedEstimateNo: estimate.estimateNo || "",
      matchedNaverProductOrderId: productOrderId,
      matchedNaverOrderNo: order.orderNo || order.orderId || "",
      matchedNaverAmount: getNaverOrderAmount(order),
      matchedNaverBuyerName: getNaverBuyerName(order),
      matchType: "manual",
      matchedAt: admin.firestore.FieldValue.serverTimestamp(),
      matchedBy: req.adminUser.email,
      orderStatus: "PAID",
      orderStatusLabel: "결제완료",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: req.adminUser.email
    }, { merge: true });

    await orderRef.set({
      matchedEstimateId: estimateId,
      matchedEstimateNo: estimate.estimateNo || "",
      matchType: "manual",
      matchedAt: admin.firestore.FieldValue.serverTimestamp(),
      matchedBy: req.adminUser.email
    }, { merge: true });

    res.json({
      ok: true,
      message: "견적서와 네이버 주문 매칭 완료",
      estimateId,
      productOrderId
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

app.post("/stored/unmatch-estimate", requireFirebaseAdmin, async (req, res) => {
  try {
    initFirebaseAdmin();

    const estimateId = String(req.body.estimateId || "").trim();

    if (!estimateId) {
      return res.status(400).json({
        ok: false,
        message: "estimateId가 필요합니다."
      });
    }

    const db = admin.firestore();
    const estimateRef = db.collection("estimates").doc(estimateId);
    const estimateSnap = await estimateRef.get();

    if (!estimateSnap.exists) {
      return res.status(404).json({ ok: false, message: "견적서를 찾을 수 없습니다." });
    }

    const estimate = estimateSnap.data();
    const productOrderId = estimate.matchedNaverProductOrderId || "";

    await estimateRef.set({
      matchedNaverProductOrderId: admin.firestore.FieldValue.delete(),
      matchedNaverOrderNo: admin.firestore.FieldValue.delete(),
      matchedNaverAmount: admin.firestore.FieldValue.delete(),
      matchedNaverBuyerName: admin.firestore.FieldValue.delete(),
      matchType: admin.firestore.FieldValue.delete(),
      matchedAt: admin.firestore.FieldValue.delete(),
      matchedBy: admin.firestore.FieldValue.delete(),
      orderStatus: "UNPAID",
      orderStatusLabel: "미결제",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: req.adminUser.email
    }, { merge: true });

    if (productOrderId) {
      await db.collection("naverOrders").doc(String(productOrderId)).set({
        matchedEstimateId: admin.firestore.FieldValue.delete(),
        matchedEstimateNo: admin.firestore.FieldValue.delete(),
        matchType: admin.firestore.FieldValue.delete(),
        matchedAt: admin.firestore.FieldValue.delete(),
        matchedBy: admin.firestore.FieldValue.delete()
      }, { merge: true });
    }

    res.json({
      ok: true,
      message: "매칭 해제 완료",
      estimateId,
      productOrderId
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
