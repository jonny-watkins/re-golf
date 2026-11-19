// Sellers type the carrier and tracking number as one line ("Royal Mail AB123456789GB").
// When the carrier is one we recognise, the number becomes a link to that carrier's tracking page.

const carriers: [RegExp, (reference: string) => string][] = [
  [/royal\s*mail/i, ref => `https://www.royalmail.com/track-your-item#/tracking-results/${ref}`],
  [/parcel\s*force/i, ref => `https://www.parcelforce.com/track-trace?trackNumber=${ref}`],
  [/evri|hermes/i, ref => `https://www.evri.com/track/parcel/${ref}`],
  [/\bups\b/i, ref => `https://www.ups.com/track?tracknum=${ref}`],
];

/** The carrier's tracking page for what the seller entered, or null when it is not recognised. */
export function trackingLink(entered: string): string | null {
  const carrier = carriers.find(([name]) => name.test(entered));
  if (!carrier) return null;
  // The reference is the longest run of letters and digits that contains a digit.
  const reference = (entered.match(/[A-Za-z0-9]{8,40}/g) || [])
    .filter(part => /\d/.test(part))
    .sort((a, b) => b.length - a.length)[0];
  return reference ? carrier[1](encodeURIComponent(reference.toUpperCase())) : null;
}
