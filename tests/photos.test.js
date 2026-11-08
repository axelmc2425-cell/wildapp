import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeDb } from '../src/core/db-node.js';
import { migrate } from '../src/core/schema.js';
import { dayOf, groupByMonth, onThisDay, suggestTrips } from '../src/modules/photos/timeline.js';
import {
  addPhotos, listPhotos, getPhoto, setCaption, deletePhotoRow, createAlbum, listAlbums, renameAlbum, deleteAlbum,
  setAlbum, photosSearch,
} from '../src/modules/photos/repo.js';

async function fresh() {
  const db = await openNodeDb(join(mkdtempSync(join(tmpdir(), 'mybrain-')), 't.db'));
  await migrate(db);
  return db;
}

const t = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const photo = (id, taken, extra = {}) => ({ id, taken, album_id: null, caption: '', file: `photos/${id}.jpg`, ...extra });

test('dayOf is the local calendar day', () => {
  assert.equal(dayOf(t(2026, 1, 5, 23)), '2026-01-05');
});

test('groupByMonth groups newest month first, newest photo first, with a readable label', () => {
  const groups = groupByMonth([photo(1, t(2026, 5, 3)), photo(2, t(2026, 6, 1)), photo(3, t(2026, 6, 20)), photo(4, t(2025, 12, 31))]);
  assert.deepEqual(groups.map(g => g.key), ['2026-06', '2026-05', '2025-12']);
  assert.equal(groups[0].label, 'June 2026');
  assert.deepEqual(groups[0].photos.map(p => p.id), [3, 2]);
});

test('onThisDay returns earlier years with the same month and day, grouped by years ago', () => {
  const list = [photo(1, t(2025, 6, 10)), photo(2, t(2024, 6, 10)), photo(3, t(2026, 6, 10)), photo(4, t(2025, 6, 11)), photo(5, t(2025, 6, 10, 18))];
  const out = onThisDay(list, t(2026, 6, 10, 9));
  assert.deepEqual(out.map(g => [g.yearsAgo, g.photos.map(p => p.id).sort()]), [[1, [1, 5]], [2, [2]]]);
  assert.deepEqual(onThisDay([], t(2026, 6, 10)), []);
});

test('suggestTrips finds a burst of photos over several days and names it by its dates', () => {
  const list = [photo(1, t(2026, 6, 10)), photo(2, t(2026, 6, 10, 15)), photo(3, t(2026, 6, 11)), photo(4, t(2026, 6, 12)), photo(5, t(2026, 6, 12, 18)), photo(6, t(2026, 6, 13)),
    photo(7, t(2026, 7, 20)), photo(8, t(2026, 7, 20, 13))];
  const trips = suggestTrips(list);
  assert.equal(trips.length, 1);
  assert.equal(trips[0].name, 'Jun 10–13, 2026');
  assert.deepEqual(trips[0].photoIds.sort(), [1, 2, 3, 4, 5, 6]);
});

test('a gap of 3 or more days starts a new cluster; small clusters are not trips', () => {
  const days = [1, 2, 3, 6, 7, 8, 9, 10, 11];
  const trips = suggestTrips(days.flatMap((d, i) => [photo(i * 2, t(2026, 3, d)), photo(i * 2 + 1, t(2026, 3, d, 16))]), { minPhotos: 5 });
  assert.equal(trips.length, 2);
  assert.deepEqual(trips.map(x => x.name), ['Mar 6–11, 2026', 'Mar 1–3, 2026']);
});

test('photos already in an album and everyday daily photos over many weeks are not suggested', () => {
  const inAlbum = Array.from({ length: 6 }, (_, i) => photo(i, t(2026, 6, 10 + (i % 3)), { album_id: 4 }));
  assert.deepEqual(suggestTrips(inAlbum), []);
  const daily = Array.from({ length: 40 }, (_, i) => photo(i, t(2026, 1, 1 + i)));
  assert.deepEqual(suggestTrips(daily), []);
});

test('trip names cross months and years sensibly', () => {
  const a = suggestTrips(Array.from({ length: 6 }, (_, i) => photo(i, t(2026, 6, 28) + i * 86400000)));
  assert.equal(a[0].name, 'Jun 28 – Jul 3, 2026');
  const names = suggestTrips(Array.from({ length: 6 }, (_, i) => photo(i, t(2025, 12, 30) + i * 86400000 * 1)));
  assert.equal(names[0].name, 'Dec 30, 2025 – Jan 4, 2026');
});

const imp = (file, taken_ms) => ({ file, taken_ms, original: file.split('/').pop() });

test('photos: add (duplicates ignored), list newest first, caption, delete', async () => {
  const db = await fresh();
  assert.equal(await addPhotos(db, [imp('photos/a.jpg', 1000), imp('photos/b.jpg', 3000)], 5), 2);
  assert.equal(await addPhotos(db, [imp('photos/a.jpg', 1000), imp('photos/c.jpg', 2000)], 6), 1);
  const list = await listPhotos(db);
  assert.deepEqual(list.map(p => p.file), ['photos/b.jpg', 'photos/c.jpg', 'photos/a.jpg']);
  await setCaption(db, list[0].id, 'Sunset');
  assert.equal((await getPhoto(db, list[0].id)).caption, 'Sunset');
  assert.equal(await deletePhotoRow(db, list[0].id), 'photos/b.jpg');
  assert.equal(await getPhoto(db, list[0].id), null);
  assert.equal(await deletePhotoRow(db, 999), null);
});

test('albums: create, assign photos, count and cover, rename, delete keeps the photos', async () => {
  const db = await fresh();
  await addPhotos(db, [imp('photos/a.jpg', 1000), imp('photos/b.jpg', 3000), imp('photos/c.jpg', 2000)], 1);
  const [p1, p2, p3] = (await listPhotos(db)).map(p => p.id);
  const trip = await createAlbum(db, 'Lisbon');
  await setAlbum(db, [p1, p2], trip.id);
  const [album] = await listAlbums(db);
  assert.equal(album.count, 2);
  assert.equal(album.cover, 'photos/b.jpg');
  assert.deepEqual((await listPhotos(db, { albumId: trip.id })).map(p => p.id), [p1, p2]);
  assert.equal((await listPhotos(db)).length, 3);
  await renameAlbum(db, trip.id, 'Lisbon 2026');
  assert.equal((await listAlbums(db))[0].name, 'Lisbon 2026');
  await deleteAlbum(db, trip.id);
  assert.equal((await listPhotos(db)).filter(p => p.album_id !== null).length, 0);
  await assert.rejects(createAlbum(db, '  '), /name/);
  void p3;
});

test('photosSearch finds by caption, album name and month', async () => {
  const db = await fresh();
  await addPhotos(db, [imp('photos/a.jpg', new Date(2026, 5, 10, 12).getTime()), imp('photos/b.jpg', new Date(2025, 0, 2, 12).getTime())], 1);
  const [a, b] = await listPhotos(db);
  await setCaption(db, a.id, 'Beach day');
  const album = await createAlbum(db, 'Summer trip');
  await setAlbum(db, [b.id], album.id);
  assert.equal((await photosSearch(db, 'beach'))[0].id, a.id);
  assert.equal((await photosSearch(db, 'SUMMER'))[0].id, b.id);
  assert.equal((await photosSearch(db, '2026-06'))[0].id, a.id);
  assert.deepEqual(await photosSearch(db, 'zzz'), []);
});
