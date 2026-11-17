import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';
import { categories, maxPhotos, maxPhotoBytes, type ListingPhoto, type Listing, type ListingInput } from '../shared/listings';
import { artSvg } from './art';
import { sampleListings } from './samples';
import { setupMessages } from './messages';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
}
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const pounds = (pence: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(pence / 100);
const artMap: Record<string, string> = { Drivers: 'driver', Irons: 'iron', Putters: 'putter', Wedges: 'wedge', Woods: 'wood', 'Bags & gear': 'bag' };
type Card = Listing & { sample?: boolean };
const examples: Card[] = sampleListings.map(item => ({
  id: `example-${item.id}`, seller_id: '', name: item.name, brand: item.brand, category: item.category as Listing['category'],
  condition: item.condition as Listing['condition'], price_pence: Math.round(item.price * 100), location: item.location,
  description: 'This is an example listing to preview Re-Golf. It is not for sale.', status: 'active', created_at: '', updated_at: '', sample: true,
  handedness: null, shaft_flex: null, loft: null,
}));
let auth: SupabaseClient | null = null;
let session: Session | null = null;
let configured = false;
let photosEnabled = false;
let existingPhotos: ListingPhoto[] = [];
let pendingPhotos: { file: File; url: string }[] = [];
let savingListing = false;
let changingPhotos = false;
const photoUrls = new Map<string, string>();
let photoGeneration = 0;
let view: 'browse' | 'mine' | 'examples' = 'browse';
let current: Card | null = null;
let editingId: string | null = null;
let cards: Card[] = [];
let page = 1;
let total = 0;
let activeCategory = '';
let requestNumber = 0;
let savedOnly = false;
const saved = new Set<string>();
let authMode: 'signin' | 'signup' | 'reset' | 'update' = 'signin';
const sellDialog = el<HTMLDialogElement>('sell-dialog');
const listingDialog = el<HTMLDialogElement>('listing-dialog');
const authDialog = el<HTMLDialogElement>('auth-dialog');
const sellForm = el<HTMLFormElement>('sell-form');
const authForm = el<HTMLFormElement>('auth-form');
const inbox = setupMessages(api, () => session?.user.id, () => openAuth());

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  // Ask the auth SDK for the current refreshed session before every protected request.
  if (auth) {
    const { data, error } = await auth.auth.getSession();
    if (error) throw error;
    if (data.session) headers.set('Authorization', `Bearer ${data.session.access_token}`);
  }
  const response = await fetch(path, { ...options, headers });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data as T;
}
function message(id: string, text: string) { el(id).textContent = text; el(id).classList.toggle('visible', Boolean(text)); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Please try again.'; }
function sortedPhotos(item: Card) { return [...(item.listing_photos || [])].sort((a, b) => a.position - b.position); }
function photoImage(id: string, alt: string) { return `<img data-photo="${escapeHtml(id)}" alt="${escapeHtml(alt)}" loading="lazy">`; }
async function hydratePhotos(root: HTMLElement) {
  const generation = photoGeneration;
  await Promise.all([...root.querySelectorAll<HTMLImageElement>('img[data-photo]')].map(async img => {
    const id = img.dataset.photo!;
    try {
      let url = photoUrls.get(id);
      if (!url) {
        const headers: Record<string, string> = {};
        const token = auth ? (await auth.auth.getSession()).data.session?.access_token : null;
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await fetch(`/api/photos/${encodeURIComponent(id)}`, { headers });
        if (!response.ok) throw new Error('Photo unavailable');
        const blob = await response.blob();
        if (generation !== photoGeneration) return;
        url = photoUrls.get(id);
        if (!url) { url = URL.createObjectURL(blob); photoUrls.set(id, url); }
      }
      if (img.isConnected) img.src = url;
    } catch { if (img.isConnected) img.alt = 'Photo unavailable. Refresh to retry.'; }
  }));
}
function clearPhotoCache() { photoGeneration++; for (const url of photoUrls.values()) URL.revokeObjectURL(url); photoUrls.clear(); }
function renderPhotoEditor() {
  const grid = el('photo-editor'); grid.replaceChildren();
  existingPhotos.sort((a, b) => a.position - b.position);
  const entries = [...existingPhotos.map(photo => ({ id: photo.id, url: '', pending: false })), ...pendingPhotos.map((photo, index) => ({ id: String(index), url: photo.url, pending: true }))];
  entries.forEach((photo, index) => {
    const tile = document.createElement('div'); tile.className = 'photo-tile';
    const img = document.createElement('img'); img.alt = `Listing photo ${index + 1}`;
    if (photo.pending) img.src = photo.url; else img.dataset.photo = photo.id;
    tile.append(img);
    const label = document.createElement('span'); label.textContent = `${index === 0 ? 'Main photo' : `Photo ${index + 1}`}${photo.pending ? ' · not uploaded' : ''}`; tile.append(label);
    for (const [action, title] of [['main', 'Make main'], ['remove', 'Remove']] as const) {
      // Pending images can be reordered before first save. Existing images change immediately.
      if (action === 'main' && (index === 0 || (photo.pending && existingPhotos.length > 0))) continue;
      const button = document.createElement('button'); button.type = 'button'; button.textContent = title;
      button.setAttribute('aria-label', `${title} photo ${index + 1}`);
      button.disabled = savingListing || changingPhotos;
      button.addEventListener('click', () => void changePhoto(photo.id, photo.pending, action)); tile.append(button);
    }
    grid.append(tile);
  });
  const input = el<HTMLInputElement>('club-photos');
  input.disabled = !photosEnabled || savingListing || changingPhotos || entries.length >= maxPhotos;
  el('photo-status').textContent = photosEnabled ? `${entries.length} of ${maxPhotos} photos. ${existingPhotos.length && pendingPhotos.length ? 'Save new photos, then choose one as the main photo.' : ''}` : 'Photo uploads are awaiting setup. You can still save listing details.';
  void hydratePhotos(grid);
}
async function changePhoto(id: string, pending: boolean, action: 'main' | 'remove') {
  if (savingListing || changingPhotos) return;
  if (pending) {
    const [photo] = pendingPhotos.splice(Number(id), 1);
    if (action === 'main') pendingPhotos.unshift(photo); else URL.revokeObjectURL(photo.url);
    renderPhotoEditor(); return;
  }
  if (!editingId) return;
  changingPhotos = true; renderPhotoEditor();
  sellForm.querySelector<HTMLButtonElement>('[type=submit]')!.disabled = true;
  try {
    await api(`/api/listings/${editingId}/photos/${id}/${action}`, { method: 'POST', body: '{}' });
    if (action === 'remove') existingPhotos = existingPhotos.filter(photo => photo.id !== id).map((photo, position) => ({ ...photo, position }));
    else {
      const first = existingPhotos[0]; const target = existingPhotos.find(photo => photo.id === id)!;
      [first.position, target.position] = [target.position, first.position];
    }
    const card = cards.find(item => item.id === editingId);
    if (card) card.listing_photos = [...existingPhotos];
    renderCards(); message('sell-message', action === 'main' ? 'Main photo updated.' : 'Photo removed.');
  } catch (error) { message('sell-message', errorMessage(error)); }
  finally { changingPhotos = false; sellForm.querySelector<HTMLButtonElement>('[type=submit]')!.disabled = false; renderPhotoEditor(); }
}
el('club-photos').addEventListener('change', () => {
  const input = el<HTMLInputElement>('club-photos');
  const files = [...(input.files || [])]; input.value = '';
  if (files.length + existingPhotos.length + pendingPhotos.length > maxPhotos) { message('sell-message', 'Choose no more than six photos in total.'); return; }
  if (files.some(file => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || !file.size || file.size > maxPhotoBytes)) {
    message('sell-message', 'Choose JPEG, PNG or WebP photos up to 8 MB each.'); return;
  }
  pendingPhotos.push(...files.map(file => ({ file, url: URL.createObjectURL(file) })));
  message('sell-message', ''); renderPhotoEditor();
});
function renderFilters() {
  el('filters').innerHTML = ['', ...categories].map(category => `<button class="chip${category === activeCategory ? ' active' : ''}" type="button" data-category="${escapeHtml(category)}" aria-pressed="${category === activeCategory}">${escapeHtml(category || 'All clubs')}</button>`).join('');
}
function renderCards() {
  const shown = cards;
  el('saved-filter').setAttribute('aria-pressed', String(savedOnly));
  el('result-count').textContent = `${total} ${view === 'examples' ? 'examples' : savedOnly ? 'saved clubs' : 'listings'}`;
  el('listing-grid').innerHTML = shown.length ? shown.map(item => `<article class="listing">
    <div class="listing-visual" style="--tone:#e5ebdb"><span class="condition-label">${escapeHtml(item.condition)}</span>
    <button class="icon-button save-button${saved.has(item.id) ? ' saved' : ''}" type="button" data-save="${item.id}" aria-label="${saved.has(item.id) ? 'Unsave club' : 'Save club'}" aria-pressed="${saved.has(item.id)}" ${item.sample ? 'disabled' : ''}>${saved.has(item.id) ? '♥' : '♡'}</button>${sortedPhotos(item)[0] ? photoImage(sortedPhotos(item)[0].id, `${item.brand} ${item.name}`) : artSvg(artMap[item.category])}</div>
    <div class="listing-info"><div class="listing-meta"><span class="category-label">${escapeHtml(item.category)}</span><span>${item.sample ? 'Example listing' : item.status === 'archived' ? 'Archived' : 'Seller listing'}</span></div>
    <h3>${escapeHtml(item.brand)} ${escapeHtml(item.name)}</h3><div class="listing-sub">${escapeHtml(item.location)} · ${escapeHtml(item.condition)}</div>
    <div class="listing-bottom"><div class="listing-price">${pounds(item.price_pence)}</div><button class="details-link" type="button" data-listing="${item.id}">View details →</button></div></div></article>`).join('') : '<div class="empty-state">No listings here yet. Try another search or list your first club.</div>';
  el('pagination').hidden = view === 'examples' || total <= 24;
  el<HTMLButtonElement>('previous-page').disabled = page <= 1;
  el<HTMLButtonElement>('next-page').disabled = page * 24 >= total;
  el('page-label').textContent = `Page ${page} of ${Math.max(1, Math.ceil(total / 24))}`;
  for (const [id, mode] of [['browse-listings', 'browse'], ['my-listings', 'mine'], ['example-listings', 'examples']]) {
    el(id).setAttribute('aria-pressed', String(view === mode));
  }
  void hydratePhotos(el('listing-grid'));
}
async function loadListings() {
  clearPhotoCache();
  const request = ++requestNumber;
  const query = el<HTMLInputElement>('search-input').value.trim();
  message('market-message', '');
  if (view === 'examples') {
    cards = examples.filter(item => (!activeCategory || item.category === activeCategory) && item.name.toLowerCase().includes(query.toLowerCase()));
    total = cards.length;
    message('market-message', 'Example listings only — these are not for sale and cannot be saved.');
    renderCards(); return;
  }
  if (!configured) {
    cards = []; total = 0; renderCards();
    message('market-message', 'The marketplace is not connected yet. You can view examples while setup is completed.'); return;
  }
  el('listing-grid').setAttribute('aria-busy', 'true');
  el('listing-grid').innerHTML = '<div class="empty-state">Loading listings…</div>';
  try {
    const params = new URLSearchParams({ page: String(page), q: query });
    if (activeCategory) params.set('category', activeCategory);
    const data = await api<{ listings: Listing[]; total: number }>(`${savedOnly ? '/api/me/favourites' : view === 'mine' ? '/api/me/listings' : '/api/listings'}?${params}`);
    const favourites = session && data.listings.length ? await api<{ ids: string[] }>('/api/me/favourites/status', { method: 'POST', body: JSON.stringify({ ids: data.listings.map(item => item.id) }) }) : { ids: [] };
    if (request !== requestNumber) return;
    saved.clear(); favourites.ids.forEach(id => saved.add(id));
    cards = data.listings; total = data.total; renderCards();
    if (view === 'mine') message('market-message', 'Your saved listings, including archived items. Buying is coming later.');
  } catch (error) {
    if (request !== requestNumber) return;
    cards = []; total = 0; renderCards(); message('market-message', errorMessage(error));
  } finally { if (request === requestNumber) el('listing-grid').removeAttribute('aria-busy'); }
}
function openListing(id: string) {
  current = cards.find(item => item.id === id) || null;
  if (!current) return;
  el('listing-dialog-title').textContent = `${current.brand} ${current.name}`;
  el('listing-dialog-subtitle').textContent = current.sample ? 'Example listing · not for sale' : `${current.category} · ${current.status}`;
  el('dialog-location').textContent = `Seller location: ${current.location}`;
  el('dialog-condition').textContent = current.condition;
  el('dialog-description').textContent = current.description;
  el('dialog-visual').style.setProperty('--tone', '#e5ebdb');
  const photos = sortedPhotos(current);
  el('dialog-visual').innerHTML = photos.length ? photoImage(photos[0].id, `${current.brand} ${current.name}`) : artSvg(artMap[current.category]);
  el('photo-gallery').innerHTML = photos.map((photo, index) => `<button type="button" data-gallery-photo="${photo.id}" aria-label="Show photo ${index + 1}" aria-pressed="${index === 0}">${photoImage(photo.id, `Photo ${index + 1}`)}</button>`).join('');
  el('dialog-specs').textContent = [current.handedness && `${current.handedness}-handed`, current.shaft_flex && `${current.shaft_flex} flex`, current.loft != null && `${current.loft}° loft`].filter(Boolean).join(' · ');
  el('price-breakdown').textContent = `Club price: ${pounds(current.price_pence)}`;
  el('owner-actions').hidden = current.sample || current.seller_id !== session?.user.id || current.status !== 'active';
  el('message-seller').hidden = !!current.sample || current.seller_id === session?.user.id || current.status !== 'active';
  message('listing-message', '');
  listingDialog.showModal();
  void hydratePhotos(listingDialog);
}
el('photo-gallery').addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-gallery-photo]');
  if (!button || !current) return;
  el('dialog-visual').innerHTML = photoImage(button.dataset.galleryPhoto!, `${current.brand} ${current.name}`);
  el('photo-gallery').querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  void hydratePhotos(el('dialog-visual'));
});
function openAuth(mode: typeof authMode = 'signin') {
  authMode = mode;
  authForm.reset();
  const signedIn = Boolean(session) && mode !== 'update';
  el('account-summary').hidden = !signedIn;
  authForm.hidden = signedIn || !configured;
  el('auth-links').hidden = signedIn || !configured || mode === 'update';
  el('account-email').textContent = session?.user.email || '';
  const headings = { signin: 'Sign in', signup: 'Create account', reset: 'Reset password', update: 'Choose a new password' };
  el('auth-title').textContent = signedIn ? 'Your account' : headings[mode];
  el('auth-intro').textContent = signedIn ? 'Manage your Re-Golf account.' : mode === 'signup' ? 'Create an account to list your clubs. Confirm your email before signing in.' : mode === 'reset' ? 'We’ll email you a password reset link.' : mode === 'update' ? 'Choose a password with at least 12 characters.' : 'Welcome back to Re-Golf.';
  el('display-name-field').hidden = mode !== 'signup';
  el<HTMLInputElement>('display-name').required = mode === 'signup';
  el('email-field').hidden = mode === 'update';
  el<HTMLInputElement>('auth-email').required = mode !== 'update';
  el('password-field').hidden = mode === 'reset';
  const password = el<HTMLInputElement>('auth-password');
  password.required = mode !== 'reset';
  password.minLength = mode === 'signup' || mode === 'update' ? 12 : 1;
  password.autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
  el('auth-submit').textContent = mode === 'reset' ? 'Send reset link' : mode === 'update' ? 'Save password' : headings[mode];
  message('auth-message', configured ? '' : 'Accounts are not available yet. The marketplace needs to be connected first.');
  if (!authDialog.open) authDialog.showModal();
}
function openSell(item?: Card) {
  if (!session || !configured) { openAuth(); return; }
  editingId = item?.id || null;
  pendingPhotos.forEach(photo => URL.revokeObjectURL(photo.url)); pendingPhotos = [];
  existingPhotos = item ? sortedPhotos(item).map(photo => ({ ...photo })) : [];
  sellForm.reset();
  el('sell-dialog-title').textContent = item ? 'Edit your listing' : 'List a club';
  if (item) for (const [name, value] of Object.entries({ name: item.name, brand: item.brand, category: item.category, condition: item.condition, price: (item.price_pence / 100).toFixed(2), location: item.location, description: item.description, handedness: item.handedness || '', shaft_flex: item.shaft_flex || '', loft: item.loft == null ? '' : String(item.loft) })) {
    (sellForm.elements.namedItem(name) as HTMLInputElement).value = value;
  }
  message('sell-message', '');
  renderPhotoEditor();
  sellDialog.showModal();
}

el('filters').addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-category]');
  if (!button) return;
  activeCategory = button.dataset.category || ''; page = 1; renderFilters(); void loadListings();
});
el('listing-grid').addEventListener('click', async event => {
  const target = event.target as HTMLElement;
  const save = target.closest<HTMLButtonElement>('[data-save]');
  if (save) {
    if (!session) { openAuth(); return; }
    const id = save.dataset.save!; save.disabled = true;
    try {
      await api(`/api/me/favourites/${id}`, { method: saved.has(id) ? 'DELETE' : 'PUT', body: '{}' });
      await loadListings();
    } catch (error) { message('market-message', errorMessage(error)); save.disabled = false; }
    return;
  }
  const details = target.closest<HTMLButtonElement>('[data-listing]');
  if (details) openListing(details.dataset.listing!);
});
for (const [id, mode] of [['browse-listings', 'browse'], ['my-listings', 'mine'], ['example-listings', 'examples']] as const) {
  el(id).addEventListener('click', () => {
    if (mode === 'mine' && !session) { openAuth(); return; }
    view = mode; page = 1; savedOnly = false; void loadListings();
  });
}
el('search-form').addEventListener('submit', event => { event.preventDefault(); page = 1; void loadListings(); el('market').scrollIntoView({ behavior: 'smooth' }); });
let searchTimer: ReturnType<typeof setTimeout>;
el('search-input').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { page = 1; void loadListings(); }, 300); });
el('previous-page').addEventListener('click', () => { page--; void loadListings(); });
el('next-page').addEventListener('click', () => { page++; void loadListings(); });
el('saved-filter').addEventListener('click', () => { if (!session) { openAuth(); return; } savedOnly = !savedOnly; view = 'browse'; page = 1; void loadListings(); el('market').scrollIntoView({ behavior: 'smooth' }); });
el('message-seller').addEventListener('click', () => { if (!current) return; const id = current.id; listingDialog.close(); void inbox.start(id); });
document.querySelectorAll('[data-open-sell]').forEach(button => button.addEventListener('click', () => openSell()));
document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => { if (button.closest('dialog') === sellDialog && (savingListing || changingPhotos)) return; button.closest('dialog')?.close(); }));
sellDialog.addEventListener('cancel', event => { if (savingListing || changingPhotos) event.preventDefault(); });
el('account-button').addEventListener('click', () => openAuth());
document.querySelectorAll<HTMLButtonElement>('[data-auth-mode]').forEach(button => button.addEventListener('click', () => openAuth(button.dataset.authMode as typeof authMode)));
el('edit-listing').addEventListener('click', () => { if (current) { listingDialog.close(); openSell(current); } });
el('archive-listing').addEventListener('click', async () => {
  if (!current || !window.confirm('Archive this listing? It will no longer appear in public browsing.')) return;
  const button = el<HTMLButtonElement>('archive-listing'); button.disabled = true;
  try { await api(`/api/listings/${current.id}/archive`, { method: 'POST', body: '{}' }); listingDialog.close(); await loadListings(); }
  catch (error) { message('listing-message', errorMessage(error)); }
  finally { button.disabled = false; }
});
sellForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (savingListing || changingPhotos) return;
  if (!sellForm.reportValidity()) return;
  const button = sellForm.querySelector<HTMLButtonElement>('[type=submit]')!; button.disabled = true;
  const data = new FormData(sellForm);
  const input: ListingInput = { name: String(data.get('name')).trim(), brand: String(data.get('brand')).trim(), category: data.get('category') as Listing['category'], condition: data.get('condition') as Listing['condition'], price_pence: Math.round(Number(data.get('price')) * 100), location: String(data.get('location')).trim(), description: String(data.get('description')).trim(), handedness: (data.get('handedness') || null) as Listing['handedness'], shaft_flex: (data.get('shaft_flex') || null) as Listing['shaft_flex'], loft: data.get('loft') ? Number(data.get('loft')) : null };
  savingListing = true; renderPhotoEditor();
  message('sell-message', 'Saving your listing…');
  try {
    const result = await api<{ listing: Listing }>(editingId ? `/api/listings/${editingId}` : '/api/listings', { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(input) });
    editingId = result.listing.id; // Retain the ID on partial upload failure; retry updates instead of duplicating the listing.
    existingPhotos = sortedPhotos(result.listing);
    while (pendingPhotos.length) {
      message('sell-message', `Listing details saved. Uploading photo ${existingPhotos.length + 1}…`);
      const photo = pendingPhotos[0];
      const uploaded = await api<{ photo: { id: string } }>(`/api/listings/${editingId}/photos`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: photo.file });
      const position = Array.from({ length: maxPhotos }, (_, i) => i).find(i => !existingPhotos.some(p => p.position === i))!;
      existingPhotos.push({ id: uploaded.photo.id, position });
      pendingPhotos.shift(); URL.revokeObjectURL(photo.url); renderPhotoEditor();
    }
    sellDialog.close(); view = 'mine'; page = 1; activeCategory = ''; savedOnly = false; el<HTMLInputElement>('search-input').value = ''; renderFilters();
    await loadListings(); el('market').scrollIntoView({ behavior: 'smooth' });
  } catch (error) { message('sell-message', errorMessage(error)); }
  finally { savingListing = false; button.disabled = false; renderPhotoEditor(); }
});
authForm.addEventListener('submit', async event => {
  event.preventDefault(); if (!auth || !authForm.reportValidity()) return;
  const button = el<HTMLButtonElement>('auth-submit'); button.disabled = true;
  const data = new FormData(authForm);
  const email = String(data.get('email')).trim();
  const password = String(data.get('password'));
  message('auth-message', 'Please wait…');
  try {
    if (authMode === 'signup') {
      const { error } = await auth.auth.signUp({ email, password, options: { data: { display_name: String(data.get('display_name')).trim() }, emailRedirectTo: `${window.location.origin}/` } });
      if (error) throw error;
      message('auth-message', 'Check your email for a confirmation link. Once confirmed, you can sign in. If you already have an account, use Sign in or Forgot password.');
    } else if (authMode === 'reset') {
      const { error } = await auth.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/?auth=recovery` });
      if (error) throw error;
      message('auth-message', 'If an account exists for this email, you’ll receive a password reset link.');
    } else if (authMode === 'update') {
      const { error } = await auth.auth.updateUser({ password });
      if (error) throw error;
      authMode = 'signin'; history.replaceState(null, '', '/');
      openAuth(); message('auth-message', 'Your password has been updated.');
    } else {
      const { data: result, error } = await auth.auth.signInWithPassword({ email, password });
      if (error) throw error;
      session = result.session; authDialog.close(); el('account-button').textContent = 'My account'; await loadListings();
    }
  } catch (error) { message('auth-message', errorMessage(error)); }
  finally { button.disabled = false; el<HTMLInputElement>('auth-password').value = ''; }
});
el('sign-out').addEventListener('click', async () => {
  if (!auth) return;
  const { error } = await auth.auth.signOut({ scope: 'local' });
  if (error) { message('auth-message', error.message); return; }
  session = null; saved.clear(); savedOnly = false; inbox.clear(); clearPhotoCache(); view = 'browse'; authDialog.close(); sellDialog.close(); listingDialog.close();
  el('account-button').textContent = 'Sign in'; await loadListings();
});

async function initialise() {
  renderFilters();
  try {
    const config = await api<{ configured: boolean; supabaseUrl: string; publishableKey: string; photosEnabled: boolean; listingDetailsEnabled: boolean }>('/api/config');
    configured = config.configured;
    photosEnabled = config.photosEnabled;
    for (const id of ['club-handedness', 'club-shaft-flex', 'club-loft']) {
      el<HTMLInputElement>(id).disabled = !config.listingDetailsEnabled;
    }
    el('golf-details-status').hidden = config.listingDetailsEnabled;
    if (configured) {
      auth = createClient(config.supabaseUrl, config.publishableKey);
      auth.auth.onAuthStateChange((event, value) => {
        const previousUser = session?.user.id;
        session = value;
        if (previousUser !== value?.user.id) { saved.clear(); savedOnly = false; inbox.clear(); requestNumber++; setTimeout(() => void loadListings(), 0); }
        el('account-button').textContent = value ? 'My account' : 'Sign in';
        // Supabase callbacks must not await another auth method while holding the auth lock.
        if (event === 'PASSWORD_RECOVERY') setTimeout(() => openAuth('update'), 0);
        if (event === 'SIGNED_OUT') {
          clearPhotoCache();
          view = 'browse'; sellDialog.close(); listingDialog.close();
          setTimeout(() => void loadListings(), 0);
        }
      });
      const { data, error } = await auth.auth.getSession();
      if (error) throw error;
      session = data.session;
      if (session && new URLSearchParams(window.location.search).get('auth') === 'recovery') openAuth('update');
      message('connection-status', `Development preview: accounts and listings are connected. ${photosEnabled ? 'Photos are enabled.' : 'Photo uploads are awaiting setup.'} Buying and professional verification are not available yet.`);
    } else {
      view = 'examples';
      message('connection-status', 'Development preview: example listings only. Accounts and saved listings are awaiting setup. No payments are taken.');
    }
    const callbackError = new URLSearchParams(location.hash.slice(1)).get('error_description');
    if (callbackError) { openAuth(); message('auth-message', callbackError); history.replaceState(null, '', '/'); }
    await loadListings();
  } catch (error) { message('connection-status', 'The marketplace could not connect. Please reload or check the local server.'); message('market-message', errorMessage(error)); }
}
void initialise();
