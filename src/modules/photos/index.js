import { registerModule } from '../../shell/modules.js';
import { h } from '../../ui/dom.js';
import { hasNative, invoke } from '../../shell/native.js';
import { once } from '../../ui/dom.js';
import { groupByMonth, onThisDay, suggestTrips, dayOf } from './timeline.js';
import {
  addPhotos, listPhotos, getPhoto, setCaption, deletePhotoRow, createAlbum, listAlbums, renameAlbum, deleteAlbum, setAlbum, photosSearch,
} from './repo.js';

const EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'];
let dataDir = null;

async function srcFor(file) {
  if (!dataDir) dataDir = String(await invoke('data_dir')).replace(/\\/g, '/');
  return window.__TAURI__.core.convertFileSrc(`${dataDir}/attachments/${file}`);
}

async function render(root, ctx) {
  const db = ctx.db;
  const native = hasNative();
  const state = { tab: 'timeline', albumId: null, photos: [], albums: [], msg: '', lightbox: null };
  const main = h('div', {});
  const overlay = h('div', { class: 'overlay', hidden: true });
  const tabs = h('div', { class: 'sb-tabs' });
  let keyHandler = null;
  let alive = true;

  async function load() {
    state.photos = await listPhotos(db);
    state.albums = await listAlbums(db);
  }

  async function thumb(p, list) {
    const img = h('img', { loading: 'lazy', decoding: 'async', alt: p.caption || 'Photo', title: p.caption || dayOf(p.taken) });
    srcFor(p.file).then(u => { img.src = u; }).catch(() => {});
    return h('div', { class: 'pcell', onclick: () => openLightbox(list, p.id) }, img);
  }

  async function grid(list) {
    const cells = await Promise.all(list.map(p => thumb(p, list)));
    return h('div', { class: 'pgrid' }, ...cells);
  }

  async function importPhotos() {
    try {
      const picked = await window.__TAURI__.dialog.open({ multiple: true, title: 'Choose photos', filters: [{ name: 'Images', extensions: EXT }] });
      if (!picked || !picked.length) return;
      const r = await invoke('photo_import', { sources: Array.isArray(picked) ? picked : [picked] });
      const added = await addPhotos(db, r.imported);
      const skipped = r.skipped.map(s => `${s.path} (${s.reason})`);
      state.msg = `Added ${added} ${added === 1 ? 'photo' : 'photos'}.` + (skipped.length ? ` Skipped ${skipped.length}: ${skipped.slice(0, 4).join(', ')}${skipped.length > 4 ? ', …' : ''}` : '');
      await load();
      await paint();
    } catch (e) {
      state.msg = 'Import stopped: ' + (e && e.message ? e.message : e);
      await paint();
    }
  }

  function paintTabs() {
    tabs.innerHTML = '';
    for (const [id, label] of [['timeline', 'Timeline'], ['albums', 'Albums'], ['today', 'On this day']]) {
      tabs.append(h('button', { class: 'tab' + (state.tab === id ? ' on' : ''), onclick: () => { state.tab = id; state.albumId = null; paint(); } }, label));
    }
  }

  async function timelineView() {
    if (!state.photos.length) return h('p', { class: 'muted' }, native ? 'No photos yet. Use “Import photos” to copy some in. They stay on this computer.' : 'Importing photos needs the desktop app.');
    const groups = groupByMonth(state.photos);
    const parts = [];
    for (const g of groups) parts.push(h('h3', { style: 'margin:14px 0 6px' }, `${g.label} `, h('span', { class: 'muted' }, `· ${g.photos.length}`)), await grid(g.photos));
    return h('div', {}, ...parts);
  }

  async function todayView() {
    const groups = onThisDay(state.photos, Date.now());
    if (!groups.length) return h('p', { class: 'muted' }, 'No photos from this day in earlier years yet.');
    const parts = [];
    for (const g of groups) parts.push(h('h3', { style: 'margin:14px 0 6px' }, g.yearsAgo === 1 ? '1 year ago' : `${g.yearsAgo} years ago`), await grid(g.photos));
    return h('div', {}, ...parts);
  }

  async function albumsView() {
    if (state.albumId) {
      const album = state.albums.find(a => a.id === state.albumId);
      if (!album) { state.albumId = null; return albumsView(); }
      const list = state.photos.filter(p => p.album_id === album.id);
      const name = h('input', { type: 'text', value: album.name, style: 'font-size:18px;font-weight:600', 'aria-label': 'Album name' });
      name.addEventListener('change', async () => { try { await renameAlbum(db, album.id, name.value); await load(); } catch { name.value = album.name; } });
      return h('div', {}, h('div', { class: 'row' }, h('button', { onclick: () => { state.albumId = null; paint(); } }, '← Albums'), name,
        h('button', { class: 'danger', onclick: async () => { if (window.confirm(`Delete the album "${album.name}"? The photos stay in your timeline.`)) { await deleteAlbum(db, album.id); state.albumId = null; await load(); await paint(); } } }, 'Delete album')),
        list.length ? await grid(list) : h('p', { class: 'muted' }, 'This album is empty. Open a photo and choose an album for it.'));
    }
    const trips = suggestTrips(state.photos);
    const nameIn = h('input', { type: 'text', placeholder: 'New album name', 'aria-label': 'New album name', style: 'flex:1' });
    const add = async () => { try { const a = await createAlbum(db, nameIn.value); await load(); state.albumId = a.id; await paint(); } catch { nameIn.focus(); } };
    const cards = [];
    for (const a of state.albums) {
      const img = h('img', { alt: a.name, loading: 'lazy' });
      if (a.cover) srcFor(a.cover).then(u => { img.src = u; }).catch(() => {});
      cards.push(h('div', { class: 'acard', onclick: () => { state.albumId = a.id; paint(); } }, a.cover ? img : h('div', { class: 'noimg' }, '🖼️'), h('b', {}, a.name), h('span', { class: 'muted' }, `${a.count} photos`)));
    }
    return h('div', {},
      trips.length ? h('div', { class: 'card' }, h('h3', {}, '✨ Looks like trips'),
        h('ul', { class: 'list' }, ...trips.map(t => h('li', {}, h('span', { class: 'grow' }, `${t.name} · ${t.photoIds.length} photos`),
          h('button', { onclick: once(async () => { const a = await createAlbum(db, t.name); await setAlbum(db, t.photoIds, a.id); await load(); state.albumId = a.id; await paint(); }) }, 'Make album'))))) : null,
      h('div', { class: 'row', style: 'margin:12px 0' }, nameIn, h('button', { class: 'primary', onclick: add }, 'Create album')),
      cards.length ? h('div', { class: 'agrid' }, ...cards) : h('p', { class: 'muted' }, 'No albums yet.'));
  }

  // ---- lightbox
  async function openLightbox(list, id) {
    state.lightbox = { list, i: Math.max(0, list.findIndex(p => p.id === id)) };
    await paintLightbox();
    keyHandler = (e) => {
      if (!state.lightbox) return;
      if (e.key === 'Escape') { closeLightbox(); return; }
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return; // arrows move the text cursor / options there
      if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
    };
    window.addEventListener('keydown', keyHandler);
  }

  function closeLightbox() {
    state.lightbox = null;
    overlay.hidden = true;
    if (keyHandler) window.removeEventListener('keydown', keyHandler);
    keyHandler = null;
    load().then(paint);
  }

  async function step(d) {
    const lb = state.lightbox;
    lb.i = (lb.i + d + lb.list.length) % lb.list.length;
    await paintLightbox();
  }

  async function paintLightbox() {
    const lb = state.lightbox;
    const p = await getPhoto(db, lb.list[lb.i].id);
    if (!p) { closeLightbox(); return; }
    const caption = h('input', { type: 'text', value: p.caption, placeholder: 'Add a caption', 'aria-label': 'Caption', style: 'flex:1' });
    caption.addEventListener('change', () => setCaption(db, p.id, caption.value));
    const albumSel = h('select', { 'aria-label': 'Album' }, h('option', { value: '' }, '(no album)'), ...state.albums.map(a => h('option', { value: String(a.id) }, a.name)));
    albumSel.value = p.album_id == null ? '' : String(p.album_id);
    albumSel.addEventListener('change', () => setAlbum(db, [p.id], albumSel.value ? Number(albumSel.value) : null));
    const img = h('img', { class: 'big', alt: p.caption || 'Photo' });
    srcFor(p.file).then(u => { img.src = u; });
    overlay.hidden = false;
    overlay.innerHTML = '';
    overlay.append(h('div', { class: 'card lightbox' },
      h('div', { class: 'row' }, h('span', { class: 'muted', style: 'flex:1' }, `${dayOf(p.taken)} · ${lb.i + 1} / ${lb.list.length}`),
        h('button', { onclick: () => step(-1), 'aria-label': 'Previous' }, '←'), h('button', { onclick: () => step(1), 'aria-label': 'Next' }, '→'),
        h('button', { onclick: closeLightbox }, 'Close (Esc)')),
      img,
      h('div', { class: 'row', style: 'margin-top:8px' }, caption, albumSel,
        h('button', { class: 'danger', onclick: async () => {
          if (!window.confirm('Delete this photo from MyBrain? The copy in the vault is removed (your original stays where it was).')) return;
          const file = await deletePhotoRow(db, p.id);
          try { if (file) await invoke('photo_delete', { file }); } catch { /* row is gone; a leftover file is harmless */ }
          lb.list.splice(lb.i, 1);
          if (!lb.list.length) closeLightbox(); else { lb.i = Math.min(lb.i, lb.list.length - 1); await paintLightbox(); }
        } }, 'Delete'))));
  }

  async function paint() {
    if (!alive) return;
    paintTabs();
    main.innerHTML = '';
    if (state.msg) main.append(h('div', { class: 'banner' }, state.msg));
    main.append(state.tab === 'albums' ? await albumsView() : state.tab === 'today' ? await todayView() : await timelineView());
  }

  await load();
  const wanted = Number(ctx.route()[0]);
  root.innerHTML = '';
  root.append(h('div', { class: 'mod' },
    h('div', { class: 'row' }, h('h2', { style: 'flex:1' }, '🖼️ Photo Vault'), native ? h('button', { class: 'primary', onclick: importPhotos }, '＋ Import photos') : null),
    h('p', { class: 'sub' }, 'Your photos are copied into MyBrain’s own folder on this computer. Nothing is uploaded.'),
    tabs, main), overlay);
  await paint();
  if (wanted && state.photos.some(p => p.id === wanted)) await openLightbox(state.photos, wanted);
  return () => { alive = false; if (keyHandler) window.removeEventListener('keydown', keyHandler); };
}

registerModule({ id: 'photos', name: 'Photo Vault', icon: '🖼️', ready: true, searchProvider: photosSearch, render });
