type Order = {
  id: string;
  title: string;
  buyer_id: string;
  seller_id: string;
  total_pence: number;
  item_pence: number;
  delivery_pence: number;
  status: string;
  funds: string;
  issue: string | null;
  tracking: string | null;
  created_at: string;
  updated_at: string;
};
type Report = {
  id: string;
  conversation_id: string;
  reporter_id: string;
  reason: string;
  details: string;
  status: string;
  created_at: string;
};
type Overview = {
  orders: Order[];
  reports: Report[];
  profiles: { id: string; display_name: string; suspended_at?: string | null; deleted_at?: string | null }[];
  settings: { checkout_enabled: boolean } | null;
};
type Detail = {
  order: Record<string, unknown>;
  events: {
    action: string;
    actor_id: string | null;
    status: string;
    funds: string;
    note: string | null;
    created_at: string;
  }[];
  address: { name: string; line1: string; line2: string | null; city: string; postcode: string } | null;
  messages: { sender_id: string; body: string; created_at: string }[];
};
type Api = <T>(path: string, options?: RequestInit) => Promise<T>;

/** Support screen for administrators: decide disputes, review reports, take down listings, pause checkout. */
export function setupAdmin(api: Api, user: () => string | undefined) {
  const el = (id: string) => document.getElementById(id)!;
  const dialog = el('support-dialog') as HTMLDialogElement;
  const status = (text: string) => {
    el('support-status').textContent = text;
  };
  const money = (pence: number) =>
    new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(pence / 100);
  const when = (iso: string) =>
    new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(
      new Date(iso),
    );
  let admin = false,
    busy = false,
    generation = 0;
  let names = new Map<string, string>();
  let suspended = new Set<string>();
  const name = (id: string | null) => (id ? `${names.get(id) || 'Member'} (${id.slice(0, 8)})` : 'Relofted system');

  function add<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, text = '', className = '') {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    parent.append(node);
    return node;
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    const gen = generation;
    try {
      await action();
    } catch (error) {
      if (gen === generation) status(error instanceof Error ? error.message : 'Please try again.');
    } finally {
      busy = false;
    }
  }
  function button(parent: HTMLElement, text: string, action: () => Promise<void>, dark = false) {
    const node = add(parent, 'button', text, `button ${dark ? 'button-dark' : 'button-outline'}`);
    node.type = 'button';
    node.onclick = () => void run(action);
  }
  /** Every support action needs a reason; it is stored in the audit trail. */
  function reason(question: string) {
    const answer = window.prompt(`${question}\n\nReason (recorded in the audit trail):`)?.trim();
    if (!answer) return null;
    if (answer.length < 3) {
      status('Give a short reason for the record.');
      return null;
    }
    return answer;
  }
  const post = (path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body) });

  async function showDetail(row: HTMLElement, order: Order) {
    row.querySelector('.support-detail')?.remove();
    const data = await api<Detail>(`/api/admin/orders/${order.id}`);
    const box = add(row, 'div', '', 'support-detail');
    add(box, 'p', `Order ${order.id}`);
    if (data.address)
      add(
        box,
        'p',
        `Deliver to: ${[data.address.name, data.address.line1, data.address.line2, data.address.city, data.address.postcode].filter(Boolean).join(', ')}`,
      );
    const members = add(box, 'div', '', 'order-actions');
    for (const [role, id] of [
      ['buyer', order.buyer_id],
      ['seller', order.seller_id],
    ] as const) {
      const isSuspended = suspended.has(id);
      button(members, `${isSuspended ? 'Restore' : 'Suspend'} ${role}`, async () => {
        const note = reason(
          isSuspended
            ? `Let the ${role} use Relofted again?`
            : `Suspend the ${role}? They will not be able to list, buy or message, and their listings come off sale. Orders already under way continue.`,
        );
        if (!note) return;
        await post(`/api/admin/users/${id}/suspend`, { suspended: !isSuspended, note });
        status(isSuspended ? 'Member restored.' : 'Member suspended.');
        await load();
      });
    }
    add(box, 'h5', 'History');
    for (const event of data.events)
      add(
        box,
        'p',
        `${when(event.created_at)} — ${event.action} by ${name(event.actor_id)} → ${event.status}, money ${event.funds}${event.note ? ` — ${event.note}` : ''}`,
      );
    add(box, 'h5', 'Messages between buyer and seller');
    if (!data.messages.length) add(box, 'p', 'No messages about this listing.');
    for (const message of data.messages)
      add(
        box,
        'p',
        `${when(message.created_at)} — ${message.sender_id === order.buyer_id ? 'Buyer' : 'Seller'}: ${message.body}`,
      );
  }
  function renderOrder(parent: HTMLElement, order: Order) {
    const row = add(parent, 'section', '', 'order-row');
    add(row, 'h4', order.title);
    add(
      row,
      'p',
      `${order.status}, money ${order.funds} — buyer ${name(order.buyer_id)} paid ${money(order.total_pence)}; seller ${name(order.seller_id)} is due ${money(order.item_pence + order.delivery_pence)}. Updated ${when(order.updated_at)}.`,
    );
    if (order.issue) add(row, 'p', `Reported problem: ${order.issue}`);
    if (order.tracking) add(row, 'p', `Tracking: ${order.tracking}`, 'order-amounts');
    const actions = add(row, 'div', '', 'order-actions');
    button(actions, 'View details', () => showDetail(row, order));
    const decide = (decision: 'release' | 'refund', question: string) => async () => {
      const note = reason(question);
      if (!note) return;
      await post(`/api/admin/orders/${order.id}/resolve`, { decision, note });
      status(decision === 'release' ? 'Released to the seller.' : 'Refund started for the buyer.');
      await load();
    };
    if (order.status === 'disputed' && order.funds === 'held')
      button(
        actions,
        'Release to seller',
        decide('release', `Pay ${money(order.item_pence + order.delivery_pence)} to the seller for "${order.title}"?`),
        true,
      );
    if (['held', 'release_due', 'released'].includes(order.funds)) {
      button(
        actions,
        'Refund buyer',
        decide(
          'refund',
          `Refund ${money(order.total_pence)} to the buyer for "${order.title}"?${order.funds === 'released' ? ' The seller has been paid, so their payout will be taken back first.' : ''}`,
        ),
      );
    }
  }
  async function load() {
    const gen = generation;
    const data = await api<Overview>('/api/admin/overview');
    if (gen !== generation) return;
    names = new Map(
      data.profiles.map(profile => [
        profile.id,
        profile.display_name + (profile.deleted_at ? ' — deleted' : profile.suspended_at ? ' — SUSPENDED' : ''),
      ]),
    );
    suspended = new Set(data.profiles.filter(profile => profile.suspended_at).map(profile => profile.id));
    const attention = el('support-attention'),
      all = el('support-orders'),
      reports = el('support-reports'),
      checkout = el('support-checkout');
    for (const node of [attention, all, reports, checkout]) node.replaceChildren();
    if (data.settings) {
      const open = data.settings.checkout_enabled;
      add(
        checkout,
        'p',
        open
          ? 'Buying is ON. New purchases are accepted.'
          : 'Buying is OFF. Existing orders, refunds and payouts continue.',
      );
      button(
        checkout,
        open ? 'Pause all new purchases' : 'Turn buying back on',
        async () => {
          const note = reason(open ? 'Pause all new purchases across Relofted?' : 'Allow new purchases again?');
          if (!note) return;
          await post('/api/admin/checkout', { enabled: !open, note });
          await load();
        },
        !open,
      );
    } else add(checkout, 'p', 'The checkout switch appears after the latest database update is applied.');
    const needsDecision = (order: Order) => order.status === 'disputed' || order.funds === 'reversal_due';
    for (const order of data.orders) renderOrder(needsDecision(order) ? attention : all, order);
    if (!attention.childElementCount) attention.textContent = 'Nothing is waiting for a decision.';
    if (!all.childElementCount) all.textContent = 'No other orders yet.';
    for (const report of data.reports) {
      const row = add(reports, 'section', '', 'order-row');
      add(row, 'h4', `${report.reason} — ${report.status}`);
      add(row, 'p', `${when(report.created_at)} from ${name(report.reporter_id)}: ${report.details}`);
      const actions = add(row, 'div', '', 'order-actions');
      for (const [label, next] of [
        ['Mark reviewed', 'reviewed'],
        ['Resolve', 'resolved'],
      ] as const) {
        if (report.status === next) continue;
        button(actions, label, async () => {
          const note = reason(`${label} this report?`);
          if (!note) return;
          await post(`/api/admin/reports/${report.id}`, { status: next, note });
          await load();
        });
      }
    }
    if (!reports.childElementCount) reports.textContent = 'No open reports.';
  }
  el('support-button').onclick = () => {
    dialog.showModal();
    status('');
    void run(load);
  };
  el('support-refresh').onclick = () =>
    void run(async () => {
      status('');
      await load();
    });

  return {
    get isAdmin() {
      return admin;
    },
    /** Call after sign-in or sign-out. The server decides; this only controls what is shown. */
    async refresh() {
      const gen = ++generation;
      admin = false;
      el('support-button').hidden = true;
      if (!user()) return;
      try {
        const role = await api<{ admin: boolean }>('/api/me/role');
        if (gen === generation) admin = role.admin;
      } catch {
        /* support routes are not enabled on this server */
      }
      el('support-button').hidden = !admin;
    },
    clear() {
      generation++;
      admin = false;
      el('support-button').hidden = true;
      dialog.close();
      for (const id of ['support-attention', 'support-orders', 'support-reports', 'support-checkout'])
        el(id).replaceChildren();
    },
    async takedown(listing: string, title: string) {
      const note = reason(`Take "${title}" off sale?`);
      if (!note) return false;
      await post(`/api/admin/listings/${listing}/takedown`, { note });
      return true;
    },
  };
}
