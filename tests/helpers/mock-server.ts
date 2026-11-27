import fs from "node:fs";
import path from "node:path";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

// MOCK_BASE_URL in vitest.config.mts. Tests never reach the real mock on :8765.
export const BASE = "http://mock.test";

type Row = Record<string, unknown>;
// The real seed data (read only), so a full sync gives the real counts.
export const businessData = JSON.parse(fs.readFileSync(path.resolve("attachments/business_data.json"), "utf8")) as {
  customers: Row[];
  orders: Row[];
  payments: Row[];
  shipments: Row[];
};

export const defaultHandlers = [
  http.get(`${BASE}/commerce/customers`, () => HttpResponse.json(businessData.customers)),
  http.get(`${BASE}/commerce/orders`, () => HttpResponse.json(businessData.orders)),
  http.get(`${BASE}/commerce/tickets`, () => HttpResponse.json([])),
  http.get(`${BASE}/payments/transactions`, () => HttpResponse.json(businessData.payments)),
  http.get(`${BASE}/payments/refunds`, () => HttpResponse.json([])),
  http.get(`${BASE}/shipping/shipments`, () => HttpResponse.json(businessData.shipments)),
];

export const server = setupServer(...defaultHandlers);
