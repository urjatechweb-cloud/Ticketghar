import { createHmac, timingSafeEqual } from 'crypto';
import { AppConfig } from '../config';

export type ProviderName = 'khalti' | 'esewa' | 'mock';

export interface InitiateInput {
  paymentId: string;
  bookingId: string;
  amountPaisa: number;
  title: string;
  customer: { name?: string | null; phone: string };
  returnUrl: string;
  websiteUrl: string;
}

export type InitiateResult =
  | { kind: 'redirect'; url: string; providerRef: string }
  | { kind: 'form'; action: string; fields: Record<string, string>; providerRef: string };

export interface VerifyResult {
  providerRef: string;
  status: 'completed' | 'pending' | 'failed';
  amountPaisa: number;
  raw: unknown;
}

export interface PaymentProvider {
  readonly name: ProviderName;
  initiate(input: InitiateInput): Promise<InitiateResult>;
}

type FetchFn = typeof fetch;

/**
 * Khalti ePayment (KPG-2). Amounts are in paisa; only status "Completed" from
 * the lookup API counts as paid. Docs: https://docs.khalti.com/khalti-epayment/
 */
export class KhaltiProvider implements PaymentProvider {
  readonly name = 'khalti' as const;
  constructor(private readonly cfg: AppConfig['khalti'], private readonly http: FetchFn = fetch) {}

  private headers() {
    if (!this.cfg.secretKey) throw new Error('KHALTI_SECRET_KEY is not set');
    return { Authorization: `Key ${this.cfg.secretKey}`, 'Content-Type': 'application/json' };
  }

  async initiate(input: InitiateInput): Promise<InitiateResult> {
    const res = await this.http(`${this.cfg.baseUrl}/epayment/initiate/`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        return_url: input.returnUrl,
        website_url: input.websiteUrl,
        amount: input.amountPaisa,
        purchase_order_id: input.paymentId,
        purchase_order_name: input.title.slice(0, 100),
        customer_info: { name: input.customer.name ?? 'TicketGhar customer', phone: input.customer.phone.slice(-10) },
      }),
    });
    const body: any = await res.json();
    if (!res.ok || !body.pidx) throw new Error(`Khalti initiate failed: ${JSON.stringify(body)}`);
    return { kind: 'redirect', url: body.payment_url, providerRef: body.pidx };
  }

  async lookup(pidx: string): Promise<VerifyResult> {
    const res = await this.http(`${this.cfg.baseUrl}/epayment/lookup/`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ pidx }),
    });
    const body: any = await res.json();
    const status = body.status === 'Completed' ? 'completed'
      : ['Pending', 'Initiated'].includes(body.status) ? 'pending' : 'failed';
    return { providerRef: pidx, status, amountPaisa: Number(body.total_amount ?? 0), raw: body };
  }
}

/** eSewa ePay v2: HMAC-SHA256 over "k=v,k=v" of the signed fields, base64 encoded. */
export function esewaSignature(fields: Record<string, string>, signedFieldNames: string, secret: string): string {
  const message = signedFieldNames.split(',').map((k) => `${k}=${fields[k]}`).join(',');
  return createHmac('sha256', secret).update(message).digest('base64');
}

export class EsewaProvider implements PaymentProvider {
  readonly name = 'esewa' as const;
  constructor(private readonly cfg: AppConfig['esewa'], private readonly http: FetchFn = fetch) {}

  static rupees(paisa: number): string {
    return (paisa / 100).toFixed(2);
  }

  async initiate(input: InitiateInput): Promise<InitiateResult> {
    if (!this.cfg.secretKey) throw new Error('ESEWA_SECRET_KEY is not set');
    const total = EsewaProvider.rupees(input.amountPaisa);
    const fields: Record<string, string> = {
      amount: total,
      tax_amount: '0',
      total_amount: total,
      transaction_uuid: input.paymentId,
      product_code: this.cfg.productCode,
      product_service_charge: '0',
      product_delivery_charge: '0',
      success_url: input.returnUrl,
      failure_url: `${input.websiteUrl}/bookings/${input.bookingId}?payment=failed`,
      signed_field_names: 'total_amount,transaction_uuid,product_code',
    };
    fields.signature = esewaSignature(fields, fields.signed_field_names, this.cfg.secretKey);
    return { kind: 'form', action: this.cfg.formUrl, fields, providerRef: input.paymentId };
  }

  /** Decodes and checks the signature of the base64 `data` eSewa returns to success_url. */
  decodeReturn(data: string): { transaction_uuid: string; total_amount: string; status: string } {
    const json = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
    const expected = esewaSignature(json, json.signed_field_names, this.cfg.secretKey);
    const a = Buffer.from(expected);
    const b = Buffer.from(String(json.signature ?? ''));
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('eSewa signature mismatch');
    return json;
  }

  /** Server-to-server status check; never trust the browser redirect alone. */
  async status(transactionUuid: string, totalAmount: string): Promise<VerifyResult> {
    const url = new URL(this.cfg.statusUrl);
    url.searchParams.set('product_code', this.cfg.productCode);
    url.searchParams.set('total_amount', totalAmount);
    url.searchParams.set('transaction_uuid', transactionUuid);
    const res = await this.http(url.toString());
    const body: any = await res.json();
    const status = body.status === 'COMPLETE' ? 'completed' : body.status === 'PENDING' ? 'pending' : 'failed';
    return {
      providerRef: transactionUuid,
      status,
      amountPaisa: Math.round(Number(body.total_amount ?? totalAmount) * 100),
      raw: body,
    };
  }
}

/** Development-only provider: the "payment page" is a button in our own web app. */
export class MockProvider implements PaymentProvider {
  readonly name = 'mock' as const;
  constructor(private readonly webUrl: string) {}
  async initiate(input: InitiateInput): Promise<InitiateResult> {
    return { kind: 'redirect', url: `${this.webUrl}/pay/mock/${input.paymentId}`, providerRef: input.paymentId };
  }
}
