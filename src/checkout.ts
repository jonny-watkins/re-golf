type Item = { id: string; seller_id: string; title: string; price_pence: number; status: string; reserved_until: string | null };
type Order = { id: string; buyer_id: string; seller_id: string; title: string; item_pence: number; fee_pence: number; delivery_pence: number; total_pence: number; status: string; expires_at: string };
type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
export function setupCheckout(api: Api, user: () => string | undefined, signIn: () => void) {
  const el = (id: string) => document.getElementById(id)!;
  const dialog = el('checkout-test-dialog') as HTMLDialogElement;
  const money = (n: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n / 100);
  let generation = 0;
  let busy = false;
  const requests = new Map<string, string>();
  function button(parent: HTMLElement, text: string, action: () => Promise<void>) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'button button-outline'; b.textContent = text;
    b.disabled = busy;
    b.onclick = () => void run(action); parent.append(b);
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    dialog.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = true);
    const gen = generation;
    el('test-checkout-status').textContent = '';
    try { await action(); if (gen === generation) await load(); }
    catch (e) { if (gen === generation) el('test-checkout-status').textContent = e instanceof Error ? e.message : 'Please retry.'; }
    finally { busy = false; dialog.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = false); }
  }
  async function post(body: unknown) {
    const data = await api<{ result: Order }>('/api/test-checkout', { method: 'POST', body: JSON.stringify(body) });
    if (data.result.status === 'expired') el('test-checkout-status').textContent = 'Reservation expired. No test payment was accepted.';
  }
  async function load() {
    const gen = generation;
    const data = await api<{ listings: Item[]; orders: Order[] }>('/api/test-checkout');
    if (gen !== generation) return;
    el('test-inventory').replaceChildren(); el('test-orders').replaceChildren();
    for (const item of data.listings) {
      const row = document.createElement('section'); row.className = 'field';
      const available = item.status === 'active' || (item.status === 'reserved' && Date.parse(item.reserved_until!) <= Date.now());
      const p = document.createElement('p'); p.textContent = `${item.title} — ${money(item.price_pence)} — ${available ? 'available' : item.status}${item.seller_id === user() ? ' (your item)' : ''}`; row.append(p);
      if (available && item.seller_id !== user()) button(row, 'Review test checkout', async () => {
        const request = requests.get(item.id) || crypto.randomUUID(); requests.set(item.id, request);
        await post({ action: 'reserve', listing_id: item.id, request_id: request }); requests.delete(item.id);
      });
      el('test-inventory').append(row);
    }
    for (const order of data.orders) {
      const row = document.createElement('section'); row.className = 'field';
      const expired = order.status === 'reserved' && Date.parse(order.expires_at) <= Date.now();
      const p = document.createElement('p');
      p.textContent = `${order.title} — ${order.buyer_id === user() ? 'Purchase' : 'Sale'} — ${expired ? 'expired' : order.status}. Item ${money(order.item_pence)} + test fee ${money(order.fee_pence)} + test delivery ${money(order.delivery_pence)} = ${money(order.total_pence)}. Seller amount: ${money(order.item_pence)}.`;
      row.append(p);
      const action = (value: string) => async () => post({ action: value, order_id: order.id });
      if (order.buyer_id === user() && order.status === 'reserved' && !expired) {
        button(row, 'Simulate successful payment', action('pay'));
        button(row, 'Simulate failed payment', action('fail'));
        button(row, 'Cancel test checkout', action('cancel'));
      }
      if (order.seller_id === user() && order.status === 'paid') button(row, 'Simulate dispatch', action('dispatch'));
      if (order.buyer_id === user() && order.status === 'dispatched') button(row, 'Simulate delivery', action('deliver'));
      el('test-orders').append(row);
    }
    if (!data.orders.length) el('test-orders').textContent = 'No test orders yet.';
    if (!data.listings.length) el('test-inventory').textContent = 'Create a test item, then use a second account to buy it.';
  }
  el('checkout-test-button').onclick = () => {
    if (!user()) { signIn(); return; }
    dialog.showModal(); void run(load);
  };
  el('test-checkout-refresh').onclick = () => void run(load);
  el('test-item-form').onsubmit = event => {
    event.preventDefault();
    void run(() => post({ action: 'create', title: (el('test-item-title') as HTMLInputElement).value,
      price_pence: Math.round(Number((el('test-item-price') as HTMLInputElement).value) * 100) }));
  };
  return { clear() { generation++; requests.clear(); dialog.close(); el('test-inventory').replaceChildren(); el('test-orders').replaceChildren(); el('test-checkout-status').textContent = ''; } };
}
