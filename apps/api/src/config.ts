/** All runtime configuration, read once from the environment. */
export interface AppConfig {
  databaseUrl: string;
  port: number;
  publicApiUrl: string;   // where providers redirect back to, e.g. https://api.ticketghar.com
  webUrl: string;         // customer web app, e.g. https://ticketghar.com
  adminApiKey: string;    // header x-api-key for admin/operator endpoints in Phase 0
  holdMinutes: number;
  enableMockPayments: boolean;
  khalti: { baseUrl: string; secretKey: string };
  esewa: { formUrl: string; statusUrl: string; productCode: string; secretKey: string };
  whatsapp: {
    graphUrl: string;
    phoneNumberId: string;
    accessToken: string;
    verifyToken: string;
    appSecret: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const str = (k: string, d = '') => env[k] ?? d;
  return {
    databaseUrl: str('DATABASE_URL', 'postgres://tg:tg@localhost:5432/ticketghar'),
    port: Number(str('PORT', '4000')),
    publicApiUrl: str('PUBLIC_API_URL', 'http://localhost:4000'),
    webUrl: str('WEB_URL', 'http://localhost:3000'),
    adminApiKey: str('ADMIN_API_KEY', 'dev-admin-key'),
    holdMinutes: Number(str('HOLD_MINUTES', '10')),
    enableMockPayments: str('ENABLE_MOCK_PAYMENTS', 'true') === 'true',
    khalti: {
      baseUrl: str('KHALTI_BASE_URL', 'https://dev.khalti.com/api/v2'),
      secretKey: str('KHALTI_SECRET_KEY'),
    },
    esewa: {
      formUrl: str('ESEWA_FORM_URL', 'https://rc-epay.esewa.com.np/api/epay/main/v2/form'),
      statusUrl: str('ESEWA_STATUS_URL', 'https://rc.esewa.com.np/api/epay/transaction/status/'),
      productCode: str('ESEWA_PRODUCT_CODE', 'EPAYTEST'),
      secretKey: str('ESEWA_SECRET_KEY'),
    },
    whatsapp: {
      graphUrl: str('WHATSAPP_GRAPH_URL', 'https://graph.facebook.com/v21.0'),
      phoneNumberId: str('WHATSAPP_PHONE_NUMBER_ID'),
      accessToken: str('WHATSAPP_ACCESS_TOKEN'),
      verifyToken: str('WHATSAPP_VERIFY_TOKEN', 'dev-verify-token'),
      appSecret: str('WHATSAPP_APP_SECRET', 'dev-app-secret'),
    },
  };
}

export const CONFIG = Symbol('CONFIG');
