import Stripe from 'stripe';

export type OrderRow = {
  id: string; listing_id: string; buyer_id: string; seller_id: string; title: string;
  item_pence: number; fee_pence: number; delivery_pence: number; total_pence: number;
  status: string; funds: string; created_at: string; expires_at: string;
  checkout_ref: string | null; payment_ref: string | null;
};
export type Address = { name: string; line1: string; line2: string | null; city: string; postcode: string };
export type PaymentEvent = { id: string } & (
  | { type: 'paid'; orderId: string; paymentRef: string; amount: number; currency: string; address: Address | null }
  | { type: 'failed'; orderId: string }
  | { type: 'account'; account: string; payoutsEnabled: boolean }
  | { type: 'chargeback'; paymentRef: string; disputeRef: string }
  | { type: 'ignored' });

/** Everything the app needs from a payment provider. Tests supply a fake. */
export type Payments = {
  createCheckout(order: OrderRow, origin: string, buyerEmail?: string): Promise<{ id: string; url: string }>;
  expireCheckout(checkoutRef: string): Promise<void>;
  /** Throws when the signature does not match. */
  parseEvent(rawBody: Buffer, signature: string): PaymentEvent;
  refund(order: OrderRow): Promise<string>;
  /** Pays the seller the item price plus the delivery charge they covered. */
  transfer(order: OrderRow, account: string): Promise<string>;
  createSellerAccount(sellerId: string, email: string | undefined): Promise<string>;
  onboardingLink(account: string, origin: string): Promise<string>;
  /** Asks the provider directly whether the seller can receive transfers yet. */
  accountReady(account: string): Promise<boolean>;
};

export const sellerAmount = (order: Pick<OrderRow, 'item_pence' | 'delivery_pence'>) => order.item_pence + order.delivery_pence;

/**
 * Stripe Connect, "separate charges and transfers": the buyer pays the platform
 * account, funds stay in the platform balance during the hold, and a transfer to
 * the seller's connected account is created only when the order says release_due.
 * Every money call carries an idempotency key derived from the order, so a
 * retried request or a repeated worker run cannot pay or refund twice.
 */
export function stripePayments(secretKey: string, ...webhookSecrets: string[]): Payments {
  const stripe = new Stripe(secretKey);
  const line = (name: string, amount: number) => ({ quantity: 1, price_data: { currency: 'gbp', unit_amount: amount, product_data: { name } } });
  return {
    async createCheckout(order, origin, buyerEmail) {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        // Cards only (Apple Pay and Google Pay ride on cards). Pay-later methods such as Klarna settle
        // and dispute differently, which does not suit money held for a seller.
        allowed_payment_method_types: ['card'],
        customer_email: buyerEmail,
        client_reference_id: order.id,
        metadata: { order_id: order.id },
        payment_intent_data: { transfer_group: order.id, metadata: { order_id: order.id } },
        line_items: [line(order.title, order.item_pence),
          ...(order.fee_pence ? [line('Re-Golf buyer protection fee', order.fee_pence)] : []),
          ...(order.delivery_pence ? [line('Tracked delivery', order.delivery_pence)] : [])],
        shipping_address_collection: { allowed_countries: ['GB'] },
        // Fixed from the order's creation time so a retry sends identical parameters.
        // Stripe's minimum is 30 minutes; the database reservation outlasts it.
        expires_at: Math.floor(Date.parse(order.created_at) / 1000) + 31 * 60,
        success_url: `${origin}/?order=${order.id}`,
        cancel_url: `${origin}/?order=${order.id}&cancelled=1`,
      }, { idempotencyKey: `checkout-v2-${order.id}` });
      if (!session.url) throw new Error('Stripe returned no checkout URL');
      return { id: session.id, url: session.url };
    },
    async expireCheckout(checkoutRef) { await stripe.checkout.sessions.expire(checkoutRef); },
    parseEvent(rawBody, signature) {
      // Events arrive from two Stripe destinations (platform and connected accounts), each with its own secret.
      const secrets = webhookSecrets.filter(Boolean);
      let event: Stripe.Event | undefined;
      for (const [index, secret] of secrets.entries()) {
        try { event = stripe.webhooks.constructEvent(rawBody, signature, secret); break; }
        catch (error) { if (index === secrets.length - 1) throw error; }
      }
      if (!event) throw new Error('No webhook secret configured');
      switch (event.type) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded': {
          const session = event.data.object;
          const orderId = session.metadata?.order_id;
          const paymentRef = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
          if (!orderId || !paymentRef || session.payment_status !== 'paid') return { id: event.id, type: 'ignored' };
          const shipping = session.collected_information?.shipping_details;
          const a = shipping?.address;
          const address = shipping && a?.line1 && a.postal_code
            ? { name: shipping.name, line1: a.line1, line2: a.line2 || null, city: a.city || a.state || '', postcode: a.postal_code } : null;
          return { id: event.id, type: 'paid', orderId, paymentRef, amount: session.amount_total ?? -1, currency: session.currency ?? '', address };
        }
        case 'checkout.session.expired':
        case 'checkout.session.async_payment_failed': {
          const orderId = event.data.object.metadata?.order_id;
          return orderId ? { id: event.id, type: 'failed', orderId } : { id: event.id, type: 'ignored' };
        }
        case 'account.updated': {
          const account = event.data.object;
          return { id: event.id, type: 'account', account: account.id, payoutsEnabled: account.capabilities?.transfers === 'active' };
        }
        case 'charge.dispute.created': {
          const dispute = event.data.object;
          const paymentRef = typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent?.id;
          return paymentRef ? { id: event.id, type: 'chargeback', paymentRef, disputeRef: dispute.id } : { id: event.id, type: 'ignored' };
        }
        default: return { id: event.id, type: 'ignored' };
      }
    },
    async refund(order) {
      if (!order.payment_ref) throw new Error('Order has no payment to refund');
      const refund = await stripe.refunds.create({ payment_intent: order.payment_ref, metadata: { order_id: order.id } },
        { idempotencyKey: `refund-${order.id}` });
      return refund.id;
    },
    async transfer(order, account) {
      if (!order.payment_ref) throw new Error('Order has no payment to release');
      const intent = await stripe.paymentIntents.retrieve(order.payment_ref);
      const charge = typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.latest_charge?.id;
      if (!charge) throw new Error('Payment has no charge to release from');
      // source_transaction ties the transfer to this buyer's charge, so it cannot
      // be funded by another order's money and may be created before settlement.
      const transfer = await stripe.transfers.create({ amount: sellerAmount(order), currency: 'gbp', destination: account,
        transfer_group: order.id, source_transaction: charge, metadata: { order_id: order.id } },
        { idempotencyKey: `release-${order.id}` });
      return transfer.id;
    },
    async createSellerAccount(sellerId, email) {
      // Accounts v2 "recipient": the seller only receives transfers; Re-Golf is the merchant.
      // Stripe hosts onboarding and identity checks and gives the seller an Express dashboard.
      const account = await stripe.v2.core.accounts.create({
        contact_email: email, dashboard: 'express',
        identity: { country: 'gb', entity_type: 'individual' },
        configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
        defaults: { currency: 'gbp', responsibilities: { fees_collector: 'application', losses_collector: 'application' } },
        metadata: { seller_id: sellerId },
      }, { idempotencyKey: `seller-${sellerId}` });
      return account.id;
    },
    async onboardingLink(account, origin) {
      const link = await stripe.v2.core.accountLinks.create({ account, use_case: { type: 'account_onboarding',
        account_onboarding: { refresh_url: `${origin}/?payouts=retry`, return_url: `${origin}/?payouts=done` } } });
      return link.url;
    },
    async accountReady(account) {
      const found = await stripe.v2.core.accounts.retrieve(account, { include: ['configuration.recipient'] });
      return found.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status === 'active';
    },
  };
}
