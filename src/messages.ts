type Thread = { id: string; listing_id: string; buyer_id: string; seller_id: string; listing_title: string };
type Message = { id: number; sender_id: string; body: string; created_at: string };
type History = { conversation: Thread; messages: Message[]; hasMore: boolean; blocked: boolean; blockedByMe: boolean };
type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
export function setupMessages(api: Api, userId: () => string | undefined, signIn: () => void) {
  const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = el<HTMLDialogElement>('messages-dialog');
  let active: Thread | null = null,
    history: History | null = null,
    rows: Message[] = [],
    page = 1,
    generation = 0,
    busy = false;
  let pending: { body: string; client_id: string } | null = null;
  const status = (value: string) => {
    el('messages-status').textContent = value;
  };
  const fail = (e: unknown) => status(e instanceof Error ? e.message : 'Please try again.');
  function clear() {
    generation++;
    active = null;
    history = null;
    rows = [];
    pending = null;
    el('message-history').replaceChildren();
    el('conversation-list').replaceChildren();
    el<HTMLFormElement>('message-form').reset();
    el<HTMLFormElement>('report-form').reset();
    el('thread-panel').hidden = true;
    el('report-form').hidden = true;
    status('');
  }
  function render() {
    el('thread-title').textContent = active?.listing_title || 'Conversation';
    const list = el('message-history');
    list.replaceChildren();
    for (const item of rows) {
      const row = document.createElement('li');
      row.className = item.sender_id === userId() ? 'message-own' : '';
      const label = document.createElement('small');
      label.textContent = `${item.sender_id === userId() ? 'You' : 'Other golfer'} · ${new Date(item.created_at).toLocaleString()}`;
      const body = document.createElement('p');
      body.textContent = item.body;
      row.append(label, body);
      list.append(row);
    }
    el('messages-empty').hidden = rows.length > 0;
    el('older-messages').hidden = !history?.hasMore;
    el<HTMLButtonElement>('block-user').textContent = history?.blockedByMe ? 'Unblock golfer' : 'Block golfer';
    el('block-status').textContent = history?.blocked
      ? 'Messaging is blocked. Existing messages remain available for reference and reporting.'
      : '';
    el<HTMLButtonElement>('send-message').disabled = busy || !!history?.blocked;
    el<HTMLTextAreaElement>('message-body').disabled = !!history?.blocked;
  }
  async function loadThread(thread: Thread, older = false) {
    const request = ++generation;
    active = thread;
    el('thread-panel').hidden = false;
    if (!older) {
      rows = [];
      history = null;
      render();
    }
    status('Loading messages…');
    const before = older && rows.length ? `?before=${rows[0].id}` : '';
    const result = await api<History>(`/api/conversations/${thread.id}/messages${before}`);
    if (request !== generation || !userId() || !dialog.open) return;
    history = result;
    rows = older ? [...result.messages, ...rows] : result.messages;
    render();
    status('');
  }
  async function loadInbox() {
    const request = ++generation;
    status('Loading conversations…');
    const result = await api<{ conversations: Thread[]; total: number }>(`/api/conversations?page=${page}`);
    if (request !== generation || !userId() || !dialog.open) return;
    const list = el('conversation-list');
    list.replaceChildren();
    for (const thread of result.conversations) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button button-light';
      button.textContent = `${thread.listing_title} · ${thread.buyer_id === userId() ? 'Buying' : 'Selling'}`;
      button.addEventListener('click', () => {
        pending = null;
        el<HTMLFormElement>('message-form').reset();
        el('report-form').hidden = true;
        void loadThread(thread).catch(fail);
      });
      list.append(button);
    }
    el<HTMLButtonElement>('previous-conversations').disabled = page <= 1;
    el<HTMLButtonElement>('next-conversations').disabled = page * 20 >= result.total;
    el('conversation-page').textContent = `Page ${page}`;
    status(result.conversations.length ? '' : 'No conversations yet. Open a club and choose Message seller.');
  }
  el('messages-button').addEventListener('click', () => {
    if (!userId()) {
      signIn();
      return;
    }
    clear();
    page = 1;
    dialog.showModal();
    void loadInbox().catch(fail);
  });
  for (const [id, direction] of [
    ['previous-conversations', -1],
    ['next-conversations', 1],
  ] as const)
    el(id).addEventListener('click', () => {
      page += direction;
      void loadInbox().catch(fail);
    });
  el('refresh-messages').addEventListener('click', () => {
    void (active ? loadThread(active) : loadInbox()).catch(fail);
  });
  el('older-messages').addEventListener('click', () => {
    if (active) void loadThread(active, true).catch(fail);
  });
  el('message-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!active || busy) return;
    const thread = active;
    const body = el<HTMLTextAreaElement>('message-body').value.trim();
    if (!body) return;
    if (!pending || pending.body !== body) pending = { body, client_id: crypto.randomUUID() };
    busy = true;
    render();
    status('Sending…');
    try {
      await api(`/api/conversations/${thread.id}/messages`, { method: 'POST', body: JSON.stringify(pending) });
      if (active?.id !== thread.id || !userId()) return;
      pending = null;
      el<HTMLFormElement>('message-form').reset();
      await loadThread(thread);
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
      if (active) render();
    }
  });
  el('block-user').addEventListener('click', async () => {
    if (!active || !history) return;
    const button = el<HTMLButtonElement>('block-user');
    button.disabled = true;
    try {
      await api(`/api/conversations/${active.id}/block`, {
        method: history.blockedByMe ? 'DELETE' : 'PUT',
        body: '{}',
      });
      await loadThread(active);
    } catch (e) {
      fail(e);
    } finally {
      button.disabled = false;
    }
  });
  el('report-user').addEventListener('click', () => {
    el('report-form').hidden = !el('report-form').hidden;
  });
  el('report-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!active) return;
    const button = el<HTMLButtonElement>('submit-report');
    button.disabled = true;
    try {
      await api(`/api/conversations/${active.id}/report`, {
        method: 'POST',
        body: JSON.stringify({
          reason: el<HTMLSelectElement>('report-reason').value,
          details: el<HTMLTextAreaElement>('report-details').value.trim(),
        }),
      });
      el<HTMLFormElement>('report-form').reset();
      el('report-form').hidden = true;
      status('Report saved for review. You can also block this golfer to stop further messages.');
    } catch (e) {
      fail(e);
    } finally {
      button.disabled = false;
    }
  });
  dialog.addEventListener('close', clear);
  return {
    clear: () => {
      dialog.close();
      clear();
    },
    start: async (listing: string) => {
      if (!userId()) {
        signIn();
        return;
      }
      clear();
      dialog.showModal();
      status('Opening conversation…');
      try {
        const request = generation;
        const result = await api<{ conversation: Thread }>('/api/conversations', {
          method: 'POST',
          body: JSON.stringify({ listing_id: listing }),
        });
        if (request !== generation || !userId() || !dialog.open) return;
        await loadInbox();
        await loadThread(result.conversation);
      } catch (e) {
        fail(e);
      }
    },
  };
}
