import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackingLink } from '../shared/tracking';

test('a recognised carrier and tracking number become a link to the carrier', () => {
  assert.equal(
    trackingLink('Royal Mail AB123456789GB'),
    'https://www.royalmail.com/track-your-item#/tracking-results/AB123456789GB',
  );
  assert.equal(trackingLink('evri - h01abc0012345678'), 'https://www.evri.com/track/parcel/H01ABC0012345678');
  assert.equal(
    trackingLink('Parcelforce 48 PB123456789GB'),
    'https://www.parcelforce.com/track-trace?trackNumber=PB123456789GB',
  );
  assert.equal(trackingLink('UPS 1Z999AA10123456784'), 'https://www.ups.com/track?tracknum=1Z999AA10123456784');
  // Unknown carriers, a carrier with no number, and words that only look like a carrier get no link.
  for (const entered of ['Bob the courier 12345678', 'Royal Mail', 'Royal Mail tracked signed', 'Groups 12345678'])
    assert.equal(trackingLink(entered), null, entered);
});
