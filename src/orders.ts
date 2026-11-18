type Order = {
  id: string;
  listing_id: string;
  buyer_id: string;
  seller_id: string;
  title: string;
  item_pence: number;
  fee_pence: number;
  delivery_pence: number;
  total_pence: number;
  status: string;
  funds: string;
  expires_at: string;
  dispatch_by: string | null;
  tracking: string | null;
  release_at: string | null;
  issue: string | null;
  created_at: string;
  return_address?: string | null;
  return_by?: string | null;
  return_tracking?: string | null;
  return_posted_at?: string | null;
  return_escalated_at?: string | null;
};
type Address = { order_id: string; name: string; line1: string; line2: string | null; city: string; postcode: string };
type Quote = {
  title: string;
  item_pence: number;
  fee_pence: number;
  delivery_pence: number;
  total_pence: number;
  hold_hours: number;
};
type Api = <T>(path: string, options?: RequestInit) => Promise<T>;

export function setupOrders(
  api: Api,
  user: () => string | undefined,
  signIn: () => void,
  photoUrl: (path: string) => Promise<string | null>,
) {
  const el = (id: string) => document.getElementById(id)!;
  const dialog = el('orders-dialog') as HTMLDialogElement;
  const status = (text: string) => {
    el('orders-status').textContent = text;
  };
  const money = (pence: number) =>
    new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(pence / 100);
  const when = (iso: string) =>
    new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  const message = (error: unknown) => (error instanceof Error ? error.message : 'Please try again.');
  let enabled = false;
  let generation = 0;
  let busy = false;
  // One request ID per listing, kept until it succeeds, so a retried click cannot create two orders.
  const requests = new Map<string, string>();

  function add<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, text = '', className = '') {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    parent.append(node);
    return node;
  }
  function button(parent: HTMLElement, text: string, action: () => Promise<void>, dark = false) {
    const node = add(parent, 'button', text, `button ${dark ? 'button-dark' : 'button-outline'}`);
    node.type = 'button';
    node.onclick = () => void run(action);
    return node;
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    const gen = generation;
    dialog.querySelectorAll<HTMLButtonElement>('button:not([data-close-dialog])').forEach(node => {
      node.disabled = true;
    });
    try {
      await action();
    } catch (error) {
      if (gen === generation) status(message(error));
    } finally {
      busy = false;
      dialog.querySelectorAll<HTMLButtonElement>('button').forEach(node => {
        node.disabled = false;
      });
    }
  }
  const act = (order: Order, action: string, text?: string) => async () => {
    status('');
    await api(`/api/orders/${order.id}/${action}`, {
      method: 'POST',
      body: JSON.stringify(text === undefined ? {} : { text }),
    });
    await load();
  };

  /** A button that first reveals a text box, then sends what was typed with the action. */
  function prompted(
    parent: HTMLElement,
    order: Order,
    action: string,
    label: string,
    placeholder: string,
    minLength: number,
    open = false,
  ) {
    const input = add(parent, 'input');
    input.placeholder = placeholder;
    input.maxLength = 300;
    input.hidden = !open;
    input.setAttribute('aria-label', placeholder);
    button(
      parent,
      label,
      async () => {
        if (input.hidden) {
          input.hidden = false;
          input.focus();
          status(`${placeholder}, then press "${label}" again.`);
          return;
        }
        if (input.value.trim().length < minLength) {
          status(`${placeholder} first.`);
          input.focus();
          return;
        }
        await act(order, action, input.value.trim())();
      },
      open,
    );
  }

  function describe(order: Order, buying: boolean, payoutsEnabled: boolean) {
    const expired = order.status === 'awaiting_payment' && Date.parse(order.expires_at) <= Date.now();
    if (expired || order.status === 'expired')
      return order.funds === 'none'
        ? 'Checkout expired. Nothing was charged.'
        : 'Checkout expired; your payment is being refunded.';
    switch (order.status) {
      case 'awaiting_payment':
        return buying
          ? `Reserved for you until ${when(order.expires_at)}. Not yet paid.`
          : 'A buyer is at the checkout.';
      case 'paid':
        return buying
          ? `Paid. Relofted is holding your payment. The seller must post it by ${when(order.dispatch_by!)} or you are refunded automatically.`
          : `Sold. The buyer's payment is held by Relofted. Post it with tracking by ${when(order.dispatch_by!)} or the order is refunded.`;
      case 'dispatched':
        return buying
          ? 'Posted. Your payment stays held until you have received the item and had time to check it.'
          : 'Posted. You are paid after the buyer receives the item and the checking period ends.';
      case 'delivered':
        return buying
          ? `Received. Check your item: the seller is paid on ${when(order.release_at!)} unless you report a problem first.`
          : `Delivered. Your payment is released on ${when(order.release_at!)} unless the buyer reports a problem.`;
      case 'disputed':
        if (order.return_escalated_at)
          return 'Relofted support has been asked to decide. The payment stays frozen until they do.';
        if (order.return_posted_at)
          return buying
            ? 'You have posted the item back. You are refunded in full when the seller confirms it has arrived, or automatically if they do not respond once it has had time to arrive.'
            : 'The buyer has posted the item back. When it arrives, check it and confirm below so the buyer is refunded. If it does not arrive or is not what you sent, ask Relofted to decide. If you do neither, the buyer is refunded automatically.';
        if (order.return_by)
          return buying
            ? `The seller has asked for the item back. Post it to the return address below with a tracked service by ${when(order.return_by)} and enter the tracking number. Return postage is paid by you. If you do not, the seller is paid.`
            : `You asked for the item back. The buyer must post it with tracking by ${when(order.return_by)}, or the problem is closed and you are paid.`;
        return buying
          ? 'You reported a problem, so the payment is frozen. The seller can refund you or ask for the item back first. If you cannot agree, ask Relofted to decide.'
          : 'The buyer reported a problem, so the payment is frozen. Refund the buyer, or ask for the item back first. If you cannot agree, ask Relofted to decide.';
      case 'completed':
        if (buying) return 'Complete. Thank you for buying on Relofted.';
        if (order.funds === 'released') return 'Complete. Your payment has been sent to your payout account.';
        return payoutsEnabled
          ? 'Complete. Your payment is on its way to your payout account.'
          : 'Complete. Set up payouts above to receive your payment.';
      case 'cancelled':
        if (order.funds === 'refunded')
          return buying ? 'Cancelled and refunded in full.' : 'Cancelled. The buyer was refunded.';
        if (order.funds === 'refund_due')
          return buying ? 'Cancelled. Your full refund is on its way.' : 'Cancelled. The buyer is being refunded.';
        return 'Cancelled. Nothing was charged.';
      default:
        return order.status;
    }
  }

  function renderOrder(
    parent: HTMLElement,
    order: Order,
    address: Address | undefined,
    payoutsEnabled: boolean,
    canReview: boolean,
  ) {
    const buying = order.buyer_id === user();
    const row = add(parent, 'section', '', 'order-row');
    const picture = add(row, 'img', '', 'order-photo');
    picture.alt = '';
    picture.hidden = true;
    void photoUrl(`/api/orders/${order.id}/photo`).then(url => {
      if (url) {
        picture.src = url;
        picture.hidden = false;
      }
    });
    add(row, 'h4', order.title);
    add(row, 'p', describe(order, buying, payoutsEnabled));
    add(
      row,
      'p',
      buying
        ? `Item ${money(order.item_pence)} + buyer protection ${money(order.fee_pence)} + tracked delivery ${money(order.delivery_pence)} = ${money(order.total_pence)}`
        : `You receive ${money(order.item_pence + order.delivery_pence)} (item ${money(order.item_pence)} + postage ${money(order.delivery_pence)})`,
      'order-amounts',
    );
    if (order.tracking) add(row, 'p', `Tracking: ${order.tracking}`);
    if (order.issue) add(row, 'p', `Reported problem: ${order.issue}`);
    if (order.return_address) add(row, 'p', `${buying ? 'Return to' : 'Your return address'}: ${order.return_address}`);
    if (order.return_tracking) add(row, 'p', `Return tracking: ${order.return_tracking}`);
    if (address)
      add(
        row,
        'p',
        `${buying ? 'Delivering to' : 'Post to'}: ${[address.name, address.line1, address.line2, address.city, address.postcode].filter(Boolean).join(', ')}`,
      );
    const actions = add(row, 'div', '', 'order-actions');
    const live = order.status !== 'awaiting_payment' || Date.parse(order.expires_at) > Date.now();
    if (buying && order.status === 'awaiting_payment' && live) {
      button(
        actions,
        `Pay ${money(order.total_pence)}`,
        async () => {
          const data = await api<{ checkout_url: string }>(`/api/orders/${order.id}/pay`, {
            method: 'POST',
            body: '{}',
          });
          location.assign(data.checkout_url);
        },
        true,
      );
      button(actions, 'Cancel', act(order, 'cancel'));
    }
    if (!buying && order.status === 'paid') {
      const input = add(actions, 'input');
      input.placeholder = 'Carrier and tracking number';
      input.maxLength = 100;
      input.setAttribute('aria-label', 'Carrier and tracking number');
      button(
        actions,
        'Mark as posted',
        async () => {
          if (input.value.trim().length < 6) {
            status('Enter the carrier and tracking number. Tracked postage is required.');
            return;
          }
          await act(order, 'dispatch', input.value.trim())();
        },
        true,
      );
    }
    if (buying && order.status === 'dispatched')
      button(actions, 'I have received it', act(order, 'confirm_delivery'), true);
    if (buying && order.status === 'delivered')
      button(actions, 'All good — pay the seller now', act(order, 'accept'), true);
    if (buying && ['dispatched', 'delivered'].includes(order.status)) {
      const input = add(actions, 'input');
      input.placeholder = 'Describe the problem';
      input.maxLength = 2000;
      input.hidden = true;
      input.setAttribute('aria-label', 'Describe the problem');
      button(actions, 'Report a problem', async () => {
        if (input.hidden) {
          input.hidden = false;
          input.focus();
          status('Describe the problem, then press Report a problem again. This pauses payment to the seller.');
          return;
        }
        if (!input.value.trim()) {
          status('Describe the problem first.');
          return;
        }
        await act(order, 'report_issue', input.value.trim())();
      });
    }
    // Settling a reported problem. Card disputes and stopped payouts are support-only; the server refuses these there.
    if (order.status === 'disputed' && order.funds === 'held' && order.return_escalated_at !== undefined) {
      const decided = Boolean(order.return_escalated_at);
      if (buying) {
        if (order.return_by && !order.return_posted_at)
          prompted(actions, order, 'return_posted', 'I have posted it back', 'Carrier and tracking number', 6, true);
        if (!order.return_posted_at)
          button(actions, 'Withdraw the problem and pay the seller', async () => {
            if (confirm('Withdraw the problem? The seller will be paid and this cannot be undone.'))
              await act(order, 'withdraw')();
          });
      } else {
        button(
          actions,
          order.return_posted_at ? 'Item received back: refund the buyer' : 'Refund the buyer',
          async () => {
            if (confirm(`Refund ${money(order.total_pence)} to the buyer? This cannot be undone.`))
              await act(order, 'refund')();
          },
          Boolean(order.return_posted_at),
        );
        if (!order.return_by && !decided)
          prompted(
            actions,
            order,
            'request_return',
            'Ask for the item back',
            'Name and full address to send it back to',
            10,
          );
      }
      if (!decided)
        prompted(actions, order, 'escalate', 'Ask Relofted to decide', 'What do you need Relofted to decide?', 1);
    }
    if (canReview) {
      const rating = add(actions, 'select');
      rating.setAttribute('aria-label', 'Rating');
      for (const [value, label] of [
        ['5', '5 - Excellent'],
        ['4', '4 - Good'],
        ['3', '3 - OK'],
        ['2', '2 - Poor'],
        ['1', '1 - Bad'],
      ]) {
        const option = add(rating, 'option', label);
        option.value = value;
      }
      const comment = add(actions, 'input');
      comment.placeholder = buying ? 'How was the seller? (optional)' : 'How was the buyer? (optional)';
      comment.maxLength = 500;
      comment.setAttribute('aria-label', 'Review comment');
      button(actions, 'Leave review', async () => {
        await api(`/api/orders/${order.id}/review`, {
          method: 'POST',
          body: JSON.stringify({ rating: Number(rating.value), comment: comment.value.trim() }),
        });
        status('Thank you. Your review has been posted.');
        await load();
      });
    }
    if (!actions.childElementCount) actions.remove();
  }

  async function load() {
    const gen = generation;
    const data = await api<{
      orders: Order[];
      addresses: Address[];
      payouts: { started: boolean; enabled: boolean };
      reviewsEnabled?: boolean;
      reviewed?: string[];
    }>('/api/orders');
    if (gen !== generation) return;
    const purchases = el('orders-purchases'),
      sales = el('orders-sales'),
      payouts = el('orders-payouts');
    purchases.replaceChildren();
    sales.replaceChildren();
    payouts.replaceChildren();
    const addressByOrder = new Map(data.addresses.map(address => [address.order_id, address]));
    const selling = data.orders.filter(order => order.seller_id === user());
    if (data.payouts.enabled)
      add(payouts, 'p', 'Payouts are set up. Sale proceeds are sent to your bank account after each order completes.');
    else {
      add(
        payouts,
        'p',
        selling.length
          ? 'Set up payouts to receive the money from your sales. Your payments are held safely until you do.'
          : 'Selling? Set up payouts so you can be paid when an order completes.',
      );
      button(
        payouts,
        data.payouts.started ? 'Continue payout setup' : 'Set up payouts',
        async () => {
          const link = await api<{ url: string }>('/api/payouts/onboard', { method: 'POST', body: '{}' });
          location.assign(link.url);
        },
        selling.length > 0,
      );
    }
    const reviewed = new Set(data.reviewed || []);
    for (const order of data.orders)
      renderOrder(
        order.buyer_id === user() ? purchases : sales,
        order,
        addressByOrder.get(order.id),
        data.payouts.enabled,
        Boolean(data.reviewsEnabled) && order.status === 'completed' && !reviewed.has(order.id),
      );
    if (!purchases.childElementCount) purchases.textContent = 'No purchases yet.';
    if (!sales.childElementCount) sales.textContent = 'No sales yet.';
  }
  function open(note = '') {
    if (!user()) {
      signIn();
      return;
    }
    dialog.showModal();
    status(note);
    void run(load);
  }
  el('orders-button').onclick = () => open();
  el('orders-refresh').onclick = () =>
    void run(async () => {
      status('');
      await load();
    });

  return {
    configure(paymentsEnabled: boolean) {
      enabled = paymentsEnabled;
      el('orders-button').hidden = !enabled;
    },
    get enabled() {
      return enabled;
    },
    open,
    clear() {
      generation++;
      requests.clear();
      dialog.close();
      for (const id of ['orders-purchases', 'orders-sales', 'orders-payouts']) el(id).replaceChildren();
      status('');
    },
    quote: (listing: string) =>
      api<{ quote: Quote }>('/api/orders/quote', {
        method: 'POST',
        body: JSON.stringify({ listing_id: listing }),
      }).then(data => data.quote),
    /** Reserves the item and sends the buyer to the payment page. */
    async buy(listing: string) {
      const request = requests.get(listing) || crypto.randomUUID();
      requests.set(listing, request);
      const data = await api<{ order: Order; checkout_url?: string }>('/api/orders', {
        method: 'POST',
        body: JSON.stringify({ listing_id: listing, request_id: request }),
      });
      requests.delete(listing);
      if (data.checkout_url) location.assign(data.checkout_url);
      else open();
    },
    /** Handles the return from the payment or payout-setup pages. Returns true if it opened the dialog. */
    handleReturn(params: URLSearchParams) {
      if (!enabled || !user()) return false;
      if (params.has('order')) {
        open(
          params.has('cancelled')
            ? 'Payment was not completed. Your item is still reserved for a short time: pay or cancel below.'
            : 'Thank you. Your payment is being confirmed; press Refresh if the order still shows as not yet paid.',
        );
        return true;
      }
      if (params.has('payouts')) {
        open(
          params.get('payouts') === 'done'
            ? 'Payout details received. Verification can take a few minutes.'
            : 'Payout setup was not finished. Continue below.',
        );
        return true;
      }
      return false;
    },
  };
}
